import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import {
  replay,
  type LlmCompletedEvent,
  type LlmFailedEvent,
  type LlmRequest,
  type LlmRequestedEvent,
  type StoredWorkflowEvent,
} from '@karyakram/core';
import { getEvents, type Task } from '@karyakram/db';
import {
  estimateCostUsd,
  hashLlmRequest,
  LlmProviderError,
  sha256Hex,
  type LLMProvider,
} from '@karyakram/llm';
import type { AnyWorkflowDefinition } from './authoring';
import { appendStepOutcome } from './fencing';
import { maybeFault } from './faults';
import { capResponse, loadLlmStepConfig, type LlmStepConfig } from './llmConfig';
import type { TaskHandler } from './worker';

const OUTCOME_TYPES = ['LLM_COMPLETED', 'LLM_FAILED'];

export interface LlmCallHandlerOptions {
  provider: LLMProvider;
  /** Needed to recover a request that was stored as a hash only (see `resolveRequest`). */
  workflows: AnyWorkflowDefinition[];
  config?: LlmStepConfig;
  logger?: Logger;
}

type Resolved = { ok: true; request: LlmRequest } | { ok: false; reason: string };

/**
 * Finds the exact request this step must send.
 *
 * If the event holds a `full` (unredacted, untruncated) copy, use it.
 * Otherwise — hash-only, redacted or truncated storage — the stored copy
 * must NOT be sent (it is not what the workflow asked for), so recover
 * the real request by re-running the workflow function against history:
 * replay is deterministic, so it rebuilds the same request, and the
 * hash proves it did.
 */
async function resolveRequest(
  history: StoredWorkflowEvent[],
  requested: LlmRequestedEvent,
  registry: Map<string, AnyWorkflowDefinition>,
): Promise<Resolved> {
  if (requested.requestStorage === 'full' && requested.request) {
    if (hashLlmRequest(requested.request) !== requested.requestHash) {
      return { ok: false, reason: 'stored request does not match its recorded hash' };
    }
    return { ok: true, request: requested.request };
  }

  const started = history.find((e) => e.event.type === 'WorkflowStarted');
  if (!started || started.event.type !== 'WorkflowStarted') {
    return { ok: false, reason: 'workflow has no WorkflowStarted event' };
  }
  const definition = registry.get(started.event.workflowType);
  if (!definition) {
    return { ok: false, reason: `no workflow registered for "${started.event.workflowType}"` };
  }
  let derived: LlmRequest | undefined;
  try {
    const result = await replay(definition.fn, started.event.input, history, { hash: sha256Hex });
    derived = result.pendingLlmRequests?.[requested.stepId];
  } catch (err) {
    return { ok: false, reason: `could not re-derive request: ${(err as Error).message}` };
  }
  if (!derived)
    return { ok: false, reason: `step ${requested.stepId} not found while re-deriving` };
  if (hashLlmRequest(derived) !== requested.requestHash) {
    return { ok: false, reason: 'derived request hash differs from the recorded one' };
  }
  return { ok: true, request: derived };
}

/**
 * A `TaskHandler` for `llm`-type tasks.
 *
 * Order of operations is the whole design:
 *   1. If an outcome is already recorded, return — never call twice for a
 *      step that already has an answer.
 *   2. Call the provider. This is the one step that can't be made
 *      transactional with the database; a crash between 2 and 3 is the
 *      single "unavoidable window" in which a retry re-calls the provider.
 *   3. Persist LLM_COMPLETED in a transaction that first verifies this
 *      worker still holds the lease (fencing). A worker that lost its
 *      lease discards the result.
 *
 * Failure policy: retryable provider errors rethrow, so the existing
 * fail() path re-queues with jittered backoff (honouring `retryAfterMs`)
 * and dead-letters after `maxAttempts`. Non-retryable errors are recorded
 * as LLM_FAILED so the workflow sees them. When retries are exhausted we
 * record LLM_FAILED *and* rethrow, so the workflow can move on while the
 * task still lands in the DLQ for an operator.
 */
export function createLlmCallHandler(pool: Pool, options: LlmCallHandlerOptions): TaskHandler {
  const { provider } = options;
  const config = options.config ?? loadLlmStepConfig();
  const logger = options.logger ?? pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  const registry = new Map(options.workflows.map((w) => [w.workflowType, w]));

  return async (task: Task) => {
    if (task.scheduledEventSeq === null) {
      throw new Error(`llm task ${task.id} has no scheduled_event_seq`);
    }
    const scheduledSeq = Number(task.scheduledEventSeq);

    const history = await getEvents(pool, task.workflowId);
    const entry = history.find((e) => e.seq === scheduledSeq);
    if (!entry || entry.event.type !== 'LLM_REQUESTED') {
      throw new Error(`no LLM_REQUESTED event at seq ${scheduledSeq} for task ${task.id}`);
    }
    const requested = entry.event;

    const alreadyDone = history.some(
      (e) =>
        (e.event.type === 'LLM_COMPLETED' || e.event.type === 'LLM_FAILED') &&
        e.event.scheduledEventSeq === scheduledSeq,
    );
    if (alreadyDone) return;

    const failed = (error: string, code: string, retryable: boolean): LlmFailedEvent => ({
      type: 'LLM_FAILED',
      stepId: requested.stepId,
      scheduledEventSeq: scheduledSeq,
      error,
      code,
      retryable,
      attempts: task.attempt,
    });

    const resolved = await resolveRequest(history, requested, registry);
    if (!resolved.ok) {
      await appendStepOutcome(
        pool,
        task,
        scheduledSeq,
        failed(resolved.reason, 'request_unavailable', false),
        OUTCOME_TYPES,
      );
      return;
    }

    let response;
    try {
      response = await provider.complete(resolved.request, {
        workflowId: task.workflowId,
        stepId: requested.stepId,
        attempt: task.attempt,
      });
    } catch (err) {
      const providerError =
        err instanceof LlmProviderError
          ? err
          : new LlmProviderError(err instanceof Error ? err.message : String(err), {
              retryable: false,
              code: 'unknown',
              cause: err,
            });
      const exhausted = task.attempt >= task.maxAttempts;
      logger.warn(
        {
          taskId: task.id,
          stepId: requested.stepId,
          attempt: task.attempt,
          code: providerError.code,
        },
        'provider call failed',
      );
      // Retryable and attempts remain: the existing retry machinery takes over.
      if (providerError.retryable && !exhausted) throw providerError;

      await appendStepOutcome(
        pool,
        task,
        scheduledSeq,
        failed(providerError.message, providerError.code, providerError.retryable),
        OUTCOME_TYPES,
      );
      // Retries exhausted: let the task dead-letter too, for operator visibility.
      if (providerError.retryable) throw providerError;
      return;
    }

    maybeFault('after_provider_before_persist');

    const capped = capResponse(response.text, response.toolCalls, config.maxStoredBytes);
    const completed: LlmCompletedEvent = {
      type: 'LLM_COMPLETED',
      stepId: requested.stepId,
      scheduledEventSeq: scheduledSeq,
      requestHash: requested.requestHash,
      text: capped.text,
      toolCalls: capped.toolCalls,
      truncated: capped.truncated,
      model: response.model,
      tokensIn: response.usage.inputTokens,
      tokensOut: response.usage.outputTokens,
      latencyMs: response.latencyMs,
      estimatedCostUsd: estimateCostUsd(
        response.model,
        response.usage.inputTokens,
        response.usage.outputTokens,
        config.priceTable,
      ),
      attempt: task.attempt,
    };

    // Throws LeaseLostError (and writes nothing) if this worker no longer owns the task.
    await appendStepOutcome(pool, task, scheduledSeq, completed, OUTCOME_TYPES);
    maybeFault('after_persist');
  };
}
