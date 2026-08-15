import { appendEvents, getEvents, withTransaction } from '@karyakram/db';
import { reserveChargeShip, startWorkflow } from '@karyakram/worker-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('packages/api HTTP surface', () => {
  let db: TestDatabase;
  let app: FastifyInstance | undefined;

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
    await app?.close();
    app = undefined;
  });

  it('GET /workflows lists real workflow_executions rows', async () => {
    app = buildServer({ pool: db.pool });
    const workflowId = await startWorkflow(db.pool, reserveChargeShip, { orderId: 'api-1' });

    const response = await app.inject({ method: 'GET', url: '/workflows' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      workflows: { id: string; workflowType: string; status: string }[];
    }>();
    expect(
      body.workflows.some((w) => w.id === workflowId && w.workflowType === 'reserve-charge-ship'),
    ).toBe(true);
  });

  it('GET /workflows/:id/events matches getEvents directly', async () => {
    app = buildServer({ pool: db.pool });
    const workflowId = await startWorkflow(db.pool, reserveChargeShip, { orderId: 'api-2' });

    const response = await app.inject({ method: 'GET', url: `/workflows/${workflowId}/events` });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ events: unknown[] }>();
    const direct = await getEvents(db.pool, workflowId);
    expect(body.events).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it('POST /workflows starts a real workflow via startWorkflow', async () => {
    app = buildServer({ pool: db.pool });

    const response = await app.inject({
      method: 'POST',
      url: '/workflows',
      payload: { orderId: 'api-3' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ workflowId: string }>();
    expect(body.workflowId).toBeTruthy();

    const events = await getEvents(db.pool, body.workflowId);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe('WorkflowStarted');
  });

  it('GET /workflows/:id/stream delivers events appended after the connection opens', async () => {
    app = buildServer({ pool: db.pool, ssePollIntervalMs: 30 });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const workflowId = await startWorkflow(db.pool, reserveChargeShip, { orderId: 'sse-1' });

    const response = await fetch(`${address}/workflows/${workflowId}/stream`);
    if (!response.body) throw new Error('unreachable: no response body');
    const reader = response.body.getReader();

    // Give the SSE connection a moment to actually be listening before
    // we append — the whole point is proving events *after* connect
    // still arrive, not racing the connection setup itself.
    await sleep(100);

    await withTransaction(db.pool, (client) =>
      appendEvents(client, {
        workflowId,
        events: [
          { type: 'ActivityScheduled', activityType: 'reserve', input: { orderId: 'sse-1' } },
        ],
      }),
    );

    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 5_000;
    while (!buffer.includes('ActivityScheduled') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }

    expect(buffer).toContain('ActivityScheduled');
    expect(buffer.startsWith('data: ')).toBe(true);

    await reader.cancel();
  }, 10_000);
});
