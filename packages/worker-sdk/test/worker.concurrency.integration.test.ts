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

async function seedTasks(db: TestDatabase, workflowId: string, count: number): Promise<void> {
  await db.pool.query(
    `INSERT INTO tasks (task_type, workflow_id, queue, status, run_after, max_attempts)
     SELECT 'activity', $1, 'default', 'pending', now(), 3
     FROM generate_series(1, $2)`,
    [workflowId, count],
  );
}

async function pollUntil(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs = 200 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: condition never became true in time');
    await sleep(intervalMs);
  }
}

describe('Worker: real multi-process concurrency', () => {
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
    // Belt-and-braces cleanup in case a test fails before its own kills.
    for (const { child } of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    spawned.length = 0;
  });

  it('no double-dispatch: 8 workers drain 10,000 tasks with zero unique-constraint violations', async () => {
    await db.pool.query(
      `CREATE TABLE IF NOT EXISTS results (task_id BIGINT PRIMARY KEY, worker_id TEXT NOT NULL)`,
    );

    const workflowId = await seedWorkflow(db);
    const TASK_COUNT = 10_000;
    const WORKER_COUNT = 8;
    await seedTasks(db, workflowId, TASK_COUNT);

    const workers: SpawnedProcess[] = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
      const w = spawnWorker({
        databaseUrl: db.connectionString,
        workerId: `w${i}`,
        handlerMode: 'record',
        maxConcurrency: 25,
        leaseSeconds: 30,
        heartbeatIntervalMs: 5_000,
        pollIntervalMs: 20,
      });
      workers.push(w);
      spawned.push(w);
    }
    await Promise.all(workers.map((w) => w.waitForReady()));

    await pollUntil(
      async () => {
        const { rows } = await db.pool.query<{ count: string }>('SELECT count(*) FROM results');
        return Number(rows[0]?.count ?? 0) >= TASK_COUNT;
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    for (const w of workers) w.child.kill('SIGTERM');
    await Promise.all(workers.map((w) => waitForExit(w.child)));

    const { rows: resultRows } = await db.pool.query<{ count: string }>(
      'SELECT count(*) FROM results',
    );
    expect(Number(resultRows[0]?.count)).toBe(TASK_COUNT);

    const { rows: distinctTaskIds } = await db.pool.query<{ count: string }>(
      'SELECT count(DISTINCT task_id) FROM results',
    );
    expect(Number(distinctTaskIds[0]?.count)).toBe(TASK_COUNT);

    // No worker starved.
    const { rows: perWorker } = await db.pool.query<{ worker_id: string; count: string }>(
      'SELECT worker_id, count(*) FROM results GROUP BY worker_id',
    );
    expect(perWorker.length).toBe(WORKER_COUNT);
    for (const row of perWorker) {
      expect(Number(row.count)).toBeGreaterThan(0);
    }
  }, 120_000);

  it('crash recovery: killing 2 of 8 workers mid-run still completes all tasks', async () => {
    const workflowId = await seedWorkflow(db);
    const TASK_COUNT = 2_000;
    const WORKER_COUNT = 8;
    await seedTasks(db, workflowId, TASK_COUNT);

    const reaper = spawnReaper({ databaseUrl: db.connectionString, intervalMs: 500 });
    spawned.push(reaper);
    await reaper.waitForReady();

    const workers: SpawnedProcess[] = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
      const w = spawnWorker({
        databaseUrl: db.connectionString,
        workerId: `crash-w${i}`,
        handlerMode: 'noop',
        maxConcurrency: 10,
        leaseSeconds: 3,
        heartbeatIntervalMs: 1_000,
        pollIntervalMs: 20,
        handlerSleepMs: 20,
      });
      workers.push(w);
      spawned.push(w);
    }
    await Promise.all(workers.map((w) => w.waitForReady()));

    // Let the fleet get partway through, then kill two workers outright —
    // whatever they were holding has to be reclaimed and finished by
    // the survivors, with no coordination beyond lease expiry + reaper.
    await sleep(300);
    workers[0]!.child.kill('SIGKILL');
    workers[1]!.child.kill('SIGKILL');

    const survivors = workers.slice(2);

    await pollUntil(
      async () => {
        const { rows } = await db.pool.query<{ count: string }>(
          "SELECT count(*) FROM tasks WHERE status = 'completed'",
        );
        return Number(rows[0]?.count ?? 0) >= TASK_COUNT;
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    const { rows: statusCounts } = await db.pool.query<{ status: string; count: string }>(
      'SELECT status, count(*) FROM tasks GROUP BY status',
    );
    const completed = statusCounts.find((r) => r.status === 'completed');
    expect(Number(completed?.count)).toBe(TASK_COUNT);

    for (const w of survivors) w.child.kill('SIGTERM');
    await Promise.all(survivors.map((w) => waitForExit(w.child)));
    reaper.child.kill('SIGTERM');
    await waitForExit(reaper.child);
  }, 90_000);
});
