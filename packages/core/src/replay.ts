/**
 * The pure replay engine. No IO, no clock, no randomness — see
 * docs/03-replay.md for why `await Promise.resolve()` microtask draining
 * doesn't violate that: Promise/microtask ordering is fixed by the
 * ECMAScript spec, not the environment, so this produces identical
 * output for identical input every time, on any machine.
 */
import { canonicalLlmRequest, type LlmCallResult, type LlmRequest } from './llm';
import type {
  ActivityScheduledEvent,
  LlmCompletedEvent,
  LlmFailedEvent,
  LlmRequestedEvent,
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
  /**
   * A durable LLM call. Never calls a provider itself: the first time a
   * given call position is reached it emits a `RequestLlmCall` command
   * (which becomes an `LLM_REQUESTED` event and a task); on every later
   * replay it resolves with the *recorded* outcome. Step ids are derived
   * from call position (`llm-0`, `llm-1`, ...), never random. If the
   * request now differs from the recorded one, replay throws
   * `StepRequestMismatchError` instead of silently re-calling.
   */
  llmCall(request: LlmRequest): Promise<LlmCallResult>;
}

export type WorkflowFn<Input = unknown, Result = unknown> = (
  input: Input,
  ctx: WorkflowContext,
) => Promise<Result>;

export type WorkflowCommand =
  | { type: 'ScheduleActivity'; activityType: string; input: unknown }
  | { type: 'CompleteWorkflow'; result: unknown }
  | { type: 'FailWorkflow'; error: string }
  | { type: 'ScheduleTimer'; durationMs: number }
  | { type: 'RequestLlmCall'; stepId: string; request: LlmRequest; requestHash: string };

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
    message?: string,
  ) {
    super(
      message ??
        `Non-deterministic workflow: history has call ${callIndex} scheduling ` +
          `"${expectedActivityType}", but the running code's call ${callIndex} asked for ` +
          `"${actualActivityType}" instead.`,
    );
    this.name = 'NonDeterminismError';
  }
}

/**
 * A durable step (LLM call) was reached with a request whose hash differs
 * from the one recorded in history: the prompt, model, params or tool
 * definitions changed while the workflow was in flight. Unlike the plain
 * activity-type mismatch, the engine fails the workflow with this message
 * — it must not re-call the provider and quietly diverge from the
 * recorded run.
 */
export class StepRequestMismatchError extends NonDeterminismError {
  constructor(
    public readonly stepId: string,
    callIndex: number,
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(
      callIndex,
      expectedHash,
      actualHash,
      `Non-deterministic workflow: step "${stepId}" was recorded with request hash ` +
        `${expectedHash.slice(0, 12)}, but the running code now produces ${actualHash.slice(0, 12)}. ` +
        `The model, prompt, params or tool definitions changed since this step was requested; ` +
        `refusing to silently re-call the provider.`,
    );
    this.name = 'StepRequestMismatchError';
  }
}

export type ReplayStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ReplayResult {
  status: ReplayStatus;
  result?: unknown;
  error?: string;
  commands: WorkflowCommand[];
  /**
   * Requests of LLM steps already in history but without an outcome yet,
   * keyed by step id. Present only when non-empty. This is how the
   * executing worker recovers the exact request when the event store
   * holds only a hash (hash-only / redacted / truncated storage).
   */
  pendingLlmRequests?: Record<string, LlmRequest>;
}

export interface ReplayOptions {
  /**
   * Hash function over a canonical-JSON string (sha256 in production).
   * Injected because `packages/core` is browser-safe and has no
   * `node:crypto`. Required only if the workflow calls `llmCall`.
   */
  hash?: (canonicalJson: string) => string;
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

function isLlmRequested(
  e: StoredWorkflowEvent,
): e is StoredWorkflowEvent & { event: LlmRequestedEvent } {
  return e.event.type === 'LLM_REQUESTED';
}

type LlmOutcome =
  { kind: 'completed'; event: LlmCompletedEvent } | { kind: 'failed'; event: LlmFailedEvent };

type ActivityOutcome = { kind: 'completed'; result: unknown } | { kind: 'failed'; error: string };

// Bounded, not unlimited — see docs/03-replay.md. Generous relative to
// any reasonable workflow's history length; ticks spent after execution
// is genuinely stuck (case 3/4 in the design note) are cheap no-ops.
const MAX_DRAIN_TICKS = 1000;

export async function replay<Input = unknown, Result = unknown>(
  workflowFn: WorkflowFn<Input, Result>,
  input: Input,
  history: StoredWorkflowEvent[],
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const scheduledEvents = history.filter(isActivityScheduled);
  const llmRequestedEvents = history.filter(isLlmRequested);
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
  const llmOutcomeBySeq = new Map<number, LlmOutcome>();
  const firedTimerSeqs = new Set<number>();
  for (const { event } of history) {
    if (event.type === 'LLM_COMPLETED') {
      llmOutcomeBySeq.set(event.scheduledEventSeq, { kind: 'completed', event });
    } else if (event.type === 'LLM_FAILED') {
      llmOutcomeBySeq.set(event.scheduledEventSeq, { kind: 'failed', event });
    }
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
  let llmCallIndex = 0;
  let nonDeterminismError: NonDeterminismError | null = null;
  const pendingLlmRequests: Record<string, LlmRequest> = {};

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

    llmCall(request: LlmRequest): Promise<LlmCallResult> {
      const hash = options.hash;
      if (!hash) {
        throw new Error('replay: options.hash is required to use ctx.llmCall');
      }
      const index = llmCallIndex++;
      const stepId = `llm-${index}`;
      const requestHash = hash(canonicalLlmRequest(request));
      const scheduled = llmRequestedEvents[index];

      if (scheduled) {
        if (scheduled.event.stepId !== stepId || scheduled.event.requestHash !== requestHash) {
          nonDeterminismError = new StepRequestMismatchError(
            stepId,
            index,
            scheduled.event.requestHash,
            requestHash,
          );
          return new Promise<LlmCallResult>(() => {
            /* never resolves — this pass is being aborted via nonDeterminismError */
          });
        }
        const outcome = llmOutcomeBySeq.get(scheduled.seq);
        if (outcome?.kind === 'completed') {
          const e = outcome.event;
          return Promise.resolve({
            text: e.text,
            toolCalls: e.toolCalls,
            model: e.model,
            tokensIn: e.tokensIn,
            tokensOut: e.tokensOut,
            truncated: e.truncated,
          });
        }
        if (outcome?.kind === 'failed') {
          return Promise.reject(new Error(outcome.event.error));
        }
        // Requested but no outcome yet — in flight. Remember the request so the
        // executing worker can recover it even if the store only kept a hash.
        pendingLlmRequests[stepId] = request;
        return new Promise<LlmCallResult>(() => {
          /* never resolves — waiting on an LLM call already in flight */
        });
      }

      commands.push({ type: 'RequestLlmCall', stepId, request, requestHash });
      return new Promise<LlmCallResult>(() => {
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

  const pending = Object.keys(pendingLlmRequests).length > 0 ? { pendingLlmRequests } : {};

  const finalSettled = box.settled;
  if (finalSettled === null) {
    return { status: 'RUNNING', commands, ...pending };
  }

  if (finalSettled.kind === 'completed') {
    return {
      status: 'COMPLETED',
      result: finalSettled.result,
      commands: [{ type: 'CompleteWorkflow', result: finalSettled.result }],
      ...pending,
    };
  }

  const message =
    finalSettled.error instanceof Error ? finalSettled.error.message : String(finalSettled.error);
  return {
    status: 'FAILED',
    error: message,
    commands: [{ type: 'FailWorkflow', error: message }],
    ...pending,
  };
}
