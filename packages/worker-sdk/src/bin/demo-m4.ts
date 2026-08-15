/**
 * M4 exit-criteria demo: starts a workflow with a durable timer, `kill
 * -9`'s *every* worker AND the reaper mid-wait (a full cluster restart,
 * not just one process), starts everything fresh, and proves the timer
 * still fires and the workflow still completes. The timer's duration is
 * short here — a real 5 minutes would just make the demo slow to run,
 * not more convincing; see docs/04-durability.md.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { foldEvents } from '@karyakram/core';
import { createPoolFromEnv, getEvents } from '@karyakram/db';
import {
  ensureTimerWorkflowExecutionsTable,
  getTimerWorkflowExecutionCount,
  timerWorkflow,
} from '../examples/timerWorkflow';
import { startWorkflow } from '../startWorkflow';

const WORKER_SDK_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Proc {
  name: string;
  child: ChildProcessWithoutNullStreams;
  readyCount: number;
}

function spawnLogged(name: string, script: string, env: NodeJS.ProcessEnv): Proc {
  const proc: Proc = {
    name,
    child: spawn(process.execPath, ['--import', TSX_LOADER, script], { cwd: WORKER_SDK_DIR, env }),
    readyCount: 0,
  };
  proc.child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { level: number; msg?: string };
        if (parsed.msg === 'worker starting' || parsed.msg === 'reaper starting') proc.readyCount++;
        if (parsed.level >= 40) console.log(`  [${name}] ${parsed.msg}`);
      } catch {
        // non-JSON output, ignore
      }
    }
  });
  return proc;
}

function spawnApp(workerId: string): Proc {
  return spawnLogged('app', 'src/bin/timer-workflow-app.ts', {
    ...process.env,
    WORKER_ID: workerId,
    LEASE_SECONDS: '3',
    HEARTBEAT_INTERVAL_MS: '500',
    POLL_INTERVAL_MS: '20',
  });
}

function spawnReaper(): Proc {
  return spawnLogged('reaper', 'src/bin/run-reaper.ts', {
    ...process.env,
    REAPER_INTERVAL_MS: '300',
  });
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

  console.log('== KaryaKram M4 demo ==\n');
  console.log('1. Resetting DB...');
  await pool.query('TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE');
  await pool.query('DROP TABLE IF EXISTS timer_workflow_executions');
  await ensureTimerWorkflowExecutionsTable(pool);

  console.log('2. Starting workflow (activity -> 3s durable timer -> activity)...');
  const workflowId = await startWorkflow(pool, timerWorkflow, { sleepMs: 3_000 });
  console.log(`   workflowId = ${workflowId}`);

  console.log('3. Starting the cluster (reaper + app: activity/workflow/timer workers)...');
  const reaper1 = spawnReaper();
  const app1 = spawnApp('cluster1');
  await Promise.all([waitForReady(reaper1, 1), waitForReady(app1, 3)]);

  console.log('4. Waiting for the first activity to complete...');
  const deadline1 = Date.now() + 10_000;
  for (;;) {
    const events = await getEvents(pool, workflowId);
    const state = foldEvents(events);
    if (
      Object.values(state.activities).some(
        (a) => a.activityType === 'before-timer' && a.status === 'COMPLETED',
      )
    ) {
      break;
    }
    if (Date.now() > deadline1) throw new Error('timed out waiting for before-timer to complete');
    await sleep(10);
  }

  console.log('5. Killing the ENTIRE cluster with SIGKILL (every worker + the reaper)...');
  app1.child.kill('SIGKILL');
  reaper1.child.kill('SIGKILL');
  await sleep(300); // stands in for "the cluster was down for a while"

  console.log('6. Starting a completely fresh cluster...');
  const reaper2 = spawnReaper();
  const app2 = spawnApp('cluster2');
  await Promise.all([waitForReady(reaper2, 1), waitForReady(app2, 3)]);

  console.log('7. Waiting for the durable timer to fire and the workflow to complete...');
  const deadline2 = Date.now() + 20_000;
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

  app2.child.kill('SIGTERM');
  reaper2.child.kill('SIGTERM');

  console.log('\n8. Event log (workflow_events, seq order):');
  const events = await getEvents(pool, workflowId);
  for (const { seq, event } of events) {
    console.log(
      `   ${seq}. ${event.type}${'activityType' in event ? ` (${event.activityType})` : ''}`,
    );
  }

  const state = foldEvents(events);
  console.log('\n9. Activity execution counts (proves neither ran twice):');
  const beforeCount = await getTimerWorkflowExecutionCount(pool, 'before-timer');
  const afterCount = await getTimerWorkflowExecutionCount(pool, 'after-timer');
  console.log(`   before-timer: ${beforeCount}`);
  console.log(`   after-timer:  ${afterCount}`);

  const timerFired = Object.values(state.timers).every((t) => t.status === 'FIRED');
  const activitiesDone = Object.values(state.activities).every((a) => a.status === 'COMPLETED');
  const ok =
    status === 'COMPLETED' &&
    Object.keys(state.timers).length === 1 &&
    timerFired &&
    activitiesDone &&
    beforeCount === 1 &&
    afterCount === 1;

  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: durable timer fired and workflow completed after a full cluster restart.`,
  );

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
