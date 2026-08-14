import { describe, expect, it } from 'vitest';
import { foldEvents, initialState, type StoredWorkflowEvent } from './workflow';

function ev(seq: number, event: StoredWorkflowEvent['event']): StoredWorkflowEvent {
  return { seq, event };
}

describe('foldEvents', () => {
  it('returns initialState unchanged for an empty log', () => {
    expect(foldEvents([])).toBe(initialState);
  });

  it('walks a 3-activity happy path to COMPLETED', () => {
    const events: StoredWorkflowEvent[] = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'order', input: { orderId: 42 } }),
      ev(2, { type: 'ActivityScheduled', activityType: 'reserve', input: null }),
      ev(3, { type: 'ActivityCompleted', scheduledEventSeq: 2, result: { reserved: true } }),
      ev(4, { type: 'ActivityScheduled', activityType: 'charge', input: null }),
      ev(5, { type: 'ActivityCompleted', scheduledEventSeq: 4, result: { charged: true } }),
      ev(6, { type: 'ActivityScheduled', activityType: 'ship', input: null }),
      ev(7, { type: 'ActivityCompleted', scheduledEventSeq: 6, result: { shipped: true } }),
      ev(8, { type: 'WorkflowCompleted', result: { orderId: 42, status: 'done' } }),
    ];

    // Check the state after just the first three events too — proves the
    // fold is a genuine reduction, not just correct at the end.
    const afterReserveScheduled = foldEvents(events.slice(0, 2));
    expect(afterReserveScheduled.status).toBe('RUNNING');
    expect(afterReserveScheduled.activities[2]).toEqual({
      activityType: 'reserve',
      status: 'SCHEDULED',
    });

    const afterReserveCompleted = foldEvents(events.slice(0, 3));
    expect(afterReserveCompleted.activities[2]).toEqual({
      activityType: 'reserve',
      status: 'COMPLETED',
      result: { reserved: true },
    });

    const final = foldEvents(events);
    expect(final.status).toBe('COMPLETED');
    expect(final.workflowType).toBe('order');
    expect(final.result).toEqual({ orderId: 42, status: 'done' });
    expect(final.activities).toEqual({
      2: { activityType: 'reserve', status: 'COMPLETED', result: { reserved: true } },
      4: { activityType: 'charge', status: 'COMPLETED', result: { charged: true } },
      6: { activityType: 'ship', status: 'COMPLETED', result: { shipped: true } },
    });
  });

  it('transitions to FAILED on ActivityFailed -> WorkflowFailed', () => {
    const events: StoredWorkflowEvent[] = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'order', input: {} }),
      ev(2, { type: 'ActivityScheduled', activityType: 'reserve', input: null }),
      ev(3, { type: 'ActivityFailed', scheduledEventSeq: 2, error: 'out of stock' }),
      ev(4, { type: 'WorkflowFailed', error: 'reserve failed: out of stock' }),
    ];

    const state = foldEvents(events);
    expect(state.status).toBe('FAILED');
    expect(state.error).toBe('reserve failed: out of stock');
    expect(state.activities[2]).toEqual({
      activityType: 'reserve',
      status: 'FAILED',
      error: 'out of stock',
    });
  });

  it('ignores a completion event referencing an unknown scheduledEventSeq', () => {
    const events: StoredWorkflowEvent[] = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'order', input: {} }),
      ev(2, { type: 'ActivityCompleted', scheduledEventSeq: 999, result: 'orphaned' }),
    ];

    const state = foldEvents(events);
    expect(state.activities).toEqual({});
  });
});
