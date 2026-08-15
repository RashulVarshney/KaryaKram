import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { getEvents, getEventsSince, listWorkflowExecutions } from '@karyakram/db';
import { reserveChargeShip, startWorkflow } from '@karyakram/worker-sdk';

export interface BuildServerOptions {
  pool: Pool;
  /** How often the SSE endpoint polls for new events — see docs/05-control-plane.md. */
  ssePollIntervalMs?: number;
}

/**
 * Read-mostly: the only mutation is starting a workflow, included so the
 * demo is self-contained. Every actual state change still goes through
 * `startWorkflow`/`appendEvents`, reused verbatim — this layer adds no
 * new way to mutate a workflow.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { pool, ssePollIntervalMs = 300 } = options;
  const app = Fastify({ logger: false });

  void app.register(cors, { origin: true });

  app.get('/workflows', async () => {
    const workflows = await listWorkflowExecutions(pool);
    return { workflows };
  });

  app.get<{ Params: { id: string } }>('/workflows/:id/events', async (request) => {
    const events = await getEvents(pool, request.params.id);
    return { events };
  });

  app.post<{ Body: { orderId?: string } }>('/workflows', async (request) => {
    const orderId = request.body.orderId ?? `order-${Date.now()}`;
    const workflowId = await startWorkflow(pool, reserveChargeShip, { orderId });
    return { workflowId };
  });

  // SSE: polls for events past `since`, forwards them as they appear.
  // Deliberately polling, not LISTEN/NOTIFY — see docs/05-control-plane.md.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/workflows/:id/stream',
    (request, reply) => {
      const { id: workflowId } = request.params;
      let lastSeq = request.query.since ? Number(request.query.since) : 0;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const interval = setInterval(() => {
        void (async () => {
          const events = await getEventsSince(pool, workflowId, lastSeq);
          for (const stored of events) {
            lastSeq = stored.seq;
            reply.raw.write(`data: ${JSON.stringify(stored)}\n\n`);
          }
        })();
      }, ssePollIntervalMs);

      request.raw.on('close', () => {
        clearInterval(interval);
      });

      // Tells Fastify this response is being handled manually (the raw
      // stream above), so it doesn't also try to send its own reply.
      reply.hijack();
    },
  );

  return app;
}
