import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { Scheduler } from '../src/scheduler';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs = 20 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: condition never became true in time');
    await sleep(intervalMs);
  }
}

/** Seeds a task whose lease is already expired, ready for the reaper to reclaim. */
async function seedExpiredLease(db: TestDatabase): Promise<string> {
  const workflowId = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [workflowId],
  );
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO tasks (task_type, workflow_id, queue, status, leased_by, lease_expires_at)
     VALUES ('activity', $1, 'default', 'leased', 'stale-worker', now() - interval '1 minute')
     RETURNING id`,
    [workflowId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('seedExpiredLease: insert returned no row');
  return id;
}

async function taskStatus(db: TestDatabase, taskId: string): Promise<string> {
  const result = await db.pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
    taskId,
  ]);
  const status = result.rows[0]?.status;
  if (!status) throw new Error(`taskStatus: no row for task ${taskId}`);
  return status;
}

describe('reaper runs only on the leader, and fails over with it', () => {
  let db: TestDatabase;
  const schedulers: Scheduler[] = [];

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
    await Promise.all(schedulers.map((s) => s.stop()));
    schedulers.length = 0;
  });

  function makeScheduler(leaderId: string): Scheduler {
    const scheduler = new Scheduler(db.pool, {
      connectionString: db.connectionString,
      leaderId,
      electionPollMs: 50,
      reconnectDelayMs: 50,
      reaper: { intervalMs: 50, limit: 100 },
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  it('reclaims an expired lease exactly once even with two replicas running', async () => {
    const taskId = await seedExpiredLease(db);

    const a = makeScheduler('replica-a');
    const b = makeScheduler('replica-b');
    a.start();
    b.start();

    await pollUntil(async () => (await taskStatus(db, taskId)) === 'pending', {
      timeoutMs: 5_000,
    });

    // Give the non-leader replica's reaper (if it were mistakenly running)
    // a real chance to double-reclaim before asserting it didn't.
    await sleep(300);
    expect(await taskStatus(db, taskId)).toBe('pending');
  });

  it('the survivor resumes reaping after the leader is killed', async () => {
    const a = makeScheduler('replica-a');
    const b = makeScheduler('replica-b');
    a.start();
    b.start();

    await pollUntil(async () => a.isLeader || b.isLeader, { timeoutMs: 5_000 });
    const [leader, survivor] = a.isLeader ? [a, b] : [b, a];

    // Kill the leader mid-flight, like the demo's `kill -9`.
    await leader.stop();
    await pollUntil(async () => survivor.isLeader, { timeoutMs: 5_000 });

    const taskId = await seedExpiredLease(db);
    await pollUntil(async () => (await taskStatus(db, taskId)) === 'pending', {
      timeoutMs: 5_000,
    });
  });
});
