/**
 * The pure replay engine. No IO, no clock, no randomness — see
 * docs/03-replay.md for why `await Promise.resolve()` microtask draining
 * doesn't violate that: Promise/microtask ordering is fixed by the
 * ECMAScript spec, not the environment, so this produces identical
 * output for identical input every time, on any machine.
 */
import type { ActivityScheduledEvent, StoredWorkflowEvent } from './workflow';

export interface WorkflowContext {
  scheduleActivity<Result = unknown>(activityType: string, input: unknown): Promise<Result>;
}

export type WorkflowFn<Input = unknown, Result = unknown> = (
  input: Input,
  ctx: WorkflowContext,
) => Promise<Result>;

export type WorkflowCommand =
  | { type: 'ScheduleActivity'; activityType: string; input: unknown }
  | { type: 'CompleteWorkflow'; result: unknown }
  | { type: 'FailWorkflow'; error: string };

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

  const outcomeBySeq = new Map<number, ActivityOutcome>();
  for (const { event } of history) {
    if (event.type === 'ActivityCompleted') {
      outcomeBySeq.set(event.scheduledEventSeq, { kind: 'completed', result: event.result });
    } else if (event.type === 'ActivityFailed') {
      outcomeBySeq.set(event.scheduledEventSeq, { kind: 'failed', error: event.error });
    }
  }

  const commands: WorkflowCommand[] = [];
  let callIndex = 0;
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
