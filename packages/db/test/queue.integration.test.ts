import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { complete, dequeue, enqueue, fail, heartbeat, reclaimExpired } from '../src/queue';
import { startTestDatabase, type TestDatabase } from './testcontainers';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createWorkflow(db: TestDatabase): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [id],
  );
  return id;
}

describe('queue.ts against real Postgres', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('heartbeat', () => {
    it('extends a lease so it is not reclaimed', async () => {
      const workflowId = await createWorkflow(db);
      await enqueue(db.pool, { taskType: 'activity', workflowId });

      const [task] = await dequeue(db.pool, { workerId: 'w1', limit: 1, leaseSeconds: 1 });
      expect(task).toBeDefined();
      if (!task) throw new Error('unreachable');

      const applied = await heartbeat(db.pool, {
        taskIds: [task.id],
        workerId: 'w1',
        leaseSeconds: 5,
      });
      expect(applied).toBe(1);

      // Original 1s lease would have expired by now; the heartbeat should
      // have pushed it out another 5s from the heartbeat call.
      await sleep(1_500);
      const reclaimed = await reclaimExpired(db.pool, { limit: 100 });
      expect(reclaimed).not.toContain(task.id);

      const { rows } = await db.pool.query<{ status: string }>(
        'SELECT status FROM tasks WHERE id = $1',
        [task.id],
      );
      expect(rows[0]?.status).toBe('leased');
    });

    it('a lease without heartbeats expires and gets reclaimed', async () => {
      const workflowId = await createWorkflow(db);
      await enqueue(db.pool, { taskType: 'activity', workflowId });

      const [task] = await dequeue(db.pool, { workerId: 'w1', limit: 1, leaseSeconds: 1 });
      expect(task).toBeDefined();
      if (!task) throw new Error('unreachable');

      await sleep(1_200);
      const reclaimed = await reclaimExpired(db.pool, { limit: 100 });
      expect(reclaimed).toContain(task.id);

      const { rows } = await db.pool.query<{ status: string; leased_by: string | null }>(
        'SELECT status, leased_by FROM tasks WHERE id = $1',
        [task.id],
      );
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.leased_by).toBeNull();
    });
  });

  it('stolen-lease guard: original owner cannot complete or heartbeat after reclaim', async () => {
    const workflowId = await createWorkflow(db);
    await enqueue(db.pool, { taskType: 'activity', workflowId });

    const [task] = await dequeue(db.pool, { workerId: 'worker-a', limit: 1, leaseSeconds: 1 });
    expect(task).toBeDefined();
    if (!task) throw new Error('unreachable');

    await sleep(1_200);
    const reclaimed = await reclaimExpired(db.pool, { limit: 100 });
    expect(reclaimed).toContain(task.id);

    const [relet] = await dequeue(db.pool, { workerId: 'worker-b', limit: 1, leaseSeconds: 30 });
    expect(relet?.id).toBe(task.id);

    const staleComplete = await complete(db.pool, { taskId: task.id, workerId: 'worker-a' });
    expect(staleComplete).toBe(false);

    const staleHeartbeat = await heartbeat(db.pool, {
      taskIds: [task.id],
      workerId: 'worker-a',
      leaseSeconds: 30,
    });
    expect(staleHeartbeat).toBe(0);

    const freshComplete = await complete(db.pool, { taskId: task.id, workerId: 'worker-b' });
    expect(freshComplete).toBe(true);
  });

  it('workflow-task uniqueness: two concurrent enqueues yield exactly one row', async () => {
    const workflowId = await createWorkflow(db);

    const [a, b] = await Promise.all([
      enqueue(db.pool, { taskType: 'workflow', workflowId }),
      enqueue(db.pool, { taskType: 'workflow', workflowId }),
    ]);

    const nonNull = [a, b].filter((r) => r !== null);
    expect(nonNull).toHaveLength(1);

    const { rows } = await db.pool.query(
      `SELECT id FROM tasks WHERE workflow_id = $1 AND task_type = 'workflow'`,
      [workflowId],
    );
    expect(rows).toHaveLength(1);
  });

  it('dead-letters a task after exactly max_attempts failures', async () => {
    const workflowId = await createWorkflow(db);
    const maxAttempts = 3;
    const enqueued = await enqueue(db.pool, { taskType: 'activity', workflowId, maxAttempts });
    expect(enqueued).not.toBeNull();
    if (!enqueued) throw new Error('unreachable');

    for (let i = 1; i <= maxAttempts; i++) {
      const [task] = await dequeue(db.pool, { workerId: 'looper', limit: 1, leaseSeconds: 30 });
      expect(task).toBeDefined();
      if (!task) throw new Error('unreachable');
      expect(task.attempt).toBe(i);

      const applied = await fail(db.pool, {
        taskId: task.id,
        workerId: 'looper',
        error: `attempt ${i} failed`,
        attempt: task.attempt,
      });
      expect(applied).toBe(true);

      const { rows } = await db.pool.query<{ status: string; last_error: string }>(
        'SELECT status, last_error FROM tasks WHERE id = $1',
        [task.id],
      );
      const row = rows[0];
      expect(row).toBeDefined();

      if (i < maxAttempts) {
        expect(row?.status).toBe('pending');
        // Skip the real backoff wait — M1 uses a fixed 30s constant
        // (TODO(M4): real backoff+jitter), and this test is about the
        // attempt/dead-letter bookkeeping, not the backoff timing.
        await db.pool.query('UPDATE tasks SET run_after = now() WHERE id = $1', [task.id]);
      } else {
        expect(row?.status).toBe('dead');
        expect(row?.last_error).toBe(`attempt ${i} failed`);
      }
    }

    // A crash-looping task must not retry forever past max_attempts.
    const nextDequeue = await dequeue(db.pool, { workerId: 'looper', limit: 10, leaseSeconds: 30 });
    expect(nextDequeue).toHaveLength(0);
  });
});
