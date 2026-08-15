import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

const WORKER_SDK_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
// Deliberately NOT the node_modules/.bin/tsx shim: that CLI spawns a
// *separate* Node process to actually run the script (visible via `ps`
// as two distinct PIDs), so killing the shim's PID leaves the real
// worker running untouched — which silently broke the crash-recovery
// tests/demo (a "killed" worker kept completing tasks in the background).
// Loading tsx as a `--import` loader runs everything in this one process
// instead, so SIGKILL/SIGTERM actually reaches the code we spawned it for.
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

export interface SpawnedProcess {
  child: ChildProcessWithoutNullStreams;
  logs: string[];
  /** Resolves once the process has logged that it started, or rejects after a timeout. */
  waitForReady: () => Promise<void>;
}

function spawnTsx(
  script: string,
  env: NodeJS.ProcessEnv,
  readyMarker: string,
  readyCount = 1,
): SpawnedProcess {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, script], {
    cwd: WORKER_SDK_DIR,
    env,
  });

  const logs: string[] = [];
  const collect = (chunk: Buffer): void => {
    logs.push(...chunk.toString('utf8').split('\n').filter(Boolean));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  function waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        const count = logs.filter((l) => l.includes(readyMarker)).length;
        if (count >= readyCount) {
          resolve();
          return;
        }
        if (Date.now() - start > 15_000) {
          reject(
            new Error(`process did not become ready within 15s. Logs so far:\n${logs.join('\n')}`),
          );
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });
  }

  return { child, logs, waitForReady };
}

export interface SpawnWorkerOptions {
  databaseUrl: string;
  workerId: string;
  queue?: string;
  handlerMode?: 'noop' | 'record' | 'record-interval';
  resultsTable?: string;
  maxConcurrency?: number;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  handlerSleepMs?: number;
  drainTimeoutMs?: number;
}

export function spawnWorker(options: SpawnWorkerOptions): SpawnedProcess {
  return spawnTsx(
    'src/bin/task-runner.ts',
    {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      WORKER_ID: options.workerId,
      QUEUE: options.queue ?? 'default',
      HANDLER_MODE: options.handlerMode ?? 'noop',
      RESULTS_TABLE: options.resultsTable ?? 'results',
      MAX_CONCURRENCY: String(options.maxConcurrency ?? 4),
      LEASE_SECONDS: String(options.leaseSeconds ?? 30),
      HEARTBEAT_INTERVAL_MS: String(options.heartbeatIntervalMs ?? 10_000),
      POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 100),
      HANDLER_SLEEP_MS: String(options.handlerSleepMs ?? 0),
      DRAIN_TIMEOUT_MS: String(options.drainTimeoutMs ?? 30_000),
    },
    '"msg":"worker starting"',
  );
}

export interface SpawnReaperOptions {
  databaseUrl: string;
  intervalMs?: number;
}

export function spawnReaper(options: SpawnReaperOptions): SpawnedProcess {
  return spawnTsx(
    'src/bin/run-reaper.ts',
    {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      REAPER_INTERVAL_MS: String(options.intervalMs ?? 1_000),
    },
    '"msg":"reaper starting"',
  );
}

export interface SpawnAppOptions {
  databaseUrl: string;
  workerId: string;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
}

/** Spawns the reserve->charge->ship example app (both an activity worker and a workflow-replay worker in one process). */
export function spawnReserveChargeShipApp(options: SpawnAppOptions): SpawnedProcess {
  return spawnTsx(
    'src/bin/reserve-charge-ship-app.ts',
    {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      WORKER_ID: options.workerId,
      LEASE_SECONDS: String(options.leaseSeconds ?? 10),
      HEARTBEAT_INTERVAL_MS: String(options.heartbeatIntervalMs ?? 2_000),
      POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 50),
    },
    '"msg":"worker starting"',
    2, // both the activity worker and the workflow worker log this
  );
}

/** Spawns the timer-workflow example app (activity + workflow-replay + timer workers, one process). */
export function spawnTimerWorkflowApp(options: SpawnAppOptions): SpawnedProcess {
  return spawnTsx(
    'src/bin/timer-workflow-app.ts',
    {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      WORKER_ID: options.workerId,
      LEASE_SECONDS: String(options.leaseSeconds ?? 10),
      HEARTBEAT_INTERVAL_MS: String(options.heartbeatIntervalMs ?? 2_000),
      POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 50),
    },
    '"msg":"worker starting"',
    3, // activity, workflow, and timer workers each log this
  );
}

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.on('exit', (code) => resolve(code));
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
