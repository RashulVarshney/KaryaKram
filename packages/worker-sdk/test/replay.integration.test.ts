import { foldEvents } from '@karyakram/core';
import { getEvents } from '@karyakram/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { createActivityHandler } from '../src/activityHandler';
import {
  createReserveChargeShipActivities,
  ensureActivityExecutionsTable,
  getActivityExecutionCount,
  reserveChargeShip,
} from '../src/examples/reserveChargeShip';
import { startWorkflow } from '../src/startWorkflow';
import { Worker } from '../src/worker';
import { createWorkflowReplayHandler } from '../src/workflowReplayHandler';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('replay end-to-end, through real Workers (no hardcoded sequence anywhere)', () => {
  let db: TestDatabase;
  const workers: Worker[] = [];

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

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    workers.length = 0;
  });

  it('drives reserve -> charge -> ship to COMPLETED via defineWorkflow/defineActivity', async () => {
    const workflowId = await startWorkflow(db.pool, reserveChargeShip, { orderId: 'e2e-1' });

    const activityWorker = new Worker(
      db.pool,
      {
        workerId: 'activity-1',
        taskType: 'activity',
        maxConcurrency: 5,
        leaseSeconds: 10,
        heartbeatIntervalMs: 2_000,
        pollIntervalMs: 20,
      },
      createActivityHandler(db.pool, createReserveChargeShipActivities(db.pool)),
    );
    const workflowWorker = new Worker(
      db.pool,
      {
        workerId: 'workflow-1',
        taskType: 'workflow',
        maxConcurrency: 5,
        leaseSeconds: 10,
        heartbeatIntervalMs: 2_000,
        pollIntervalMs: 20,
      },
      createWorkflowReplayHandler(db.pool, [reserveChargeShip]),
    );
    workers.push(activityWorker, workflowWorker);
    activityWorker.start();
    workflowWorker.start();

    const deadline = Date.now() + 10_000;
    let status = 'RUNNING';
    while (status !== 'COMPLETED' && Date.now() < deadline) {
      const { rows } = await db.pool.query<{ status: string }>(
        'SELECT status FROM workflow_executions WHERE id = $1',
        [workflowId],
      );
      status = rows[0]?.status ?? 'RUNNING';
      if (status !== 'COMPLETED') await sleep(50);
    }
    expect(status).toBe('COMPLETED');

    const events = await getEvents(db.pool, workflowId);
    const state = foldEvents(events);
    expect(state.status).toBe('COMPLETED');
    expect(Object.values(state.activities).map((a) => a.activityType)).toEqual([
      'reserve',
      'charge',
      'ship',
    ]);
    for (const activity of Object.values(state.activities)) {
      expect(activity.status).toBe('COMPLETED');
    }

    // Each activity's function body ran exactly once — the real proof
    // that replay isn't just producing a plausible-looking event log,
    // since a broken replay could still fold into a sensible state while
    // silently re-executing an activity that already completed.
    expect(await getActivityExecutionCount(db.pool, 'reserve')).toBe(1);
    expect(await getActivityExecutionCount(db.pool, 'charge')).toBe(1);
    expect(await getActivityExecutionCount(db.pool, 'ship')).toBe(1);
  });
});
