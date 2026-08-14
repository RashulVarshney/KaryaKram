/**
 * M3 exit-criteria demo: starts reserve -> charge -> ship, `kill -9`'s
 * the app process right after `reserve` completes (before `charge`
 * starts), starts a fresh app process, and proves the workflow still
 * reaches COMPLETED with `reserve`'s activity function having executed
 * exactly once — not just that the event log looks right.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { foldEvents } from '@karyakram/core';
import { createPoolFromEnv, getEvents } from '@karyakram/db';
import {
  ensureActivityExecutionsTable,
  getActivityExecutionCount,
  reserveChargeShip,
} from '../examples/reserveChargeShip';
import { startWorkflow } from '../startWorkflow';

const WORKER_SDK_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Proc {
  child: ChildProcessWithoutNullStreams;
  readyCount: number;
}

function spawnApp(workerId: string): Proc {
  const proc: Proc = {
    child: spawn(process.execPath, ['--import', TSX_LOADER, 'src/bin/reserve-charge-ship-app.ts'], {
      cwd: WORKER_SDK_DIR,
      // Short lease + frequent heartbeats: a reaper is running (below)
      // because it has to be — completing an activity immediately
      // enqueues a new `workflow` task, which this same process may
      // start leasing right away, so the kill can land on either task
      // type. Whichever one it hits needs to be reclaimed quickly.
      env: {
        ...process.env,
        WORKER_ID: workerId,
        LEASE_SECONDS: '2',
        HEARTBEAT_INTERVAL_MS: '500',
        POLL_INTERVAL_MS: '20',
      },
    }),
    readyCount: 0,
  };
  proc.child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { level: number; msg?: string };
        if (parsed.msg === 'worker starting') proc.readyCount++;
        if (parsed.level >= 40) console.log(`  [${workerId}] ${parsed.msg}`);
      } catch {
        // non-JSON output, ignore
      }
    }
  });
  return proc;
}

async function waitForReady(proc: Proc): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (proc.readyCount < 2) {
    if (Date.now() > deadline) throw new Error('app did not become ready in time');
    await sleep(25);
  }
}

function spawnReaper(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', TSX_LOADER, 'src/bin/run-reaper.ts'], {
    cwd: WORKER_SDK_DIR,
    env: { ...process.env, REAPER_INTERVAL_MS: '300' },
  });
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();

  console.log('== KaryaKram M3 demo ==\n');
  console.log('1. Resetting DB...');
  await pool.query('TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE');
  await pool.query('DROP TABLE IF EXISTS activity_executions');
  await ensureActivityExecutionsTable(pool);

  console.log('2. Starting workflow (reserve -> charge -> ship)...');
  const workflowId = await startWorkflow(pool, reserveChargeShip, { orderId: 'demo-order' });
  console.log(`   workflowId = ${workflowId}`);

  console.log('3. Starting the reaper and worker process #1...');
  const reaper = spawnReaper();
  const first = spawnApp('app-1');
  await waitForReady(first);

  console.log("4. Waiting for 'reserve' to complete...");
  const deadline1 = Date.now() + 10_000;
  for (;;) {
    const events = await getEvents(pool, workflowId);
    const state = foldEvents(events);
    if (
      Object.values(state.activities).some(
        (a) => a.activityType === 'reserve' && a.status === 'COMPLETED',
      )
    ) {
      break;
    }
    if (Date.now() > deadline1) throw new Error("timed out waiting for 'reserve' to complete");
    await sleep(10);
  }

  console.log(`5. Killing worker process #1 (pid ${first.child.pid}) with SIGKILL...`);
  first.child.kill('SIGKILL');

  console.log('6. Starting a fresh worker process #2...');
  const second = spawnApp('app-2');
  await waitForReady(second);

  console.log('7. Waiting for the workflow to complete via the fresh worker...');
  const deadline2 = Date.now() + 15_000;
  for (;;) {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id = $1',
      [workflowId],
    );
    if (rows[0]?.status === 'COMPLETED' || Date.now() > deadline2) break;
    await sleep(50);
  }
  const { rows: finalStatusRows } = await pool.query<{ status: string }>(
    'SELECT status FROM workflow_executions WHERE id = $1',
    [workflowId],
  );
  const status = finalStatusRows[0]?.status ?? 'RUNNING';

  second.child.kill('SIGTERM');
  reaper.kill('SIGTERM');

  console.log('\n8. Event log (workflow_events, seq order):');
  const events = await getEvents(pool, workflowId);
  for (const { seq, event } of events) {
    console.log(
      `   ${seq}. ${event.type}${'activityType' in event ? ` (${event.activityType})` : ''}`,
    );
  }

  const state = foldEvents(events);
  console.log('\n9. Activity execution counts (proves reserve never re-ran):');
  const reserveCount = await getActivityExecutionCount(pool, 'reserve');
  const chargeCount = await getActivityExecutionCount(pool, 'charge');
  const shipCount = await getActivityExecutionCount(pool, 'ship');
  console.log(`   reserve: ${reserveCount}`);
  console.log(`   charge:  ${chargeCount}`);
  console.log(`   ship:    ${shipCount}`);

  const allCompleted = Object.values(state.activities).every((a) => a.status === 'COMPLETED');
  const ok =
    status === 'COMPLETED' &&
    Object.keys(state.activities).length === 3 &&
    allCompleted &&
    reserveCount === 1;

  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: workflow completed after a mid-workflow kill -9, ` +
      "'reserve' executed exactly once despite the crash.",
  );

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
