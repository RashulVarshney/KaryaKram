import http, { type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * One registry per process, one `/metrics` endpoint per process — plain
 * `node:http`, not Fastify, so worker/scheduler processes (which have no
 * other reason to run an HTTP server) don't gain a heavy dependency just
 * to expose a scrape target. See docs/07-observability.md.
 */
export class MetricsServer {
  readonly registry = new Registry();
  private server: Server | null = null;

  start(port: number): void {
    this.server = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        this.registry
          .metrics()
          .then((body) => {
            res.writeHead(200, { 'Content-Type': this.registry.contentType });
            res.end(body);
          })
          .catch((err: unknown) => {
            res.writeHead(500);
            res.end(String(err));
          });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.server.listen(port);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export interface TaskMetrics {
  tasksDequeuedTotal: Counter<'task_type'>;
  tasksCompletedTotal: Counter<'task_type'>;
  tasksFailedTotal: Counter<'task_type'>;
  tasksReclaimedTotal: Counter<string>;
  taskWaitSeconds: Histogram<'task_type'>;
  queueDepth: Gauge<'status'>;
}

/** Registers this milestone's fixed set of metric definitions on `registry`. See docs/07-observability.md. */
export function createTaskMetrics(registry: Registry): TaskMetrics {
  const tasksDequeuedTotal = new Counter({
    name: 'karyakram_tasks_dequeued_total',
    help: 'Tasks leased by dequeue(), by task type',
    labelNames: ['task_type'] as const,
    registers: [registry],
  });
  const tasksCompletedTotal = new Counter({
    name: 'karyakram_tasks_completed_total',
    help: 'Tasks that finished successfully, by task type',
    labelNames: ['task_type'] as const,
    registers: [registry],
  });
  const tasksFailedTotal = new Counter({
    name: 'karyakram_tasks_failed_total',
    help: 'Tasks whose handler threw, by task type',
    labelNames: ['task_type'] as const,
    registers: [registry],
  });
  const tasksReclaimedTotal = new Counter({
    name: 'karyakram_tasks_reclaimed_total',
    help: 'Expired leases put back to pending by the reaper',
    registers: [registry],
  });
  const taskWaitSeconds = new Histogram({
    name: 'karyakram_task_wait_seconds',
    help: 'Time between a task being created and a worker leasing it — the metric LISTEN/NOTIFY exists to shrink',
    labelNames: ['task_type'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const queueDepth = new Gauge({
    name: 'karyakram_queue_depth',
    help: 'Current task count by status — published only by the current leader, see docs/06-scheduler.md',
    labelNames: ['status'] as const,
    registers: [registry],
  });

  return {
    tasksDequeuedTotal,
    tasksCompletedTotal,
    tasksFailedTotal,
    tasksReclaimedTotal,
    taskWaitSeconds,
    queueDepth,
  };
}
