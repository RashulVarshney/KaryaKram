import { foldEvents } from '@karyakram/core';
import { appendEvents, getEvents, withTransaction, type Task } from '@karyakram/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { createActivityHandler } from '../src/activityHandler';
import {
  createReserveChargeShipActivities,
  ensureActivityExecutionsTable,
  getActivityExecutionCount,
  reserveChargeShip,
} from '../src/examples/reserveChargeShip';
import { startWorkflow } from '../src/startWorkflow';

// The activity handler only reads `scheduledEventSeq` and `workflowId`
// off the task it's given — everything else here is a placeholder,
// standing in for "some redelivered task row pointing at the same slot."
function fakeActivityTask(workflowId: string, scheduledEventSeq: number): Task {
  return {
    id: 'fake-redelivered-task',
    taskType: 'activity',
    workflowId,
    queue: 'default',
    scheduledEventSeq: String(scheduledEventSeq),
    status: 'leased',
    runAfter: new Date(),
    attempt: 2,
    maxAttempts: 3,
    lastError: null,
    leasedBy: 'redelivery-simulator',
    leaseExpiresAt: new Date(Date.now() + 30_000),
    createdAt: new Date(),
  };
}

describe('idempotency: the internal completion guard', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
    await ensureActivityExecutionsTable(db.pool);
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  it('does not re-run an activity function whose outcome is already in history', async () => {
    const workflowId = await startWorkflow(db.pool, reserveChargeShip, { orderId: 'idem-1' });
    const handler = createActivityHandler(db.pool, createReserveChargeShipActivities(db.pool));

    // Manually append the first ActivityScheduled event and run the
    // handler for real once, the normal way a worker would.
    const events1 = await getEvents(db.pool, workflowId);
    const state1 = foldEvents(events1);
    expect(state1.status).toBe('RUNNING');

    // startWorkflow only appends WorkflowStarted (M3's design) — nothing
    // is scheduled yet without a replay worker running. For this test we
    // only care about the activity handler's guard, so append the first
    // ActivityScheduled event directly rather than spinning up a full
    // workflow-replay worker.
    await withTransaction(db.pool, (client) =>
      appendEvents(client, {
        workflowId,
        events: [
          { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'idem-1' } },
        ],
      }),
    );

    const scheduledEvents = await getEvents(db.pool, workflowId);
    const scheduled = scheduledEvents.find((e) => e.event.type === 'ActivityScheduled');
    if (!scheduled) throw new Error('unreachable');

    await handler(fakeActivityTask(workflowId, scheduled.seq));
    expect(await getActivityExecutionCount(db.pool, 'reserve')).toBe(1);

    const afterFirstRun = await getEvents(db.pool, workflowId);
    const completedCount = afterFirstRun.filter(
      (e) => e.event.type === 'ActivityCompleted' && e.event.scheduledEventSeq === scheduled.seq,
    ).length;
    expect(completedCount).toBe(1);

    // Simulate a redelivery: the exact same task, run through the
    // handler again — as if the original had been reclaimed and
    // re-leased after already durably completing.
    await handler(fakeActivityTask(workflowId, scheduled.seq));

    // The guard must have skipped it: the function did not run again,
    // and no duplicate ActivityCompleted event was appended.
    expect(await getActivityExecutionCount(db.pool, 'reserve')).toBe(1);
    const afterRedelivery = await getEvents(db.pool, workflowId);
    const completedCountAfter = afterRedelivery.filter(
      (e) => e.event.type === 'ActivityCompleted' && e.event.scheduledEventSeq === scheduled.seq,
    ).length;
    expect(completedCountAfter).toBe(1);
  });
});
