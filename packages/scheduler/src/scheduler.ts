import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { getQueueDepth } from '@karyakram/db';
import { Reaper, type ReaperConfig } from '@karyakram/worker-sdk';
import type { TaskMetrics } from '@karyakram/observability';
import { LeaderElection } from './leaderElection';

export interface SchedulerConfig {
  connectionString: string;
  leaderId: string;
  electionPollMs?: number;
  reconnectDelayMs?: number;
  reaper?: ReaperConfig;
  /** How often the leader refreshes the `karyakram_queue_depth` gauge. */
  queueDepthIntervalMs?: number;
}

/**
 * Wires leader election to the reaper: starts the (unchanged, reused
 * from `@karyakram/worker-sdk`) `Reaper` the instant this replica
 * becomes leader, stops it the instant it steps down. One `Scheduler`
 * per replica; `pnpm demo:m6` runs several against the same database.
 *
 * Also publishes the `karyakram_queue_depth` gauge on the same
 * leader-only schedule as the reaper — global queue state, not
 * per-process, so only the current leader queries it. See
 * docs/07-observability.md.
 */
export class Scheduler {
  private readonly election: LeaderElection;
  private readonly reaper: Reaper;
  private readonly logger: Logger;
  private readonly queueDepthIntervalMs: number;
  private queueDepthTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    config: SchedulerConfig,
    logger: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }),
    private readonly metrics?: TaskMetrics,
  ) {
    this.logger = logger.child({ component: 'scheduler', leaderId: config.leaderId });
    this.queueDepthIntervalMs = config.queueDepthIntervalMs ?? 5_000;
    this.reaper = new Reaper(pool, config.reaper, logger, metrics);
    this.election = new LeaderElection(
      {
        connectionString: config.connectionString,
        leaderId: config.leaderId,
        electionPollMs: config.electionPollMs,
        reconnectDelayMs: config.reconnectDelayMs,
      },
      () => this.onAcquire(),
      () => this.onLose(),
      logger,
    );
  }

  get isLeader(): boolean {
    return this.election.isLeader;
  }

  start(): void {
    this.logger.info('scheduler starting');
    this.election.start();
  }

  async stop(): Promise<void> {
    await this.election.stop();
    this.logger.info('scheduler stopped');
  }

  private onAcquire(): void {
    this.reaper.start();
    if (this.metrics) this.scheduleQueueDepthRefresh();
  }

  private onLose(): void {
    this.reaper.stop();
    if (this.queueDepthTimer) clearTimeout(this.queueDepthTimer);
    this.queueDepthTimer = null;
  }

  private scheduleQueueDepthRefresh(): void {
    this.queueDepthTimer = setTimeout(() => {
      void this.refreshQueueDepth();
    }, this.queueDepthIntervalMs);
  }

  private async refreshQueueDepth(): Promise<void> {
    if (!this.metrics) return;
    try {
      const depth = await getQueueDepth(this.pool);
      for (const [status, count] of Object.entries(depth)) {
        this.metrics.queueDepth.set({ status }, count);
      }
    } catch (err) {
      this.logger.error({ err }, 'getQueueDepth failed');
    }
    if (this.election.isLeader) this.scheduleQueueDepthRefresh();
  }
}
