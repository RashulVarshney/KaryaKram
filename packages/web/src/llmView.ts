import type { StoredWorkflowEvent, WorkflowEventPayload } from '@karyakram/core';

/** Pure view-model helpers for the debugger, kept free of React so they are unit-testable. */

export interface DagStep {
  seq: number;
  kind: 'activity' | 'timer' | 'llm' | 'tool';
  label: string;
}

export function toDagStep(e: StoredWorkflowEvent): DagStep | null {
  switch (e.event.type) {
    case 'ActivityScheduled':
      return { seq: e.seq, kind: 'activity', label: e.event.activityType };
    case 'TimerScheduled':
      return { seq: e.seq, kind: 'timer', label: `timer (fires ${e.event.fireAt})` };
    case 'LLM_REQUESTED':
      return { seq: e.seq, kind: 'llm', label: `LLM ${e.event.stepId}` };
    case 'TOOL_REQUESTED':
      return { seq: e.seq, kind: 'tool', label: `tool ${e.event.tool} (${e.event.stepId})` };
    default:
      return null;
  }
}

/**
 * Events that exist only because workflow code was run (replayed) from
 * the top: running it is what produces a new command. Reaching one of
 * these means every earlier completed step was passed over by that run
 * and its recorded output was reused instead of calling a provider/tool.
 */
const DECISION_TYPES = new Set<WorkflowEventPayload['type']>([
  'ActivityScheduled',
  'TimerScheduled',
  'LLM_REQUESTED',
  'TOOL_REQUESTED',
  'WorkflowCompleted',
  'WorkflowFailed',
]);

/**
 * seqs of LLM_COMPLETED / TOOL_COMPLETED events whose recorded output was
 * reused by a later replay. The most recent completion is NOT replayed
 * yet if nothing has been decided after it.
 */
export function replayedStepSeqs(events: StoredWorkflowEvent[]): Set<number> {
  const lastDecisionSeq = events.reduce(
    (max, e) => (DECISION_TYPES.has(e.event.type) ? Math.max(max, e.seq) : max),
    0,
  );
  const out = new Set<number>();
  for (const e of events) {
    if (
      (e.event.type === 'LLM_COMPLETED' || e.event.type === 'TOOL_COMPLETED') &&
      e.seq < lastDecisionSeq
    ) {
      out.add(e.seq);
    }
  }
  return out;
}

export interface StepDetail {
  title: string;
  badges: string[];
  rows: [string, string][];
  /** Collapsible long text blocks, e.g. the prompt or the response. */
  blocks: { label: string; text: string }[];
}

const json = (v: unknown): string => JSON.stringify(v, null, 2) ?? 'null';

/**
 * What the debugger shows for an llm/tool event. Returns null for any
 * other event type. `replayed` = this completion was reused by a later replay.
 */
export function describeStepEvent(e: StoredWorkflowEvent, replayed: boolean): StepDetail | null {
  const ev = e.event;
  switch (ev.type) {
    case 'LLM_REQUESTED': {
      const prompt = ev.request
        ? ev.request.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n')
        : '(prompt not stored — hash only)';
      return {
        title: `LLM request ${ev.stepId}`,
        badges: ev.requestStorage === 'full' ? [] : [ev.requestStorage],
        rows: [
          ['model', ev.request?.model ?? '(not stored)'],
          ['request hash', ev.requestHash.slice(0, 12)],
          ['storage', ev.requestStorage],
          ['max attempts', String(ev.maxAttempts)],
        ],
        blocks: [{ label: 'prompt', text: prompt }],
      };
    }
    case 'LLM_COMPLETED':
      return {
        title: `LLM response ${ev.stepId}`,
        badges: [...(replayed ? ['replayed'] : []), ...(ev.truncated ? ['truncated'] : [])],
        rows: [
          ['model', ev.model],
          ['tokens in / out', `${String(ev.tokensIn)} / ${String(ev.tokensOut)}`],
          ['latency', `${String(ev.latencyMs)} ms`],
          [
            'est. cost',
            ev.estimatedCostUsd === null ? 'unknown price' : `$${ev.estimatedCostUsd.toFixed(6)}`,
          ],
          ['attempt', String(ev.attempt)],
        ],
        blocks: [
          { label: 'response', text: ev.text },
          ...(ev.toolCalls.length > 0 ? [{ label: 'tool calls', text: json(ev.toolCalls) }] : []),
        ],
      };
    case 'LLM_FAILED':
      return {
        title: `LLM failed ${ev.stepId}`,
        badges: [ev.retryable ? 'retryable' : 'non-retryable'],
        rows: [
          ['code', ev.code],
          ['attempts', String(ev.attempts)],
        ],
        blocks: [{ label: 'error', text: ev.error }],
      };
    case 'TOOL_REQUESTED':
      return {
        title: `Tool request ${ev.stepId}`,
        badges: [],
        rows: [
          ['tool', ev.tool],
          ['args hash', ev.argsHash.slice(0, 12)],
          ['max attempts', String(ev.maxAttempts)],
        ],
        blocks: [{ label: 'arguments', text: json(ev.args) }],
      };
    case 'TOOL_COMPLETED':
      return {
        title: `Tool result ${ev.stepId}`,
        badges: replayed ? ['replayed'] : [],
        rows: [
          ['tool', ev.tool],
          ['latency', `${String(ev.latencyMs)} ms`],
          ['attempt', String(ev.attempt)],
        ],
        blocks: [{ label: 'result', text: json(ev.result) }],
      };
    case 'TOOL_FAILED':
      return {
        title: `Tool failed ${ev.stepId}`,
        badges: [ev.retryable ? 'retryable' : 'non-retryable'],
        rows: [
          ['tool', ev.tool],
          ['code', ev.code],
          ['attempts', String(ev.attempts)],
        ],
        blocks: [{ label: 'error', text: ev.error }],
      };
    default:
      return null;
  }
}
