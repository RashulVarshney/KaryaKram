/**
 * M7 exit demo: starts the observability-instrumented scheduler + a
 * reserve->charge->ship app process, points both at the Jaeger/Prometheus
 * stack (`docker compose --profile observability up`, must already be
 * running), starts a handful of real workflows to generate traffic, and
 * prints where to look. Doesn't assert pass/fail like M1-M6's demos —
 * the actual proof here is visual (Grafana/Jaeger), same honest framing
 * M5 used for its browser UI. See docs/07-observability.md.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createPoolFromEnv } from '@karyakram/db';
import { reserveChargeShip, startWorkflow } from '@karyakram/worker-sdk';

const SCHEDULER_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SCHEDULER_DIR, '..', '..');
const WORKER_SDK_DIR = path.join(REPO_ROOT, 'packages', 'worker-sdk');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

const OTLP_ENDPOINT = 'http://localhost:4318/v1/traces';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Proc {
  name: string;
  child: ChildProcessWithoutNullStreams;
  readyCount: number;
}

function spawnLogged(name: string, cwd: string, script: string, env: NodeJS.ProcessEnv): Proc {
  const proc: Proc = {
    name,
    child: spawn(process.execPath, ['--import', TSX_LOADER, script], { cwd, env }),
    readyCount: 0,
  };
  proc.child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { level: number; msg?: string };
        if (parsed.msg === 'scheduler starting' || parsed.msg === 'worker starting') {
          proc.readyCount++;
        }
        if (parsed.level >= 40) console.log(`  [${name}] ${parsed.msg}`);
      } catch {
        // non-JSON output, ignore
      }
    }
  });
  proc.child.stderr.on('data', (chunk: Buffer) => {
    console.error(`  [${name}] ${chunk.toString('utf8').trim()}`);
  });
  return proc;
}

async function waitForReady(proc: Proc, expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (proc.readyCount < expected) {
    if (Date.now() > deadline) throw new Error(`${proc.name} did not become ready in time`);
    await sleep(25);
  }
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();

  console.log('== KaryaKram M7 demo ==\n');
  console.log('1. Resetting DB...');
  await pool.query('TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE');

  console.log('2. Starting the instrumented scheduler + reserve->charge->ship app...');
  const scheduler = spawnLogged('scheduler', SCHEDULER_DIR, 'src/bin/run-scheduler.ts', {
    ...process.env,
    SCHEDULER_ID: 'demo-m7-scheduler',
    METRICS_PORT: '9101',
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT,
    REAPER_INTERVAL_MS: '1000',
  });
  const app = spawnLogged('app', WORKER_SDK_DIR, 'src/bin/reserve-charge-ship-app.ts', {
    ...process.env,
    WORKER_ID: 'demo-m7',
    METRICS_PORT: '9102',
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT,
    NOTIFY_CONNECTION_STRING: process.env['DATABASE_URL'],
  });
  await Promise.all([waitForReady(scheduler, 1), waitForReady(app, 2)]);

  console.log('3. Starting 5 reserve -> charge -> ship workflows to generate traffic...');
  for (let i = 0; i < 5; i++) {
    const workflowId = await startWorkflow(pool, reserveChargeShip, {
      orderId: `order-${String(i)}`,
    });
    console.log(`   started ${workflowId}`);
    await sleep(300);
  }

  console.log('\n4. Waiting a few seconds for traces/metrics to flush and Prometheus to scrape...');
  await sleep(6_000);

  console.log(`
== Where to look ==
  Grafana (queue depth / task rates / wait-time percentiles): http://localhost:3000
  Jaeger (search for service "worker-demo-m7" — one trace per workflow,
    spanning both its activity and workflow-replay workers): http://localhost:16686
  Raw Prometheus metrics:
    http://localhost:9101/metrics  (scheduler — queue depth, reclaim count)
    http://localhost:9102/metrics  (app — dequeue/complete/fail counts, wait-time histogram)

This demo doesn't assert pass/fail — the actual proof is visual. Press Ctrl+C to stop.
`);

  const shutdown = (): void => {
    scheduler.child.kill('SIGTERM');
    app.child.kill('SIGTERM');
    void pool.end().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
