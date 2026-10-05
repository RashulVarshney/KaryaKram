import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import type { ToolCompletedEvent, ToolFailedEvent, ToolRequestedEvent } from '@karyakram/core';
import {
  appendEvents,
  claimToolExecution,
  completeToolExecution,
  getEvents,
  isLeaseOwned,
  type Task,
} from '@karyakram/db';
import { hashToolCall } from '@karyakram/llm';
import {
  assertLeaseOwned,
  appendStepOutcome,
  fenceOf,
  hasStepOutcome,
  LeaseLostError,
} from './fencing';
import { maybeFault } from './faults';
import { recordReplayedSteps, withStepSpan } from './stepSpans';
import { ToolError, type ToolRegistry } from './tools';
import type { TaskHandler } from './worker';

const OUTCOME_TYPES = ['TOOL_COMPLETED', 'TOOL_FAILED'];

export interface ToolCallHandlerOptions {
  registry: ToolRegistry;
  logger?: Logger;
}

/**
 * A `TaskHandler` for `tool`-type tasks.
 *
 * Exactly-once side effects come from doing four things in ONE database
 * transaction: claim the (workflow_id, step_id) ledger row, run the tool
 * through the transaction's connection, record its result, and append
 * `TOOL_COMPLETED` after re-checking (and row-locking) the lease. Commit
 * makes all of it real; a `kill -9` anywhere before commit makes none of
 * it real, so the retry starts clean and the effect lands exactly once.
 * A concurrent duplicate blocks on the claim and then returns the stored
 * result.
 *
 * Unknown tools and invalid arguments fail the step WITHOUT running the
 * handler.
 */
export function createToolCallHandler(pool: Pool, options: ToolCallHandlerOptions): TaskHandler {
  const { registry } = options;
  const logger = options.logger ?? pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

  return async (task: Task) => {
    if (task.scheduledEventSeq === null) {
      throw new Error(`tool task ${task.id} has no scheduled_event_seq`);
    }
    const scheduledSeq = Number(task.scheduledEventSeq);

    const history = await getEvents(pool, task.workflowId);
    const entry = history.find((e) => e.seq === scheduledSeq);
    if (!entry || entry.event.type !== 'TOOL_REQUESTED') {
      throw new Error(`no TOOL_REQUESTED event at seq ${scheduledSeq} for task ${task.id}`);
    }
    const requested: ToolRequestedEvent = entry.event;

    const outcome = history.find(
      (e) =>
        (e.event.type === 'TOOL_COMPLETED' || e.event.type === 'TOOL_FAILED') &&
        e.event.scheduledEventSeq === scheduledSeq,
    );
    if (outcome) {
      recordReplayedSteps([outcome], task.workflowId);
      return;
    }

    const failed = (error: string, code: string, retryable: boolean): ToolFailedEvent => ({
      type: 'TOOL_FAILED',
      stepId: requested.stepId,
      scheduledEventSeq: scheduledSeq,
      tool: requested.tool,
      error,
      code,
      retryable,
      attempts: task.attempt,
    });

    // Gate: only registered tools with valid arguments may run.
    const validation = registry.validate(requested.tool, requested.args);
    if (!validation.ok) {
      await appendStepOutcome(
        pool,
        task,
        scheduledSeq,
        failed(validation.message, validation.code, false),
        OUTCOME_TYPES,
      );
      return;
    }
    if (hashToolCall(requested.tool, requested.args) !== requested.argsHash) {
      await appendStepOutcome(
        pool,
        task,
        scheduledSeq,
        failed('stored arguments do not match their recorded hash', 'args_hash_mismatch', false),
        OUTCOME_TYPES,
      );
      return;
    }
    const tool = registry.get(requested.tool);
    if (!tool) throw new Error(`tool "${requested.tool}" vanished from the registry`);

    try {
      await withStepSpan(
        'tool_call',
        {
          'tool.name': requested.tool,
          'step.id': requested.stepId,
          'workflow.id': task.workflowId,
          replayed: false,
          attempt: task.attempt,
        },
        () => executeAtomically(pool, task, requested, scheduledSeq, tool.handler),
      );
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      const toolError =
        err instanceof ToolError
          ? err
          : new ToolError(err instanceof Error ? err.message : String(err), {
              retryable: false,
              code: 'tool_error',
            });
      const exhausted = task.attempt >= task.maxAttempts;
      logger.warn(
        { taskId: task.id, stepId: requested.stepId, attempt: task.attempt, code: toolError.code },
        'tool call failed',
      );
      if (toolError.retryable && !exhausted) throw toolError;
      await appendStepOutcome(
        pool,
        task,
        scheduledSeq,
        failed(toolError.message, toolError.code, toolError.retryable),
        OUTCOME_TYPES,
      );
      if (toolError.retryable) throw toolError;
      return;
    }
    maybeFault('after_persist');
  };
}

async function executeAtomically(
  pool: Pool,
  task: Task,
  requested: ToolRequestedEvent,
  scheduledSeq: number,
  handler: (
    args: never,
    ctx: {
      client: import('pg').PoolClient;
      workflowId: string;
      stepId: string;
      idempotencyKey: string;
    },
  ) => Promise<unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cheap early exit without a lock (a row lock held for the whole tool
    // run would block this worker's own lease heartbeats). The locking
    // check that actually fences the write comes right before the events.
    if (!(await isLeaseOwned(client, fenceOf(task), { lock: false }))) {
      throw new LeaseLostError(task.id);
    }

    const claim = await claimToolExecution(client, {
      workflowId: task.workflowId,
      stepId: requested.stepId,
      tool: requested.tool,
      argsHash: requested.argsHash,
    });

    let result: unknown;
    let latencyMs = 0;
    if (claim.claimed) {
      const started = Date.now();
      result = await handler(requested.args as never, {
        client,
        workflowId: task.workflowId,
        stepId: requested.stepId,
        idempotencyKey: `${task.workflowId}:${requested.stepId}`,
      });
      latencyMs = Date.now() - started;
      await completeToolExecution(client, task.workflowId, requested.stepId, result);
    } else {
      // Already executed and committed by someone else: reuse the stored result.
      result = claim.result;
    }

    await assertLeaseOwned(client, task); // locks the task row until commit
    if (!(await hasStepOutcome(client, task.workflowId, scheduledSeq, OUTCOME_TYPES))) {
      const completed: ToolCompletedEvent = {
        type: 'TOOL_COMPLETED',
        stepId: requested.stepId,
        scheduledEventSeq: scheduledSeq,
        tool: requested.tool,
        result: result ?? null,
        latencyMs,
        attempt: task.attempt,
      };
      await appendEvents(client, { workflowId: task.workflowId, events: [completed] });
    }

    // Side effect executed, outcome written, NOT yet committed.
    maybeFault('before_tool_commit');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
