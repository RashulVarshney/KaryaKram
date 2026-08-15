import { randomUUID } from 'node:crypto';
import { enqueue } from '@karyakram/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { Worker } from '../src/worker';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  check: () => boolean,
  { timeoutMs, intervalMs = 5 }: { timeoutMs: number; intervalMs?: number },
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

describe('Worker: LISTEN/NOTIFY wake-up', () => {
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

  it('wakes up and dispatches almost immediately instead of waiting out a backed-off poll delay', async () => {
    let handled = 0;
    worker = new Worker(
      db.pool,
      {
        maxConcurrency: 1,
        pollIntervalMs: 50,
        maxPollIntervalMs: 2_000,
        notifyConnectionString: db.connectionString,
      },
      async () => {
        handled++;
      },
    );
    worker.start();

    // Let the poll loop go idle and back off toward maxPollIntervalMs
    // before there's anything to find.
    await sleep(500);

    const workflowId = await seedWorkflow(db);
    const enqueuedAt = Date.now();
    await enqueue(db.pool, { taskType: 'activity', workflowId });

    await pollUntil(() => handled === 1, { timeoutMs: 2_000 });
    const latencyMs = Date.now() - enqueuedAt;

    // Comfortably under maxPollIntervalMs (2000ms) — proves the notify
    // path fired rather than the worker simply happening to poll soon.
    expect(latencyMs).toBeLessThan(500);
  });

  it('keeps working via polling alone if the notify connection was never available', async () => {
    let handled = 0;
    worker = new Worker(
      db.pool,
      { maxConcurrency: 1, pollIntervalMs: 20, maxPollIntervalMs: 200 },
      async () => {
        handled++;
      },
    );
    worker.start();

    const workflowId = await seedWorkflow(db);
    await enqueue(db.pool, { taskType: 'activity', workflowId });

    await pollUntil(() => handled === 1, { timeoutMs: 2_000 });
    expect(handled).toBe(1);
  });
});
