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

export type WorkflowEventPayload =
  | WorkflowStartedEvent
  | ActivityScheduledEvent
  | ActivityCompletedEvent
  | ActivityFailedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent;

/**
 * An event as stored: `seq` is assigned by the event store at append
 * time, not by whoever constructs the payload. An `ActivityScheduled`
 * event's own `seq` is what `scheduledEventSeq` on later events refers
 * back to — no separate activity ID exists.
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

export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface WorkflowState {
  status: WorkflowStatus;
  workflowType?: string;
  input?: unknown;
  /** Keyed by the scheduling ActivityScheduled event's seq. */
  activities: Record<number, ActivityState>;
  result?: unknown;
  error?: string;
}

export const initialState: WorkflowState = {
  status: 'RUNNING',
  activities: {},
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
