import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { complete, dequeue, fail, heartbeat, type Task } from '@karyakram/db';
import { PollBackoff } from './backoff';
import { resolveWorkerConfig, type WorkerConfig, type WorkerConfigInput } from './config';

export type TaskHandler = (task: Task) => Promise<void>;

/**
 * A single worker process's run loop: poll for work with backpressure,
 * dispatch to `handler`, heartbeat everything currently in flight, and
 * drain cleanly on shutdown. M1 has no real workflow/activity dispatch —
 * `handler` is a caller-supplied dummy. Real dispatch arrives in M3.
 */
export class Worker {
  private readonly config: WorkerConfig;
  private readonly logger: Logger;
  private readonly backoff: PollBackoff;
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    config: WorkerConfigInput,
    private readonly handler: TaskHandler,
    logger: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }),
  ) {
    this.config = resolveWorkerConfig(config);
    this.logger = logger.child({ workerId: this.config.workerId });
    this.backoff = new PollBackoff({
      minMs: this.config.pollIntervalMs,
      maxMs: this.config.maxPollIntervalMs,
      multiplier: 2,
    });
  }

  get workerId(): string {
    return this.config.workerId;
  }

  start(): void {
    this.logger.info({ config: this.config }, 'worker starting');
    this.scheduleNextPoll(0);
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeats();
    }, this.config.heartbeatIntervalMs);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this.pollOnce();
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return;

    // Backpressure: never lease more than we have room to run. If we're
    // already at capacity, skip the query entirely rather than leasing
    // work we can't start yet.
    const capacity = this.config.maxConcurrency - this.running.size;
    if (capacity <= 0) {
      this.scheduleNextPoll(this.config.pollIntervalMs);
      return;
    }

    let tasks: Task[] = [];
    try {
      tasks = await dequeue(this.pool, {
        workerId: this.config.workerId,
        queue: this.config.queue,
        taskType: this.config.taskType,
        limit: capacity,
        leaseSeconds: this.config.leaseSeconds,
      });
    } catch (err) {
      this.logger.error({ err }, 'dequeue failed');
    }

    if (tasks.length === 0) {
      this.backoff.onEmpty();
    } else {
      this.backoff.onWork();
      for (const task of tasks) {
        this.dispatch(task);
      }
    }

    this.scheduleNextPoll(this.backoff.delayMs);
  }

  private dispatch(task: Task): void {
    const log = this.logger.child({ taskId: task.id });
    const run = (async () => {
      try {
        await this.handler(task);
        const applied = await complete(this.pool, {
          taskId: task.id,
          workerId: this.config.workerId,
        });
        if (applied) {
          log.info('task completed');
        } else {
          log.warn('complete() did not apply — lease was lost before completion');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const applied = await fail(this.pool, {
          taskId: task.id,
          workerId: this.config.workerId,
          error: message,
          attempt: task.attempt,
        });
        if (applied) {
          log.warn({ err }, 'task failed');
        } else {
          log.warn({ err }, 'fail() did not apply — lease was lost before failure was recorded');
        }
      } finally {
        this.running.delete(task.id);
      }
    })();
    this.running.set(task.id, run);
  }

  private async sendHeartbeats(): Promise<void> {
    const taskIds = [...this.running.keys()];
    if (taskIds.length === 0) return;

    try {
      const applied = await heartbeat(this.pool, {
        taskIds,
        workerId: this.config.workerId,
        leaseSeconds: this.config.leaseSeconds,
      });
      if (applied < taskIds.length) {
        // At least one lease was lost (reclaimed by the reaper, most
        // likely). We don't know which without a second query, and the
        // safe move is to let the in-flight handler run to completion:
        // its own complete()/fail() call will simply no-op (return false)
        // for whichever task lost its lease, per docs/01-task-queue.md's
        // stolen-lease guard — never a duplicate side effect from here.
        this.logger.warn(
          { expected: taskIds.length, applied },
          'heartbeat short — at least one in-flight lease was lost',
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'heartbeat failed');
    }
  }

  /**
   * Stops leasing new work, waits for in-flight tasks to finish (up to
   * `drainTimeoutMs`), then returns. Without this, every deploy strands
   * whatever a worker was holding for a full lease TTL.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.logger.info('worker stopping — draining in-flight tasks');
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    const inFlight = [...this.running.values()];
    if (inFlight.length > 0) {
      let timedOut = false;
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, this.config.drainTimeoutMs);
      });
      await Promise.race([Promise.all(inFlight), timeout]);
      if (timedOut && this.running.size > 0) {
        this.logger.warn(
          { stranded: this.running.size },
          'drain timeout exceeded — tasks left in flight',
        );
      }
    }
    this.logger.info('worker stopped');
  }
}

/** Wires SIGTERM/SIGINT to a graceful drain-then-exit. */
export function installGracefulShutdown(
  worker: Worker,
  exit: (code: number) => void = process.exit,
): void {
  const shutdown = (): void => {
    void worker.stop().then(() => exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
