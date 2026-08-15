import { foldEvents } from '@karyakram/core';
import { getEvents } from '@karyakram/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import {
  ensureTimerWorkflowExecutionsTable,
  getTimerWorkflowExecutionCount,
  timerWorkflow,
} from '../src/examples/timerWorkflow';
import { startWorkflow } from '../src/startWorkflow';
import {
  sleep,
  spawnReaper,
  spawnTimerWorkflowApp,
  waitForExit,
  type SpawnedProcess,
} from './spawnProcess';

async function pollUntil(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs = 10 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: condition never became true in time');
    await sleep(intervalMs);
  }
}

describe('durable timer survives a full cluster restart', () => {
  let db: TestDatabase;
  const spawned: SpawnedProcess[] = [];

  beforeAll(async () => {
    db = await startTestDatabase();
    await ensureTimerWorkflowExecutionsTable(db.pool);
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterEach(async () => {
    for (const { child } of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    spawned.length = 0;
  });

  it('fires the timer and completes after every worker AND the reaper are killed and restarted mid-wait', async () => {
    // A short duration standing in for "5 minutes" — see docs/04-durability.md.
    const workflowId = await startWorkflow(db.pool, timerWorkflow, { sleepMs: 3_000 });

    const reaper1 = spawnReaper({ databaseUrl: db.connectionString, intervalMs: 200 });
    spawned.push(reaper1);
    await reaper1.waitForReady();

    const app1 = spawnTimerWorkflowApp({
      databaseUrl: db.connectionString,
      workerId: 'app-1',
      leaseSeconds: 3,
      heartbeatIntervalMs: 500,
      pollIntervalMs: 20,
    });
    spawned.push(app1);
    await app1.waitForReady();

    // Wait for the first activity to durably complete before pulling
    // the plug on the entire cluster — the timer should be scheduled
    // (or about to be) at that point, definitely not fired yet given
    // the 3s sleep.
    await pollUntil(
      async () => {
        const events = await getEvents(db.pool, workflowId);
        const state = foldEvents(events);
        return Object.values(state.activities).some(
          (a) => a.activityType === 'before-timer' && a.status === 'COMPLETED',
        );
      },
      { timeoutMs: 10_000 },
    );

    // Kill EVERYTHING — every worker and the reaper. Nothing durable
    // survives except what's in Postgres.
    app1.child.kill('SIGKILL');
    reaper1.child.kill('SIGKILL');
    await Promise.all([waitForExit(app1.child), waitForExit(reaper1.child)]);

    // Stand in for "the cluster was down for a while."
    await sleep(300);

    const reaper2 = spawnReaper({ databaseUrl: db.connectionString, intervalMs: 200 });
    spawned.push(reaper2);
    await reaper2.waitForReady();

    const app2 = spawnTimerWorkflowApp({
      databaseUrl: db.connectionString,
      workerId: 'app-2',
      leaseSeconds: 3,
      heartbeatIntervalMs: 500,
      pollIntervalMs: 20,
    });
    spawned.push(app2);
    await app2.waitForReady();

    await pollUntil(
      async () => {
        const { rows } = await db.pool.query<{ status: string }>(
          'SELECT status FROM workflow_executions WHERE id = $1',
          [workflowId],
        );
        return rows[0]?.status === 'COMPLETED';
      },
      { timeoutMs: 20_000 },
    );

    const events = await getEvents(db.pool, workflowId);
    const state = foldEvents(events);
    expect(state.status).toBe('COMPLETED');
    expect(Object.values(state.timers)).toHaveLength(1);
    for (const timer of Object.values(state.timers)) {
      expect(timer.status).toBe('FIRED');
    }
    for (const activity of Object.values(state.activities)) {
      expect(activity.status).toBe('COMPLETED');
    }

    // Neither activity's function body ran twice, despite the restart.
    expect(await getTimerWorkflowExecutionCount(db.pool, 'before-timer')).toBe(1);
    expect(await getTimerWorkflowExecutionCount(db.pool, 'after-timer')).toBe(1);

    app2.child.kill('SIGTERM');
    reaper2.child.kill('SIGTERM');
    await Promise.all([waitForExit(app2.child), waitForExit(reaper2.child)]);
  }, 40_000);
});
