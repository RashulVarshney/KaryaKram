import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { sleep, spawnWorker, waitForExit, type SpawnedProcess } from './spawnProcess';

async function seedWorkflow(db: TestDatabase): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [id],
  );
  return id;
}

describe('Worker: graceful shutdown', () => {
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

  it('SIGTERM lets in-flight tasks finish before the process exits — nothing stranded', async () => {
    const workflowId = await seedWorkflow(db);
    // A handful of slow-ish tasks so SIGTERM is guaranteed to land while
    // some are still in flight, not after they've all already finished.
    const TASK_COUNT = 5;
    await db.pool.query(
      `INSERT INTO tasks (task_type, workflow_id, queue, status, run_after, max_attempts)
         SELECT 'activity', $1, 'default', 'pending', now(), 3
         FROM generate_series(1, $2)`,
      [workflowId, TASK_COUNT],
    );

    const worker = spawnWorker({
      databaseUrl: db.connectionString,
      workerId: 'shutdown-worker',
      handlerMode: 'noop',
      maxConcurrency: TASK_COUNT,
      leaseSeconds: 30,
      heartbeatIntervalMs: 5_000,
      pollIntervalMs: 20,
      handlerSleepMs: 1_500,
      drainTimeoutMs: 10_000,
    });
    spawned.push(worker);
    await worker.waitForReady();

    // Give it a moment to dequeue and start all 5 (they all fit under
    // maxConcurrency), then SIGTERM mid-handler.
    await sleep(300);
    worker.child.kill('SIGTERM');

    const exitCode = await waitForExit(worker.child);
    expect(exitCode).toBe(0);

    const { rows } = await db.pool.query<{ status: string; count: string }>(
      'SELECT status, count(*) FROM tasks GROUP BY status',
    );
    const completed = rows.find((r) => r.status === 'completed');
    expect(Number(completed?.count)).toBe(TASK_COUNT);
    // Nothing should be left `leased` — SIGTERM must drain, not abandon.
    expect(rows.find((r) => r.status === 'leased')).toBeUndefined();
  }, 30_000);
});
