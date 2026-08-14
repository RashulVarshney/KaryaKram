import { foldEvents } from '@karyakram/core';
import { getEvents } from '@karyakram/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import {
  ensureActivityExecutionsTable,
  getActivityExecutionCount,
  reserveChargeShip,
} from '../src/examples/reserveChargeShip';
import { startWorkflow } from '../src/startWorkflow';
import {
  sleep,
  spawnReaper,
  spawnReserveChargeShipApp,
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

describe('replay crash recovery: kill -9 mid-workflow, a fresh worker resumes it', () => {
  let db: TestDatabase;
  const spawned: SpawnedProcess[] = [];

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
    for (const { child } of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    spawned.length = 0;
  });

  it(
    "reserve's activity function runs exactly once, despite the process " +
      'being killed right after it completes and before charge starts',
    async () => {
      const workflowId = await startWorkflow(db.pool, reserveChargeShip, { orderId: 'crash-1' });

      // A reaper is required here, not optional: if the kill lands while
      // the *workflow* task itself is leased-but-incomplete (completing
      // an activity immediately enqueues a new workflow task, which this
      // same process may start processing right away — a real race, not
      // a hypothetical one), that lease needs to be reclaimed before a
      // fresh worker can ever see it again. Short lease + fast reaper
      // interval keep recovery well within this test's timeout.
      const reaper = spawnReaper({ databaseUrl: db.connectionString, intervalMs: 200 });
      spawned.push(reaper);
      await reaper.waitForReady();

      const first = spawnReserveChargeShipApp({
        databaseUrl: db.connectionString,
        workerId: 'app-1',
        leaseSeconds: 2,
        heartbeatIntervalMs: 500,
        pollIntervalMs: 10,
      });
      spawned.push(first);
      await first.waitForReady();

      // Wait for reserve to durably complete (per the event log, not the
      // execution counter — the counter increments at activity *start*,
      // and we specifically want the point right after it *finishes*).
      // This is a best-effort race, same as M1's crash-recovery demo:
      // charge *may* occasionally have already started by the time the
      // SIGKILL lands (another local dequeue+replay cycle has to happen
      // first, which is measurably slower than this poll noticing
      // completion), so the strict assertion below is on reserve only.
      await pollUntil(
        async () => {
          const events = await getEvents(db.pool, workflowId);
          const state = foldEvents(events);
          return Object.values(state.activities).some(
            (a) => a.activityType === 'reserve' && a.status === 'COMPLETED',
          );
        },
        { timeoutMs: 10_000 },
      );

      first.child.kill('SIGKILL');
      await waitForExit(first.child);

      const second = spawnReserveChargeShipApp({
        databaseUrl: db.connectionString,
        workerId: 'app-2',
        leaseSeconds: 2,
        heartbeatIntervalMs: 500,
        pollIntervalMs: 10,
      });
      spawned.push(second);
      await second.waitForReady();

      await pollUntil(
        async () => {
          const { rows } = await db.pool.query<{ status: string }>(
            'SELECT status FROM workflow_executions WHERE id = $1',
            [workflowId],
          );
          return rows[0]?.status === 'COMPLETED';
        },
        { timeoutMs: 15_000 },
      );

      const events = await getEvents(db.pool, workflowId);
      const state = foldEvents(events);
      expect(state.status).toBe('COMPLETED');
      for (const activity of Object.values(state.activities)) {
        expect(activity.status).toBe('COMPLETED');
      }

      // The actual M3 guarantee: reserve's function body never runs
      // twice, even though the process that started it was killed.
      expect(await getActivityExecutionCount(db.pool, 'reserve')).toBe(1);

      second.child.kill('SIGTERM');
      await waitForExit(second.child);
      reaper.child.kill('SIGTERM');
      await waitForExit(reaper.child);
    },
    30_000,
  );
});
