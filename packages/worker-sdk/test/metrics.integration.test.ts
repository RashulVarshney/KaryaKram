import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { enqueue } from '@karyakram/db';
import { createTaskMetrics } from '@karyakram/observability';
import { Registry } from 'prom-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { Worker } from '../src/worker';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  check: () => boolean,
  { timeoutMs, intervalMs = 10 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: condition never became true in time');
    await sleep(intervalMs);
  }
}

async function seedWorkflow(db: TestDatabase): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [id],
  );
  return id;
}

describe('Worker: metrics counters actually increment at their real call sites', () => {
  let db: TestDatabase;
  let worker: Worker | null = null;

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
    if (worker) await worker.stop();
    worker = null;
  });

  it('increments dequeued/completed on success and failed on a thrown handler', async () => {
    const registry = new Registry();
    const metrics = createTaskMetrics(registry);
    const tracer = trace.getTracer('test'); // no provider registered — a no-op tracer, exactly enough to exercise the span-wrapping code path

    let callCount = 0;
    worker = new Worker(
      db.pool,
      { maxConcurrency: 1, pollIntervalMs: 20, maxPollIntervalMs: 200 },
      async () => {
        callCount++;
        if (callCount === 2) throw new Error('forced failure for the metrics test');
      },
      undefined,
      { tracer, metrics },
    );
    worker.start();

    const workflowIdA = await seedWorkflow(db);
    await enqueue(db.pool, { taskType: 'activity', workflowId: workflowIdA });
    await pollUntil(() => callCount === 1, { timeoutMs: 2_000 });

    const workflowIdB = await seedWorkflow(db);
    await enqueue(db.pool, { taskType: 'activity', workflowId: workflowIdB });
    await pollUntil(() => callCount === 2, { timeoutMs: 2_000 });

    // Give the failed dispatch's fail()/metric increment a moment to land.
    await sleep(100);

    const body = await registry.metrics();
    expect(body).toMatch(/karyakram_tasks_dequeued_total\{task_type="activity"\} 2/);
    expect(body).toMatch(/karyakram_tasks_completed_total\{task_type="activity"\} 1/);
    expect(body).toMatch(/karyakram_tasks_failed_total\{task_type="activity"\} 1/);
    expect(body).toContain('karyakram_task_wait_seconds_bucket');
  });
});
