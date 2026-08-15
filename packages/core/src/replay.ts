/**
 * The pure replay engine. No IO, no clock, no randomness — see
 * docs/03-replay.md for why `await Promise.resolve()` microtask draining
 * doesn't violate that: Promise/microtask ordering is fixed by the
 * ECMAScript spec, not the environment, so this produces identical
 * output for identical input every time, on any machine.
 */
import type {
  ActivityScheduledEvent,
  SignalReceivedEvent,
  StoredWorkflowEvent,
  TimerScheduledEvent,
} from './workflow';

export interface WorkflowContext {
  scheduleActivity<Result = unknown>(activityType: string, input: unknown): Promise<Result>;
  /**
   * Durable sleep. Takes a *duration*, never an absolute time —
   * `packages/core` can't call `Date.now()`, so the actual `fireAt`
   * timestamp is computed by the impure worker layer the first time this
   * call's `ScheduleTimer` command is turned into a `TimerScheduled`
   * event. Replay never needs to know "now"; it only ever asks "has the
   * Nth timer fired yet."
   */
  sleep(durationMs: number): Promise<void>;
  /**
   * Resolves with the Nth `SignalReceived` payload for `signalName` (N =
   * how many times this workflow has called `waitForSignal` with this
   * same name so far), or hangs if that many haven't arrived yet. Never
   * emits a command — a signal is pushed in from outside independently
   * of what the workflow is doing; there's nothing for the engine to go
   * create. See docs/04-durability.md.
   */
  waitForSignal<Payload = unknown>(signalName: string): Promise<Payload>;
}

export type WorkflowFn<Input = unknown, Result = unknown> = (
  input: Input,
  ctx: WorkflowContext,
) => Promise<Result>;

export type WorkflowCommand =
  | { type: 'ScheduleActivity'; activityType: string; input: unknown }
  | { type: 'CompleteWorkflow'; result: unknown }
  | { type: 'FailWorkflow'; error: string }
  | { type: 'ScheduleTimer'; durationMs: number };

/**
 * Thrown when the currently-running code's Nth `scheduleActivity` call
 * asks for a different `activityType` than history's Nth
 * `ActivityScheduled` event — the deployed code has diverged from this
 * workflow's own history. Deliberately not folded into `status:
 * 'FAILED'`: this is an operational problem with the deployment, not a
 * business-logic failure the workflow's own error handling should see.
 * See docs/03-replay.md.
 */
export class NonDeterminismError extends Error {
  constructor(
    public readonly callIndex: number,
    public readonly expectedActivityType: string,
    public readonly actualActivityType: string,
  ) {
    super(
      `Non-deterministic workflow: history has call ${callIndex} scheduling ` +
        `"${expectedActivityType}", but the running code's call ${callIndex} asked for ` +
        `"${actualActivityType}" instead.`,
    );
    this.name = 'NonDeterminismError';
  }
}

export type ReplayStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ReplayResult {
  status: ReplayStatus;
  result?: unknown;
  error?: string;
  commands: WorkflowCommand[];
}

function isActivityScheduled(
  e: StoredWorkflowEvent,
): e is StoredWorkflowEvent & { event: ActivityScheduledEvent } {
  return e.event.type === 'ActivityScheduled';
}

function isTimerScheduled(
  e: StoredWorkflowEvent,
): e is StoredWorkflowEvent & { event: TimerScheduledEvent } {
  return e.event.type === 'TimerScheduled';
}

function isSignalReceived(
  e: StoredWorkflowEvent,
): e is StoredWorkflowEvent & { event: SignalReceivedEvent } {
  return e.event.type === 'SignalReceived';
}

type ActivityOutcome = { kind: 'completed'; result: unknown } | { kind: 'failed'; error: string };

// Bounded, not unlimited — see docs/03-replay.md. Generous relative to
// any reasonable workflow's history length; ticks spent after execution
// is genuinely stuck (case 3/4 in the design note) are cheap no-ops.
const MAX_DRAIN_TICKS = 1000;

export async function replay<Input = unknown, Result = unknown>(
  workflowFn: WorkflowFn<Input, Result>,
  input: Input,
  history: StoredWorkflowEvent[],
): Promise<ReplayResult> {
  const scheduledEvents = history.filter(isActivityScheduled);
  const timerEvents = history.filter(isTimerScheduled);

  const signalEventsByName = new Map<
    string,
    (StoredWorkflowEvent & { event: SignalReceivedEvent })[]
  >();
  for (const e of history.filter(isSignalReceived)) {
    const arr = signalEventsByName.get(e.event.signalName) ?? [];
    arr.push(e);
    signalEventsByName.set(e.event.signalName, arr);
  }
  const signalCallIndexByName = new Map<string, number>();

  const outcomeBySeq = new Map<number, ActivityOutcome>();
  const firedTimerSeqs = new Set<number>();
  for (const { event } of history) {
    if (event.type === 'ActivityCompleted') {
      outcomeBySeq.set(event.scheduledEventSeq, { kind: 'completed', result: event.result });
    } else if (event.type === 'ActivityFailed') {
      outcomeBySeq.set(event.scheduledEventSeq, { kind: 'failed', error: event.error });
    } else if (event.type === 'TimerFired') {
      firedTimerSeqs.add(event.scheduledEventSeq);
    }
  }

  const commands: WorkflowCommand[] = [];
  let callIndex = 0;
  let timerCallIndex = 0;
  let nonDeterminismError: NonDeterminismError | null = null;

  const ctx: WorkflowContext = {
    scheduleActivity<T>(activityType: string, activityInput: unknown): Promise<T> {
      const index = callIndex++;
      const scheduled = scheduledEvents[index];

      if (scheduled) {
        if (scheduled.event.activityType !== activityType) {
          nonDeterminismError = new NonDeterminismError(
            index,
            scheduled.event.activityType,
            activityType,
          );
          return new Promise<T>(() => {
            /* never resolves — this pass is being aborted via nonDeterminismError */
          });
        }
        const outcome = outcomeBySeq.get(scheduled.seq);
        if (outcome?.kind === 'completed') {
          return Promise.resolve(outcome.result as T);
        }
        if (outcome?.kind === 'failed') {
          return Promise.reject(new Error(outcome.error));
        }
        // Scheduled but no outcome yet — already in flight, nothing new to do this pass.
        return new Promise<T>(() => {
          /* never resolves — waiting on an activity already in flight */
        });
      }

      // A genuinely new decision: not in history at all yet.
      commands.push({ type: 'ScheduleActivity', activityType, input: activityInput });
      return new Promise<T>(() => {
        /* never resolves — this pass ends here; the new command is what matters */
      });
    },

    sleep(durationMs: number): Promise<void> {
      const index = timerCallIndex++;
      const scheduled = timerEvents[index];

      if (scheduled) {
        if (firedTimerSeqs.has(scheduled.seq)) {
          return Promise.resolve();
        }
        // Scheduled but not yet fired — already in flight, nothing new to do this pass.
        return new Promise<void>(() => {
          /* never resolves — waiting on a timer already in flight */
        });
      }

      // A genuinely new timer: not in history at all yet.
      commands.push({ type: 'ScheduleTimer', durationMs });
      return new Promise<void>(() => {
        /* never resolves — this pass ends here; the new command is what matters */
      });
    },

    waitForSignal<P>(signalName: string): Promise<P> {
      const index = signalCallIndexByName.get(signalName) ?? 0;
      signalCallIndexByName.set(signalName, index + 1);

      const matched = signalEventsByName.get(signalName)?.[index];
      if (matched) {
        return Promise.resolve(matched.event.payload as P);
      }

      // No command emitted, ever: nothing for the engine to schedule —
      // see the WorkflowContext doc comment.
      return new Promise<P>(() => {
        /* never resolves — no matching signal has arrived yet */
      });
    },
  };

  type Settled = { kind: 'completed'; result: unknown } | { kind: 'failed'; error: unknown };
  // A property on a mutable box, not a bare `let`: TS's control-flow
  // narrowing over-constrains a `let` that's only ever reassigned inside
  // closures (it ends up inferring `never` after the null-check below),
  // but doesn't apply that same narrowing to object property reads.
  const box: { settled: Settled | null } = { settled: null };

  workflowFn(input, ctx)
    .then((result) => {
      box.settled = { kind: 'completed', result };
    })
    .catch((error: unknown) => {
      box.settled = { kind: 'failed', error };
    });

  for (let i = 0; i < MAX_DRAIN_TICKS && box.settled === null; i++) {
    await Promise.resolve();
  }

  if (nonDeterminismError) {
    throw nonDeterminismError;
  }

  const finalSettled = box.settled;
  if (finalSettled === null) {
    return { status: 'RUNNING', commands };
  }

  if (finalSettled.kind === 'completed') {
    return {
      status: 'COMPLETED',
      result: finalSettled.result,
      commands: [{ type: 'CompleteWorkflow', result: finalSettled.result }],
    };
  }

  const message =
    finalSettled.error instanceof Error ? finalSettled.error.message : String(finalSettled.error);
  return {
    status: 'FAILED',
    error: message,
    commands: [{ type: 'FailWorkflow', error: message }],
  };
}
