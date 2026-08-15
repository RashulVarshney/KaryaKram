import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { Reaper, type ReaperConfig } from '@karyakram/worker-sdk';
import { LeaderElection } from './leaderElection';

export interface SchedulerConfig {
  connectionString: string;
  leaderId: string;
  electionPollMs?: number;
  reconnectDelayMs?: number;
  reaper?: ReaperConfig;
}

/**
 * Wires leader election to the reaper: starts the (unchanged, reused
 * from `@karyakram/worker-sdk`) `Reaper` the instant this replica
 * becomes leader, stops it the instant it steps down. One `Scheduler`
 * per replica; `pnpm demo:m6` runs several against the same database.
 */
export class Scheduler {
  private readonly election: LeaderElection;
  private readonly reaper: Reaper;
  private readonly logger: Logger;

  constructor(
    pool: Pool,
    config: SchedulerConfig,
    logger: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }),
  ) {
    this.logger = logger.child({ component: 'scheduler', leaderId: config.leaderId });
    this.reaper = new Reaper(pool, config.reaper, logger);
    this.election = new LeaderElection(
      {
        connectionString: config.connectionString,
        leaderId: config.leaderId,
        electionPollMs: config.electionPollMs,
        reconnectDelayMs: config.reconnectDelayMs,
      },
      () => this.reaper.start(),
      () => this.reaper.stop(),
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
}
