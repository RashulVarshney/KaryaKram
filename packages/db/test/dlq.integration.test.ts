import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dequeue, enqueue, fail } from '../src/queue';
import { listDeadTasks, requeueDeadTask } from '../src/dlq';
import { startTestDatabase, type TestDatabase } from './testcontainers';

async function createWorkflow(db: TestDatabase): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [id],
  );
  return id;
}

async function deadLetter(db: TestDatabase, workflowId: string, maxAttempts = 1): Promise<string> {
  const enqueued = await enqueue(db.pool, { taskType: 'activity', workflowId, maxAttempts });
  if (!enqueued) throw new Error('unreachable');
  const [task] = await dequeue(db.pool, { workerId: 'looper', limit: 1, leaseSeconds: 30 });
  if (!task) throw new Error('unreachable');
  await fail(db.pool, {
    taskId: task.id,
    workerId: 'looper',
    error: 'boom',
    attempt: task.attempt,
  });
  return task.id;
}

describe('DLQ surfacing', () => {
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

  it('lists dead tasks with their last error', async () => {
    const workflowId = await createWorkflow(db);
    const taskId = await deadLetter(db, workflowId);

    const dead = await listDeadTasks(db.pool);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.id).toBe(taskId);
    expect(dead[0]?.lastError).toBe('boom');
    expect(dead[0]?.workflowId).toBe(workflowId);
  });

  it('does not list pending or completed tasks', async () => {
    const workflowId = await createWorkflow(db);
    await enqueue(db.pool, { taskType: 'activity', workflowId });

    const dead = await listDeadTasks(db.pool);
    expect(dead).toHaveLength(0);
  });

  it('requeueDeadTask puts a dead task back to pending with a clean attempt count', async () => {
    const workflowId = await createWorkflow(db);
    const taskId = await deadLetter(db, workflowId);

    const applied = await requeueDeadTask(db.pool, { taskId });
    expect(applied).toBe(true);

    const { rows } = await db.pool.query<{ status: string; attempt: number }>(
      'SELECT status, attempt FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempt).toBe(0);

    // And it's dequeue-able again.
    const [task] = await dequeue(db.pool, { workerId: 'w', limit: 1, leaseSeconds: 30 });
    expect(task?.id).toBe(taskId);
  });

  it('requeueDeadTask on a task that is not dead is a no-op', async () => {
    const workflowId = await createWorkflow(db);
    const enqueued = await enqueue(db.pool, { taskType: 'activity', workflowId });
    if (!enqueued) throw new Error('unreachable');

    const applied = await requeueDeadTask(db.pool, { taskId: enqueued.id });
    expect(applied).toBe(false);
  });
});
