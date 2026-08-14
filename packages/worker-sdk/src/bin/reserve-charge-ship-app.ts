/**
 * A minimal "application" process for the reserve -> charge -> ship
 * example: runs both a workflow-replay worker and an activity worker in
 * one process. Driven by env vars so tests and the M3 demo can spawn
 * real OS processes of this and `kill -9` them for the crash-recovery
 * proof — the whole point is that killing this process and starting a
 * fresh one must not re-run a completed activity.
 */
import { createPoolFromEnv } from '@karyakram/db';
import { Worker } from '../worker';
import { createActivityHandler } from '../activityHandler';
import { createWorkflowReplayHandler } from '../workflowReplayHandler';
import {
  createReserveChargeShipActivities,
  ensureActivityExecutionsTable,
  reserveChargeShip,
} from '../examples/reserveChargeShip';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();
  await ensureActivityExecutionsTable(pool);

  const workerIdPrefix = process.env['WORKER_ID'] ?? 'app';
  const leaseSeconds = envInt('LEASE_SECONDS', 10);
  const heartbeatIntervalMs = envInt('HEARTBEAT_INTERVAL_MS', 2_000);
  const pollIntervalMs = envInt('POLL_INTERVAL_MS', 50);

  const activityWorker = new Worker(
    pool,
    {
      workerId: `${workerIdPrefix}-activity`,
      taskType: 'activity',
      maxConcurrency: 5,
      leaseSeconds,
      heartbeatIntervalMs,
      pollIntervalMs,
    },
    createActivityHandler(pool, createReserveChargeShipActivities(pool)),
  );

  const workflowWorker = new Worker(
    pool,
    {
      workerId: `${workerIdPrefix}-workflow`,
      taskType: 'workflow',
      maxConcurrency: 5,
      leaseSeconds,
      heartbeatIntervalMs,
      pollIntervalMs,
    },
    createWorkflowReplayHandler(pool, [reserveChargeShip]),
  );

  activityWorker.start();
  workflowWorker.start();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.all([activityWorker.stop(), workflowWorker.stop()])
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
