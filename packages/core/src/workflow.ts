/**
 * The pure workflow state machine. No IO, no clock, no randomness — the
 * whole point is that this produces the same state from the same events
 * no matter who calls it or when (see docs/02-event-store.md).
 */

import type { LlmRequest, LlmToolCall } from './llm';

export interface WorkflowStartedEvent {
  type: 'WorkflowStarted';
  workflowType: string;
  input: unknown;
}

export interface ActivityScheduledEvent {
  type: 'ActivityScheduled';
  activityType: string;
  input: unknown;
}

export interface ActivityCompletedEvent {
  type: 'ActivityCompleted';
  /** seq of the ActivityScheduled event this completion belongs to. */
  scheduledEventSeq: number;
  result: unknown;
}

export interface ActivityFailedEvent {
  type: 'ActivityFailed';
  /** seq of the ActivityScheduled event this failure belongs to. */
  scheduledEventSeq: number;
  error: string;
}

export interface WorkflowCompletedEvent {
  type: 'WorkflowCompleted';
  result: unknown;
}

export interface WorkflowFailedEvent {
  type: 'WorkflowFailed';
  error: string;
}

export interface TimerScheduledEvent {
  type: 'TimerScheduled';
  /** ISO timestamp — when this timer should fire. */
  fireAt: string;
}

export interface TimerFiredEvent {
  type: 'TimerFired';
  /** seq of the TimerScheduled event this firing belongs to. */
  scheduledEventSeq: number;
}

export interface SignalReceivedEvent {
  type: 'SignalReceived';
  signalName: string;
  payload: unknown;
}

export interface CancellationRequestedEvent {
  type: 'CancellationRequested';
  reason?: string;
}

export interface WorkflowCanceledEvent {
  type: 'WorkflowCanceled';
  reason?: string;
}

/**
 * How much of the request was persisted in `LLM_REQUESTED`. Only `full`
 * is safe to send to a provider as-is; for the others the executing
 * worker recovers the exact request by re-deriving it from the workflow
 * function (see `replay`'s `pendingLlmRequests`).
 */
export type LlmRequestStorage = 'full' | 'redacted' | 'truncated' | 'none';

export interface LlmRequestedEvent {
  type: 'LLM_REQUESTED';
  /** Deterministic, derived from call position: `llm-0`, `llm-1`, ... */
  stepId: string;
  /** sha256 of the canonical JSON of (model, messages, params, tools). */
  requestHash: string;
  requestStorage: LlmRequestStorage;
  /** Absent when `requestStorage` is `none`. */
  request?: LlmRequest;
  /** Max provider attempts before the task is dead-lettered. */
  maxAttempts: number;
}

export interface LlmCompletedEvent {
  type: 'LLM_COMPLETED';
  stepId: string;
  /** seq of the LLM_REQUESTED event this completion belongs to. */
  scheduledEventSeq: number;
  requestHash: string;
  text: string;
  toolCalls: LlmToolCall[];
  /** True if text/toolCalls were cut to the stored-size cap. */
  truncated: boolean;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** null when the model isn't in the price table. */
  estimatedCostUsd: number | null;
  /** Task attempt that produced this result. */
  attempt: number;
}

export interface LlmFailedEvent {
  type: 'LLM_FAILED';
  stepId: string;
  scheduledEventSeq: number;
  error: string;
  code: string;
  retryable: boolean;
  attempts: number;
}

export type WorkflowEventPayload =
  | WorkflowStartedEvent
  | ActivityScheduledEvent
  | ActivityCompletedEvent
  | ActivityFailedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | TimerScheduledEvent
  | TimerFiredEvent
  | SignalReceivedEvent
  | CancellationRequestedEvent
  | WorkflowCanceledEvent
  | LlmRequestedEvent
  | LlmCompletedEvent
  | LlmFailedEvent;

/**
 * An event as stored: `seq` is assigned by the event store at append
 * time, not by whoever constructs the payload. An `ActivityScheduled`
 * event's own `seq` is what `scheduledEventSeq` on later events refers
 * back to — no separate activity ID exists. Same idea for
 * `TimerScheduled`/`TimerFired`.
 */
export interface StoredWorkflowEvent {
  seq: number;
  event: WorkflowEventPayload;
}

export type ActivityStatus = 'SCHEDULED' | 'COMPLETED' | 'FAILED';

export interface ActivityState {
  activityType: string;
  status: ActivityStatus;
  result?: unknown;
  error?: string;
}

export type TimerStatus = 'SCHEDULED' | 'FIRED';

export interface TimerState {
  fireAt: string;
  status: TimerStatus;
}

export type LlmCallStatus = 'REQUESTED' | 'COMPLETED' | 'FAILED';

export interface LlmCallState {
  stepId: string;
  status: LlmCallStatus;
  requestHash: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  estimatedCostUsd?: number | null;
  text?: string;
  truncated?: boolean;
  error?: string;
}

export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED';

export interface WorkflowState {
  status: WorkflowStatus;
  workflowType?: string;
  input?: unknown;
  /** Keyed by the scheduling ActivityScheduled event's seq. */
  activities: Record<number, ActivityState>;
  /** Keyed by the scheduling TimerScheduled event's seq. */
  timers: Record<number, TimerState>;
  /** Keyed by the LLM_REQUESTED event's seq. */
  llmCalls: Record<number, LlmCallState>;
  /** Payloads received so far, per signal name, in arrival order. */
  signals: Record<string, unknown[]>;
  result?: unknown;
  error?: string;
}

export const initialState: WorkflowState = {
  status: 'RUNNING',
  activities: {},
  timers: {},
  llmCalls: {},
  signals: {},
};

/**
 * The reducer. One case per event type; unknown `scheduledEventSeq`
 * references are ignored rather than thrown on — a fold over a malformed
 * or partial log should degrade gracefully, not crash a debugger or
 * replay worker reading it.
 */
export function applyEvent(state: WorkflowState, stored: StoredWorkflowEvent): WorkflowState {
  const { event } = stored;

  switch (event.type) {
    case 'WorkflowStarted':
      return { ...state, workflowType: event.workflowType, input: event.input };

    case 'ActivityScheduled':
      return {
        ...state,
        activities: {
          ...state.activities,
          [stored.seq]: { activityType: event.activityType, status: 'SCHEDULED' },
        },
      };

    case 'ActivityCompleted': {
      const existing = state.activities[event.scheduledEventSeq];
      if (!existing) return state;
      return {
        ...state,
        activities: {
          ...state.activities,
          [event.scheduledEventSeq]: { ...existing, status: 'COMPLETED', result: event.result },
        },
      };
    }

    case 'ActivityFailed': {
      const existing = state.activities[event.scheduledEventSeq];
      if (!existing) return state;
      return {
        ...state,
        activities: {
          ...state.activities,
          [event.scheduledEventSeq]: { ...existing, status: 'FAILED', error: event.error },
        },
      };
    }

    case 'WorkflowCompleted':
      return { ...state, status: 'COMPLETED', result: event.result };

    case 'WorkflowFailed':
      return { ...state, status: 'FAILED', error: event.error };

    case 'TimerScheduled':
      return {
        ...state,
        timers: {
          ...state.timers,
          [stored.seq]: { fireAt: event.fireAt, status: 'SCHEDULED' },
        },
      };

    case 'TimerFired': {
      const existing = state.timers[event.scheduledEventSeq];
      if (!existing) return state;
      return {
        ...state,
        timers: {
          ...state.timers,
          [event.scheduledEventSeq]: { ...existing, status: 'FIRED' },
        },
      };
    }

    case 'SignalReceived':
      return {
        ...state,
        signals: {
          ...state.signals,
          [event.signalName]: [...(state.signals[event.signalName] ?? []), event.payload],
        },
      };

    case 'CancellationRequested':
      // No state change on its own — the engine reacts to this event by
      // short-circuiting before replay (see docs/04-durability.md); the
      // fold just needs to not lose it, in case a future consumer (M5's
      // debugger) wants to show "cancellation was requested at seq N"
      // even before WorkflowCanceled lands.
      return state;

    case 'WorkflowCanceled':
      return { ...state, status: 'CANCELED', error: event.reason };

    case 'LLM_REQUESTED':
      return {
        ...state,
        llmCalls: {
          ...state.llmCalls,
          [stored.seq]: {
            stepId: event.stepId,
            status: 'REQUESTED',
            requestHash: event.requestHash,
          },
        },
      };

    case 'LLM_COMPLETED': {
      const existing = state.llmCalls[event.scheduledEventSeq];
      if (!existing) return state;
      return {
        ...state,
        llmCalls: {
          ...state.llmCalls,
          [event.scheduledEventSeq]: {
            ...existing,
            status: 'COMPLETED',
            model: event.model,
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
            latencyMs: event.latencyMs,
            estimatedCostUsd: event.estimatedCostUsd,
            text: event.text,
            truncated: event.truncated,
          },
        },
      };
    }

    case 'LLM_FAILED': {
      const existing = state.llmCalls[event.scheduledEventSeq];
      if (!existing) return state;
      return {
        ...state,
        llmCalls: {
          ...state.llmCalls,
          [event.scheduledEventSeq]: { ...existing, status: 'FAILED', error: event.error },
        },
      };
    }

    default: {
      // Exhaustiveness check: a new event variant added without a case
      // above is a compile error here, not a silent no-op at runtime.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function foldEvents(events: StoredWorkflowEvent[]): WorkflowState {
  return events.reduce(applyEvent, initialState);
}
