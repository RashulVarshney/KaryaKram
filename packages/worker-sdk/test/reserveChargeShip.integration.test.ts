import { foldEvents } from '@karyakram/core';
import { getEvents } from '@karyakram/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import {
  ACTIVITY_SEQUENCE,
  createReserveChargeShipHandler,
  startReserveChargeShipWorkflow,
} from '../src/examples/reserveChargeShip';
import { Worker } from '../src/worker';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('reserve -> charge -> ship, end to end through a real Worker', () => {
  let db: TestDatabase;
  let worker: Worker | undefined;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  it('completes all 3 activities in order and reaches WorkflowCompleted', async () => {
    const workflowId = await startReserveChargeShipWorkflow(db.pool, 'order-42');

    worker = new Worker(
      db.pool,
      {
        workerId: 'e2e-worker',
        // M2 enqueues `workflow` tasks too (for the future M3 replay
        // worker), but nothing consumes them yet — a worker that didn't
        // filter here would pick one up and fail it as an activity.
        taskType: 'activity',
        maxConcurrency: 1,
        leaseSeconds: 10,
        heartbeatIntervalMs: 2_000,
      },
      createReserveChargeShipHandler(db.pool),
    );
    worker.start();

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
    expect(Object.values(state.activities)).toHaveLength(ACTIVITY_SEQUENCE.length);
    for (const activity of Object.values(state.activities)) {
      expect(activity.status).toBe('COMPLETED');
    }
    expect(Object.values(state.activities).map((a) => a.activityType)).toEqual([
      ...ACTIVITY_SEQUENCE,
    ]);

    // Exactly one activity task per step, all completed — no double-run.
    const { rows: taskRows } = await db.pool.query<{
      task_type: string;
      status: string;
      count: string;
    }>(
      'SELECT task_type, status, count(*) FROM tasks WHERE workflow_id = $1 GROUP BY task_type, status',
      [workflowId],
    );
    const activityCompleted = taskRows.find(
      (r) => r.task_type === 'activity' && r.status === 'completed',
    );
    expect(Number(activityCompleted?.count)).toBe(ACTIVITY_SEQUENCE.length);
  });
});
