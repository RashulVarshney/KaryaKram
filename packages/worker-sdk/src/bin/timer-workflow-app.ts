/**
 * A minimal "application" process for the timer-workflow example: runs
 * an activity worker, a workflow-replay worker, and a timer worker all
 * in one process. Driven by env vars so tests and the M4 demo can spawn
 * real OS processes of this and `kill -9` them — the whole point is that
 * killing every worker (and the reaper, run separately) mid-wait must
 * not stop the durable timer from firing once a fresh process is up.
 */
import { createPoolFromEnv } from '@karyakram/db';
import { Worker } from '../worker';
import { createActivityHandler } from '../activityHandler';
import { createWorkflowReplayHandler } from '../workflowReplayHandler';
import { createTimerHandler } from '../timerHandler';
import {
  createTimerWorkflowActivities,
  ensureTimerWorkflowExecutionsTable,
  timerWorkflow,
} from '../examples/timerWorkflow';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();
  await ensureTimerWorkflowExecutionsTable(pool);

  const workerIdPrefix = process.env['WORKER_ID'] ?? 'app';
  const leaseSeconds = envInt('LEASE_SECONDS', 10);
  const heartbeatIntervalMs = envInt('HEARTBEAT_INTERVAL_MS', 2_000);
  const pollIntervalMs = envInt('POLL_INTERVAL_MS', 50);

  const commonConfig = { leaseSeconds, heartbeatIntervalMs, pollIntervalMs, maxConcurrency: 5 };

  const activityWorker = new Worker(
    pool,
    { workerId: `${workerIdPrefix}-activity`, taskType: 'activity', ...commonConfig },
    createActivityHandler(pool, createTimerWorkflowActivities(pool)),
  );
  const workflowWorker = new Worker(
    pool,
    { workerId: `${workerIdPrefix}-workflow`, taskType: 'workflow', ...commonConfig },
    createWorkflowReplayHandler(pool, [timerWorkflow]),
  );
  const timerWorker = new Worker(
    pool,
    { workerId: `${workerIdPrefix}-timer`, taskType: 'timer', ...commonConfig },
    createTimerHandler(pool),
  );

  activityWorker.start();
  workflowWorker.start();
  timerWorker.start();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.all([activityWorker.stop(), workflowWorker.stop(), timerWorker.stop()])
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
