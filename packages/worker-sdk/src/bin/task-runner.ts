/**
 * Generic worker process entrypoint, driven entirely by env vars, so
 * integration tests and the M1 demo can spawn *real* OS processes
 * (`tsx src/bin/task-runner.ts`) with different handler behaviors without
 * needing a bespoke script per test. All logging is pino JSON to stdout,
 * one line per event — tests parse it directly rather than needing a
 * separate readiness protocol.
 */
import { createPoolFromEnv } from '@karyakram/db';
import type { Task } from '@karyakram/db';
import { installGracefulShutdown, Worker, type TaskHandler } from '../worker';
import { generateWorkerId } from '../workerId';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(name: string): string | undefined {
  return process.env[name];
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

const handlerMode = env('HANDLER_MODE') ?? 'noop';
const resultsTable = env('RESULTS_TABLE') ?? 'results';
const handlerSleepMs = envInt('HANDLER_SLEEP_MS', 0);
const workerId = env('WORKER_ID') ?? generateWorkerId();

const pool = createPoolFromEnv();

function makeHandler(): TaskHandler {
  switch (handlerMode) {
    case 'noop':
      return async () => {
        if (handlerSleepMs > 0) await sleep(handlerSleepMs);
      };

    case 'record':
      // Requires a `<resultsTable>(task_id BIGINT UNIQUE, worker_id TEXT)`
      // table set up by the test. Used for the no-double-dispatch and
      // crash-recovery cases: a unique violation here is a real bug.
      return async (task: Task) => {
        if (handlerSleepMs > 0) await sleep(handlerSleepMs);
        await pool.query(`INSERT INTO ${resultsTable} (task_id, worker_id) VALUES ($1, $2)`, [
          task.id,
          workerId,
        ]);
      };

    case 'record-interval':
      // Requires a `<resultsTable>(task_id BIGINT, worker_id TEXT,
      // started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)` table, no
      // uniqueness constraint — this mode is used specifically to prove
      // the same task CAN run more than once (at-least-once) but never
      // *concurrently* with itself.
      return async (task: Task) => {
        const startedAt = new Date();
        if (handlerSleepMs > 0) await sleep(handlerSleepMs);
        const finishedAt = new Date();
        await pool.query(
          `INSERT INTO ${resultsTable} (task_id, worker_id, started_at, finished_at) VALUES ($1, $2, $3, $4)`,
          [task.id, workerId, startedAt, finishedAt],
        );
      };

    default:
      throw new Error(`Unknown HANDLER_MODE: ${handlerMode}`);
  }
}

const worker = new Worker(
  pool,
  {
    workerId,
    queue: env('QUEUE'),
    maxConcurrency: envInt('MAX_CONCURRENCY', 4),
    leaseSeconds: envInt('LEASE_SECONDS', 30),
    heartbeatIntervalMs: envInt('HEARTBEAT_INTERVAL_MS', 10_000),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 100),
    maxPollIntervalMs: envInt('MAX_POLL_INTERVAL_MS', 2_000),
    drainTimeoutMs: envInt('DRAIN_TIMEOUT_MS', 30_000),
    notifyConnectionString: env('NOTIFY_CONNECTION_STRING'),
  },
  makeHandler(),
);

installGracefulShutdown(worker, (code) => {
  void pool.end().finally(() => process.exit(code));
});

worker.start();
