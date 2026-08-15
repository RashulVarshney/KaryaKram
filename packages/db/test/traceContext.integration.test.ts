import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testcontainers';
import { dequeue, enqueue } from '../src/queue';

async function seedWorkflow(db: TestDatabase): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [id],
  );
  return id;
}

describe('trace_context round-trips through enqueue/dequeue', () => {
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

  afterEach(async () => {
    /* nothing to clean up beyond truncateAll */
  });

  it('carries the traceparent string given to enqueue() through to the task dequeue() returns', async () => {
    const workflowId = await seedWorkflow(db);
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    await enqueue(db.pool, { taskType: 'activity', workflowId, traceContext: traceparent });

    const [task] = await dequeue(db.pool, { workerId: 'w1', limit: 1, leaseSeconds: 30 });
    expect(task?.traceContext).toBe(traceparent);
  });

  it('is null when no trace context was given — a legitimate, expected state', async () => {
    const workflowId = await seedWorkflow(db);
    await enqueue(db.pool, { taskType: 'activity', workflowId });

    const [task] = await dequeue(db.pool, { workerId: 'w1', limit: 1, leaseSeconds: 30 });
    expect(task?.traceContext).toBeNull();
  });
});
