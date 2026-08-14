/**
 * M1 exit-criteria demo: resets the DB, seeds 10,000 tasks, spawns 8
 * worker processes + a reaper, kills two workers mid-run, waits for
 * everything to drain, and prints a summary proving zero double-execution
 * and full completion despite the crash.
 *
 * Run against the docker-compose Postgres (`docker compose up -d` first),
 * not testcontainers — this is meant to be the same one-command proof a
 * reader can watch happen against the real dev database.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createPoolFromEnv } from '@karyakram/db';

const TASK_COUNT = 10_000;
const WORKER_COUNT = 8;
const WORKERS_TO_KILL = 2;
const RESULTS_TABLE = 'demo_results';

const WORKER_SDK_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
// Deliberately NOT node_modules/.bin/tsx: that CLI shim spawns a *separate*
// Node process to run the script, so killing the shim's PID doesn't
// actually kill the worker — it keeps running, invisibly, in the
// background. `--import`-ing tsx's loader runs everything in this one
// process instead, so SIGKILL below actually reaches the worker.
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Proc {
  name: string;
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
}

function spawnTsx(name: string, script: string, env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, script], {
    cwd: WORKER_SDK_DIR,
    env,
  });

  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  // Surface worker/reaper errors without drowning the demo output in
  // routine per-task "completed" logs. Also watch for the startup log
  // line — tsx transpilation + pool connection isn't instant, and killing
  // a worker before it's actually up would strand nothing at all, making
  // the crash-recovery proof below meaningless.
  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { level: number; msg?: string };
        if (parsed.msg === 'worker starting' || parsed.msg === 'reaper starting') resolveReady();
        if (parsed.level >= 40) console.log(`  [${name}] ${parsed.msg}`);
      } catch {
        // non-JSON output, ignore
      }
    }
  });
  return { name, child, ready };
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();

  console.log('== KaryaKram M1 demo ==\n');
  console.log('1. Resetting DB...');
  await pool.query('TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE');
  await pool.query(`DROP TABLE IF EXISTS ${RESULTS_TABLE}`);
  await pool.query(
    `CREATE TABLE ${RESULTS_TABLE} (task_id BIGINT PRIMARY KEY, worker_id TEXT NOT NULL)`,
  );

  console.log(`2. Seeding ${TASK_COUNT} tasks...`);
  const workflowId = randomUUID();
  await pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [workflowId],
  );
  await pool.query(
    `INSERT INTO tasks (task_type, workflow_id, queue, status, run_after, max_attempts)
     SELECT 'activity', $1, 'default', 'pending', now(), 3
     FROM generate_series(1, $2)`,
    [workflowId, TASK_COUNT],
  );

  console.log(`3. Spawning ${WORKER_COUNT} workers + 1 reaper...`);
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const reaper = spawnTsx('reaper', 'src/bin/run-reaper.ts', {
    ...process.env,
    REAPER_INTERVAL_MS: '500',
  });

  const workers: Proc[] = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    workers.push(
      spawnTsx(`worker-${i}`, 'src/bin/task-runner.ts', {
        ...process.env,
        WORKER_ID: `worker-${i}`,
        HANDLER_MODE: 'record',
        RESULTS_TABLE,
        MAX_CONCURRENCY: '25',
        LEASE_SECONDS: '3',
        HEARTBEAT_INTERVAL_MS: '1000',
        POLL_INTERVAL_MS: '20',
        // A handler slow enough that the very first dequeued batch is
        // still in flight (mid-sleep) when we SIGKILL below, which fires
        // before this sleep could have completed — without this, the kill
        // can land in a gap between batches where nothing was truly
        // stranded, and "reclaimed & retried" would misleadingly read 0.
        HANDLER_SLEEP_MS: '400',
      }),
    );
  }

  // Wait for every process to actually be up before doing anything time-
  // sensitive — startup (tsx transpile + pool connect) can take a while,
  // and killing a worker before it ever dequeued anything would strand
  // nothing at all.
  const readyTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('workers/reaper did not become ready within 15s')), 15_000);
  });
  await Promise.race([Promise.all([reaper.ready, ...workers.map((w) => w.ready)]), readyTimeout]);
  // Give the doomed workers a moment to actually dequeue and start their
  // first (slow) batch before we pull the rug — this is what makes the
  // kill land mid-handler instead of in an idle gap.
  await sleep(150);
  console.log(`4. Killing ${WORKERS_TO_KILL} workers with SIGKILL mid-run...`);
  for (let i = 0; i < WORKERS_TO_KILL; i++) {
    console.log(`   killing worker-${i} (pid ${workers[i]!.child.pid})`);
    workers[i]!.child.kill('SIGKILL');
  }

  console.log('5. Waiting for the survivors to drain the queue...');
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM ${RESULTS_TABLE}`);
    const completedCount = Number(rows[0]?.count ?? 0);
    if (completedCount >= TASK_COUNT) break;
    if (Date.now() > deadline) {
      console.error(`Timed out waiting for drain. Completed ${completedCount}/${TASK_COUNT}.`);
      break;
    }
    await sleep(500);
  }

  console.log('6. Shutting down survivors + reaper...');
  const survivors = workers.slice(WORKERS_TO_KILL);
  for (const p of [...survivors, reaper]) p.child.kill('SIGTERM');
  await Promise.all(
    [...survivors, reaper].map(
      (p) => new Promise<void>((resolve) => p.child.on('exit', () => resolve())),
    ),
  );

  const { rows: totalRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM ${RESULTS_TABLE}`,
  );
  const { rows: distinctRows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT task_id) FROM ${RESULTS_TABLE}`,
  );
  const { rows: perWorkerRows } = await pool.query<{ worker_id: string; count: string }>(
    `SELECT worker_id, count(*) FROM ${RESULTS_TABLE} GROUP BY worker_id ORDER BY worker_id`,
  );
  const { rows: retriedRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM tasks WHERE attempt > 1`,
  );
  const { rows: statusRows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*) FROM tasks GROUP BY status`,
  );

  const total = Number(totalRows[0]?.count ?? 0);
  const distinct = Number(distinctRows[0]?.count ?? 0);
  const duplicates = total - distinct;

  console.log('\n== Summary ==');
  console.log(`Total tasks seeded:        ${TASK_COUNT}`);
  console.log(`Total results recorded:    ${total}`);
  console.log(`Distinct tasks completed:  ${distinct}`);
  console.log(
    `Duplicate result rows:     ${duplicates} (must be 0 — a unique constraint on task_id would have thrown otherwise)`,
  );
  console.log(
    `Tasks reclaimed & retried: ${retriedRows[0]?.count ?? 0} (attempt > 1 — expected, from the 2 killed workers)`,
  );
  console.log('\nPer-worker completions:');
  for (const row of perWorkerRows) {
    console.log(`  ${row.worker_id}: ${row.count}`);
  }
  console.log('\nFinal task status breakdown:');
  for (const row of statusRows) {
    console.log(`  ${row.status}: ${row.count}`);
  }

  const ok = distinct === TASK_COUNT && duplicates === 0;
  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: ${TASK_COUNT} tasks, zero double-execution, survived 2 killed workers.`,
  );

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
