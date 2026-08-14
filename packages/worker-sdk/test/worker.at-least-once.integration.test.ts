import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { sleep, spawnReaper, spawnWorker, waitForExit, type SpawnedProcess } from './spawnProcess';

async function seedWorkflow(db: TestDatabase): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [id],
  );
  return id;
}

describe('Worker: at-least-once boundary', () => {
  let db: TestDatabase;
  const spawned: SpawnedProcess[] = [];

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
    for (const { child } of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    spawned.length = 0;
  });

  it(
    'a lease shorter than the handler runtime does not cause concurrent re-execution, ' +
      'as long as the worker heartbeats (heartbeat, not raw lease TTL, is what prevents overlap)',
    async () => {
      await db.pool.query(
        `CREATE TABLE IF NOT EXISTS interval_log (
           task_id BIGINT NOT NULL, worker_id TEXT NOT NULL,
           started_at TIMESTAMPTZ NOT NULL, finished_at TIMESTAMPTZ NOT NULL
         )`,
      );

      const workflowId = await seedWorkflow(db);
      await db.pool.query(
        `INSERT INTO tasks (task_type, workflow_id, queue, status, run_after, max_attempts)
         VALUES ('activity', $1, 'default', 'pending', now(), 3)`,
        [workflowId],
      );

      // Deliberately adversarial: the lease (1s) is far shorter than the
      // handler's runtime (2.5s). Without heartbeats this would let the
      // reaper reclaim mid-handler and hand the same task to a second
      // worker — genuine concurrent execution. With heartbeats firing
      // every 200ms (comfortably under the 1s TTL), the lease should
      // never actually lapse while the worker is alive.
      const reaper = spawnReaper({ databaseUrl: db.connectionString, intervalMs: 200 });
      spawned.push(reaper);
      await reaper.waitForReady();

      const primary = spawnWorker({
        databaseUrl: db.connectionString,
        workerId: 'primary',
        handlerMode: 'record-interval',
        resultsTable: 'interval_log',
        maxConcurrency: 1,
        leaseSeconds: 1,
        heartbeatIntervalMs: 200,
        pollIntervalMs: 20,
        handlerSleepMs: 2_500,
      });
      spawned.push(primary);

      // A second worker polling the same queue the whole time — it should
      // never get a chance at this task while `primary` is alive and
      // heartbeating.
      const shadow = spawnWorker({
        databaseUrl: db.connectionString,
        workerId: 'shadow',
        handlerMode: 'record-interval',
        resultsTable: 'interval_log',
        maxConcurrency: 1,
        leaseSeconds: 1,
        heartbeatIntervalMs: 200,
        pollIntervalMs: 20,
        handlerSleepMs: 2_500,
      });
      spawned.push(shadow);

      await Promise.all([primary.waitForReady(), shadow.waitForReady()]);

      // Wait comfortably past the handler's runtime.
      await sleep(4_000);

      for (const w of [primary, shadow]) w.child.kill('SIGTERM');
      await Promise.all([waitForExit(primary.child), waitForExit(shadow.child)]);
      reaper.child.kill('SIGTERM');
      await waitForExit(reaper.child);

      const { rows } = await db.pool.query<{
        task_id: string;
        worker_id: string;
        started_at: string;
        finished_at: string;
      }>(
        'SELECT task_id, worker_id, started_at, finished_at FROM interval_log ORDER BY started_at',
      );

      // Exactly one execution — the short lease never actually mattered
      // because heartbeats kept renewing it faster than it could expire.
      // Which of the two idle-polling workers won the initial dequeue race
      // is incidental (SKIP LOCKED, not a coordinated assignment); what
      // matters is that only one of them ever got to run it, once.
      expect(rows).toHaveLength(1);
      expect(['primary', 'shadow']).toContain(rows[0]?.worker_id);

      const { rows: taskRows } = await db.pool.query<{ status: string; attempt: number }>(
        'SELECT status, attempt FROM tasks',
      );
      expect(taskRows[0]?.status).toBe('completed');
      expect(taskRows[0]?.attempt).toBe(1);
    },
    30_000,
  );
});
