import { describe, expect, it } from 'vitest';
import { NonDeterminismError, replay, type WorkflowContext, type WorkflowFn } from './replay';
import type { StoredWorkflowEvent } from './workflow';

function ev(seq: number, event: StoredWorkflowEvent['event']): StoredWorkflowEvent {
  return { seq, event };
}

interface OrderInput {
  orderId: string;
}

const threeStepWorkflow: WorkflowFn<OrderInput, { done: true; last: unknown }> = async (
  input,
  ctx: WorkflowContext,
) => {
  const a = await ctx.scheduleActivity('reserve', input);
  const b = await ctx.scheduleActivity('charge', a);
  const c = await ctx.scheduleActivity('ship', b);
  return { done: true, last: c };
};

const uncaughtFailureWorkflow: WorkflowFn = async (input, ctx: WorkflowContext) => {
  await ctx.scheduleActivity('risky', input);
  return { ok: true };
};

const resilientWorkflow: WorkflowFn = async (input, ctx: WorkflowContext) => {
  try {
    await ctx.scheduleActivity('risky', input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.scheduleActivity('fallback', { reason: message });
  }
  return { recovered: true };
};

const activitySleepActivityWorkflow: WorkflowFn<OrderInput, { done: true }> = async (
  input,
  ctx: WorkflowContext,
) => {
  const reserved = await ctx.scheduleActivity('reserve', input);
  await ctx.sleep(5 * 60_000);
  await ctx.scheduleActivity('charge', reserved);
  return { done: true };
};

const waitForApprovalWorkflow: WorkflowFn<OrderInput, { approved: boolean }> = async (
  input,
  ctx: WorkflowContext,
) => {
  await ctx.scheduleActivity('reserve', input);
  const approval = await ctx.waitForSignal<{ approved: boolean }>('approval');
  return { approved: approval.approved };
};

const waitForTwoSignalsWorkflow: WorkflowFn<unknown, string[]> = async (
  _input,
  ctx: WorkflowContext,
) => {
  const first = await ctx.waitForSignal<string>('ping');
  const second = await ctx.waitForSignal<string>('ping');
  return [first, second];
};

describe('replay', () => {
  it('a fresh workflow (no history) emits exactly the first command', async () => {
    const result = await replay(threeStepWorkflow, { orderId: 'x' }, []);
    expect(result.status).toBe('RUNNING');
    expect(result.commands).toEqual([
      { type: 'ScheduleActivity', activityType: 'reserve', input: { orderId: 'x' } },
    ]);
  });

  it('resolves a completed step from history instantly and emits the next command', async () => {
    const history: StoredWorkflowEvent[] = [
      ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
      ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
    ];
    const result = await replay(threeStepWorkflow, { orderId: 'x' }, history);
    expect(result.status).toBe('RUNNING');
    expect(result.commands).toEqual([
      { type: 'ScheduleActivity', activityType: 'charge', input: 'reserved' },
    ]);
  });

  it('does not re-schedule an activity that is already scheduled but not yet completed', async () => {
    const history: StoredWorkflowEvent[] = [
      ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
    ];
    const result = await replay(threeStepWorkflow, { orderId: 'x' }, history);
    expect(result.status).toBe('RUNNING');
    expect(result.commands).toEqual([]);
  });

  it('reaches the function’s natural return and emits CompleteWorkflow', async () => {
    const history: StoredWorkflowEvent[] = [
      ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
      ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
      ev(3, { type: 'ActivityScheduled', activityType: 'charge', input: 'reserved' }),
      ev(4, { type: 'ActivityCompleted', scheduledEventSeq: 3, result: 'charged' }),
      ev(5, { type: 'ActivityScheduled', activityType: 'ship', input: 'charged' }),
      ev(6, { type: 'ActivityCompleted', scheduledEventSeq: 5, result: 'shipped' }),
    ];
    const result = await replay(threeStepWorkflow, { orderId: 'x' }, history);
    expect(result.status).toBe('COMPLETED');
    expect(result.result).toEqual({ done: true, last: 'shipped' });
    expect(result.commands).toEqual([
      { type: 'CompleteWorkflow', result: { done: true, last: 'shipped' } },
    ]);
  });

  it('rejects the call when history has a failure, ending an uncaught workflow as FAILED', async () => {
    const history: StoredWorkflowEvent[] = [
      ev(1, { type: 'ActivityScheduled', activityType: 'risky', input: null }),
      ev(2, { type: 'ActivityFailed', scheduledEventSeq: 1, error: 'boom' }),
    ];
    const result = await replay(uncaughtFailureWorkflow, null, history);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('boom');
    expect(result.commands).toEqual([{ type: 'FailWorkflow', error: result.error }]);
  });

  it('lets workflow code catch a historical failure and keep going', async () => {
    const history: StoredWorkflowEvent[] = [
      ev(1, { type: 'ActivityScheduled', activityType: 'risky', input: null }),
      ev(2, { type: 'ActivityFailed', scheduledEventSeq: 1, error: 'boom' }),
    ];
    const result = await replay(resilientWorkflow, null, history);
    expect(result.status).toBe('RUNNING');
    expect(result.commands).toEqual([
      { type: 'ScheduleActivity', activityType: 'fallback', input: { reason: 'boom' } },
    ]);
  });

  it('throws NonDeterminismError when the running code disagrees with history at a call index', async () => {
    const history: StoredWorkflowEvent[] = [
      ev(1, { type: 'ActivityScheduled', activityType: 'some-other-activity', input: null }),
    ];
    await expect(replay(threeStepWorkflow, { orderId: 'x' }, history)).rejects.toThrow(
      NonDeterminismError,
    );
  });

  describe('durable timers', () => {
    it('a fresh sleep() call emits ScheduleTimer, in the same call order as interleaved activities', async () => {
      const history: StoredWorkflowEvent[] = [
        ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
        ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
      ];
      const result = await replay(activitySleepActivityWorkflow, { orderId: 'x' }, history);
      expect(result.status).toBe('RUNNING');
      expect(result.commands).toEqual([{ type: 'ScheduleTimer', durationMs: 5 * 60_000 }]);
    });

    it('does not re-schedule a timer that is already scheduled but not yet fired', async () => {
      const history: StoredWorkflowEvent[] = [
        ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
        ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
        ev(3, { type: 'TimerScheduled', fireAt: '2026-01-01T00:05:00.000Z' }),
      ];
      const result = await replay(activitySleepActivityWorkflow, { orderId: 'x' }, history);
      expect(result.status).toBe('RUNNING');
      expect(result.commands).toEqual([]);
    });

    it('a fired timer resolves and lets the workflow continue to the next activity', async () => {
      const history: StoredWorkflowEvent[] = [
        ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
        ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
        ev(3, { type: 'TimerScheduled', fireAt: '2026-01-01T00:05:00.000Z' }),
        ev(4, { type: 'TimerFired', scheduledEventSeq: 3 }),
      ];
      const result = await replay(activitySleepActivityWorkflow, { orderId: 'x' }, history);
      expect(result.status).toBe('RUNNING');
      expect(result.commands).toEqual([
        { type: 'ScheduleActivity', activityType: 'charge', input: 'reserved' },
      ]);
    });

    it('reaches completion once the timer has fired and the final activity has completed', async () => {
      const history: StoredWorkflowEvent[] = [
        ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
        ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
        ev(3, { type: 'TimerScheduled', fireAt: '2026-01-01T00:05:00.000Z' }),
        ev(4, { type: 'TimerFired', scheduledEventSeq: 3 }),
        ev(5, { type: 'ActivityScheduled', activityType: 'charge', input: 'reserved' }),
        ev(6, { type: 'ActivityCompleted', scheduledEventSeq: 5, result: 'charged' }),
      ];
      const result = await replay(activitySleepActivityWorkflow, { orderId: 'x' }, history);
      expect(result.status).toBe('COMPLETED');
      expect(result.result).toEqual({ done: true });
    });
  });

  describe('signals', () => {
    it('hangs with zero commands while waiting for a signal that has not arrived', async () => {
      const history: StoredWorkflowEvent[] = [
        ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
        ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
      ];
      const result = await replay(waitForApprovalWorkflow, { orderId: 'x' }, history);
      expect(result.status).toBe('RUNNING');
      expect(result.commands).toEqual([]);
    });

    it('resolves with the signal payload once it exists in history, and completes the workflow', async () => {
      const history: StoredWorkflowEvent[] = [
        ev(1, { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'x' } }),
        ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 1, result: 'reserved' }),
        ev(3, { type: 'SignalReceived', signalName: 'approval', payload: { approved: true } }),
      ];
      const result = await replay(waitForApprovalWorkflow, { orderId: 'x' }, history);
      expect(result.status).toBe('COMPLETED');
      expect(result.result).toEqual({ approved: true });
    });

    it('matches repeated waitForSignal calls to same-named signals in arrival order', async () => {
      const oneSignal: StoredWorkflowEvent[] = [
        ev(1, { type: 'SignalReceived', signalName: 'ping', payload: 'first' }),
      ];
      const oneResult = await replay(waitForTwoSignalsWorkflow, null, oneSignal);
      expect(oneResult.status).toBe('RUNNING');
      expect(oneResult.commands).toEqual([]);

      const twoSignals: StoredWorkflowEvent[] = [
        ev(1, { type: 'SignalReceived', signalName: 'ping', payload: 'first' }),
        ev(2, { type: 'SignalReceived', signalName: 'ping', payload: 'second' }),
      ];
      const twoResult = await replay(waitForTwoSignalsWorkflow, null, twoSignals);
      expect(twoResult.status).toBe('COMPLETED');
      expect(twoResult.result).toEqual(['first', 'second']);
    });
  });
});
