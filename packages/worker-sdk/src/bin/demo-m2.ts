/**
 * M2 exit-criteria demo: starts a reserve -> charge -> ship workflow,
 * runs it to completion through a real M1 Worker, then proves the final
 * state is reconstructible purely by folding `workflow_events` — nothing
 * about it is read from anywhere else.
 */
import pino from 'pino';
import { foldEvents } from '@karyakram/core';
import { createPoolFromEnv, getEvents } from '@karyakram/db';
import {
  createReserveChargeShipHandler,
  startReserveChargeShipWorkflow,
} from '../examples/reserveChargeShip';
import { Worker } from '../worker';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();

  console.log('== KaryaKram M2 demo ==\n');
  console.log('1. Resetting DB...');
  await pool.query('TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE');

  console.log('2. Starting workflow (reserve -> charge -> ship)...');
  const workflowId = await startReserveChargeShipWorkflow(pool, 'order-42');
  console.log(`   workflowId = ${workflowId}`);

  console.log('3. Running a worker until the workflow completes...');
  const worker = new Worker(
    pool,
    {
      workerId: 'demo-worker',
      taskType: 'activity',
      maxConcurrency: 1,
      leaseSeconds: 10,
      heartbeatIntervalMs: 2_000,
    },
    createReserveChargeShipHandler(pool),
    // Quiet by default so the demo's own narration stays readable —
    // routine per-task logs would otherwise interleave with it.
    pino({ level: 'warn' }),
  );
  worker.start();

  const deadline = Date.now() + 15_000;
  let status = 'RUNNING';
  while (status !== 'COMPLETED' && Date.now() < deadline) {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id = $1',
      [workflowId],
    );
    status = rows[0]?.status ?? 'RUNNING';
    if (status !== 'COMPLETED') await sleep(100);
  }
  await worker.stop();

  console.log('\n4. Event log (workflow_events, seq order):');
  const events = await getEvents(pool, workflowId);
  for (const { seq, event } of events) {
    console.log(
      `   ${seq}. ${event.type}${'activityType' in event ? ` (${event.activityType})` : ''}`,
    );
  }

  console.log('\n5. State reconstructed purely by folding the log above:');
  const state = foldEvents(events);
  console.log(`   status: ${state.status}`);
  for (const [seq, activity] of Object.entries(state.activities)) {
    console.log(`   activity[${seq}] ${activity.activityType}: ${activity.status}`);
  }

  const allActivitiesCompleted = Object.values(state.activities).every(
    (a) => a.status === 'COMPLETED',
  );
  const ok =
    state.status === 'COMPLETED' &&
    Object.keys(state.activities).length === 3 &&
    allActivitiesCompleted;

  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: workflow completed end to end, state derived purely from events.`,
  );

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
