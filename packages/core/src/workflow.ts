/**
 * The pure workflow state machine. No IO, no clock, no randomness — the
 * whole point is that this produces the same state from the same events
 * no matter who calls it or when (see docs/02-event-store.md).
 */

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
  | WorkflowCanceledEvent;

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

export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED';

export interface WorkflowState {
  status: WorkflowStatus;
  workflowType?: string;
  input?: unknown;
  /** Keyed by the scheduling ActivityScheduled event's seq. */
  activities: Record<number, ActivityState>;
  /** Keyed by the scheduling TimerScheduled event's seq. */
  timers: Record<number, TimerState>;
  /** Payloads received so far, per signal name, in arrival order. */
  signals: Record<string, unknown[]>;
  result?: unknown;
  error?: string;
}

export const initialState: WorkflowState = {
  status: 'RUNNING',
  activities: {},
  timers: {},
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
