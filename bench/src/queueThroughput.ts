/**
 * The first genuinely measured performance numbers in this repository.
 * Not k6 — see docs/07-observability.md's "the bench harness isn't k6"
 * section for why: k6 has no first-class Postgres support, and this
 * benchmark was never an HTTP surface to begin with.
 *
 * Two phases, run once with workers polling only and once with M6's
 * `LISTEN/NOTIFY` enabled:
 *
 *   - Throughput: seed N tasks upfront (M1's demo shape), spawn K real
 *     worker processes, time how long the queue takes to drain.
 *   - Queueing latency: start workers idle first (so their poll backoff
 *     climbs toward its max, same as a quiet production queue), then
 *     trickle tasks in one at a time and measure task-wait-time
 *     (enqueue -> lease) percentiles — the metric LISTEN/NOTIFY exists
 *     to shrink.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { Pool } from 'pg';
import { createPoolFromEnv, enqueue } from '@karyakram/db';

const THROUGHPUT_TASK_COUNT = 2_000;
const THROUGHPUT_WORKER_COUNT = 4;
const LATENCY_TASK_COUNT = 15;
// One worker, not several: with multiple independently-phased pollers,
// *someone's* next poll is always due soon regardless of backoff state,
// which dilutes exactly the signal this phase exists to measure. A
// single worker isolates the actual mechanism — see
// docs/07-observability.md.
const LATENCY_WORKER_COUNT = 1;
// Backoff (100ms, doubling, capped at maxPollIntervalMs 2000ms) reaches
// its ceiling after a cumulative 3100ms of empty polls and then holds a
// perfectly periodic 2000ms cycle. A *fixed* wait before every sample
// would land at the same phase of that cycle every single time — every
// sample would measure the same one point, not a real distribution, and
// with a small fixed wait it can land right before the next poll and
// barely show anything. So the wait is randomized across more than one
// full cycle once backoff has saturated, making the phase at which each
// task arrives effectively uniform across [0, maxPollIntervalMs) — a
// genuine wait-time distribution instead of one repeated sample. See
// docs/07-observability.md.
const LATENCY_SATURATION_MS = 3_200;
const LATENCY_RANDOM_WINDOW_MS = 4_000;

const WORKER_SDK_DIR = path.resolve(__dirname, '..', '..', 'packages', 'worker-sdk');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WorkerProc {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
}

function spawnWorker(workerId: string, notify: boolean, connectionString: string): WorkerProc {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: connectionString,
    WORKER_ID: workerId,
    HANDLER_MODE: 'record-interval',
    RESULTS_TABLE: 'bench_results',
    MAX_CONCURRENCY: '10',
    LEASE_SECONDS: '30',
    HEARTBEAT_INTERVAL_MS: '10000',
    POLL_INTERVAL_MS: '100',
    MAX_POLL_INTERVAL_MS: '2000',
  };
  if (notify) env['NOTIFY_CONNECTION_STRING'] = connectionString;

  const child = spawn(process.execPath, ['--import', TSX_LOADER, 'src/bin/task-runner.ts'], {
    cwd: WORKER_SDK_DIR,
    env,
  });
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { msg?: string };
        if (parsed.msg === 'worker starting') resolveReady();
      } catch {
        // non-JSON output, ignore
      }
    }
  });
  return { child, ready };
}

async function resetBenchState(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE');
  await pool.query('DROP TABLE IF EXISTS bench_results');
  await pool.query(
    `CREATE TABLE bench_results (
       task_id BIGINT PRIMARY KEY,
       worker_id TEXT NOT NULL,
       started_at TIMESTAMPTZ NOT NULL,
       finished_at TIMESTAMPTZ NOT NULL
     )`,
  );
}

async function seedWorkflow(pool: Pool): Promise<string> {
  const workflowId = randomUUID();
  await pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'bench', '{}'::jsonb, 'RUNNING')`,
    [workflowId],
  );
  return workflowId;
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return NaN;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)]!;
}

interface ThroughputResult {
  taskCount: number;
  seconds: number;
  tasksPerSecond: number;
}

async function runThroughputPhase(
  pool: Pool,
  connectionString: string,
  notify: boolean,
): Promise<ThroughputResult> {
  await resetBenchState(pool);
  const workflowId = await seedWorkflow(pool);
  // Bulk SQL, not `enqueue()`/`pg_notify` — every task is already
  // `pending` before any worker starts polling, so there's nothing for a
  // notification to shorten here regardless of `notify`; this phase
  // measures drain throughput, not queueing latency. See the latency
  // phase below for where `enqueue()` (and therefore the notification)
  // actually matters.
  await pool.query(
    `INSERT INTO tasks (task_type, workflow_id, queue, status, run_after, max_attempts)
     SELECT 'activity', $1, 'default', 'pending', now(), 3
     FROM generate_series(1, $2)`,
    [workflowId, THROUGHPUT_TASK_COUNT],
  );

  const workers = Array.from({ length: THROUGHPUT_WORKER_COUNT }, (_, i) =>
    spawnWorker(`bench-throughput-${i}`, notify, connectionString),
  );
  await Promise.all(workers.map((w) => w.ready));

  const start = Date.now();
  for (;;) {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM bench_results',
    );
    if (Number(rows[0]?.count ?? 0) >= THROUGHPUT_TASK_COUNT) break;
    await sleep(25);
  }
  const seconds = (Date.now() - start) / 1000;

  for (const w of workers) w.child.kill('SIGKILL');
  await sleep(100);

  return {
    taskCount: THROUGHPUT_TASK_COUNT,
    seconds,
    tasksPerSecond: THROUGHPUT_TASK_COUNT / seconds,
  };
}

interface LatencyResult {
  taskCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

async function runLatencyPhase(
  pool: Pool,
  connectionString: string,
  notify: boolean,
): Promise<LatencyResult> {
  await resetBenchState(pool);
  const workflowId = await seedWorkflow(pool);

  const workers = Array.from({ length: LATENCY_WORKER_COUNT }, (_, i) =>
    spawnWorker(`bench-latency-${i}`, notify, connectionString),
  );
  await Promise.all(workers.map((w) => w.ready));

  for (let i = 0; i < LATENCY_TASK_COUNT; i++) {
    // Randomized per-sample wait (see the constant's comment above) —
    // has to happen before every task, not once up front, since backoff
    // resets to its minimum the moment a worker finds work.
    await sleep(LATENCY_SATURATION_MS + Math.random() * LATENCY_RANDOM_WINDOW_MS);
    // Through enqueue(), not raw SQL — enqueue() is the only thing that
    // calls pg_notify. Inserting directly here would silently make
    // `notify: true` a no-op, since nothing would ever tell a listening
    // worker a task exists.
    await enqueue(pool, { taskType: 'activity', workflowId });
  }

  for (;;) {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM bench_results',
    );
    if (Number(rows[0]?.count ?? 0) >= LATENCY_TASK_COUNT) break;
    await sleep(25);
  }

  for (const w of workers) w.child.kill('SIGKILL');
  await sleep(100);

  const { rows } = await pool.query<{ wait_ms: string }>(
    `SELECT EXTRACT(EPOCH FROM (r.started_at - t.created_at)) * 1000 AS wait_ms
       FROM bench_results r JOIN tasks t ON t.id = r.task_id
      ORDER BY wait_ms`,
  );
  const waits = rows.map((r) => Number(r.wait_ms));
  // Raw samples, not just percentiles — with a sample size this small
  // (LATENCY_TASK_COUNT), percentiles alone can hide as much as they
  // show; the underlying numbers matter for reading this bench honestly.
  console.log(`    raw samples (ms): ${waits.map((w) => String(Math.round(w))).join(', ')}`);

  return {
    taskCount: LATENCY_TASK_COUNT,
    p50Ms: percentile(waits, 50),
    p95Ms: percentile(waits, 95),
    p99Ms: percentile(waits, 99),
  };
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  console.log('== KaryaKram M7 bench: polling vs. LISTEN/NOTIFY ==\n');

  console.log(
    `Throughput phase (${String(THROUGHPUT_TASK_COUNT)} tasks, ${String(THROUGHPUT_WORKER_COUNT)} workers)...`,
  );
  console.log('  polling only...');
  const throughputPolling = await runThroughputPhase(pool, connectionString, false);
  console.log('  with LISTEN/NOTIFY...');
  const throughputNotify = await runThroughputPhase(pool, connectionString, true);

  console.log(
    `\nQueueing-latency phase (${String(LATENCY_TASK_COUNT)} tasks trickled in one at a time after an idle warmup)...`,
  );
  console.log('  polling only...');
  const latencyPolling = await runLatencyPhase(pool, connectionString, false);
  console.log('  with LISTEN/NOTIFY...');
  const latencyNotify = await runLatencyPhase(pool, connectionString, true);

  console.log('\n== Results ==\n');
  console.log('Throughput (higher is better):');
  console.log(
    `  polling only:     ${throughputPolling.tasksPerSecond.toFixed(1)} tasks/sec (${throughputPolling.seconds.toFixed(2)}s for ${String(throughputPolling.taskCount)} tasks)`,
  );
  console.log(
    `  LISTEN/NOTIFY:    ${throughputNotify.tasksPerSecond.toFixed(1)} tasks/sec (${throughputNotify.seconds.toFixed(2)}s for ${String(throughputNotify.taskCount)} tasks)`,
  );

  console.log('\nQueueing latency, enqueue -> lease (lower is better):');
  console.log(
    `  polling only:     p50=${latencyPolling.p50Ms.toFixed(0)}ms  p95=${latencyPolling.p95Ms.toFixed(0)}ms  p99=${latencyPolling.p99Ms.toFixed(0)}ms`,
  );
  console.log(
    `  LISTEN/NOTIFY:    p50=${latencyNotify.p50Ms.toFixed(0)}ms  p95=${latencyNotify.p95Ms.toFixed(0)}ms  p99=${latencyNotify.p99Ms.toFixed(0)}ms`,
  );

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
