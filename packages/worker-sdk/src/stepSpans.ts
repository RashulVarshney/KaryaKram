import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { StoredWorkflowEvent } from '@karyakram/core';

const tracer = () => trace.getTracer('karyakram.steps');

/**
 * Runs `fn` inside a `llm_call` / `tool_call` span. Spans are always
 * created through the global tracer at call time, so with no OTel
 * provider registered they are free no-ops.
 */
export async function withStepSpan<T>(
  name: 'llm_call' | 'tool_call',
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Attributes for a completed LLM step, taken from its recorded event. */
export function llmCompletedAttributes(e: {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  estimatedCostUsd: number | null;
  attempt: number;
}): Attributes {
  return {
    'llm.model': e.model,
    'llm.tokens_in': e.tokensIn,
    'llm.tokens_out': e.tokensOut,
    'llm.latency_ms': e.latencyMs,
    ...(e.estimatedCostUsd !== null ? { 'llm.cost_usd': e.estimatedCostUsd } : {}),
    attempt: e.attempt,
  };
}

/**
 * A step whose output was served from the event log rather than from a
 * live provider/tool call gets a short span with `replayed = true`, so a
 * trace shows both the one live execution and every time its recorded
 * result was reused.
 */
export function recordReplayedSteps(history: StoredWorkflowEvent[], workflowId: string): void {
  for (const { event } of history) {
    if (event.type === 'LLM_COMPLETED') {
      const span = tracer().startSpan('llm_call', {
        attributes: {
          ...llmCompletedAttributes(event),
          replayed: true,
          'step.id': event.stepId,
          'workflow.id': workflowId,
        },
      });
      span.end();
    } else if (event.type === 'TOOL_COMPLETED') {
      const span = tracer().startSpan('tool_call', {
        attributes: {
          'tool.name': event.tool,
          'tool.latency_ms': event.latencyMs,
          attempt: event.attempt,
          replayed: true,
          'step.id': event.stepId,
          'workflow.id': workflowId,
        },
      });
      span.end();
    }
  }
}
