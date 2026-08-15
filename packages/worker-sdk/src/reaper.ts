import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { reclaimExpired } from '@karyakram/db';
import type { TaskMetrics } from '@karyakram/observability';

export interface ReaperConfig {
  intervalMs?: number;
  limit?: number;
}

/**
 * Loop that puts expired leases back to `pending`. Its own standalone
 * process for M1's demos (unchanged since — those are tagged proof
 * artifacts). M6's `packages/scheduler` reuses this same class, started
 * only on whichever replica currently holds leadership, so it no longer
 * runs redundantly from every replica in the new demo. Running it from
 * more than one place concurrently was always harmless, just wasteful —
 * `reclaimExpired` is itself SKIP LOCKED-safe — so M1's standalone usage
 * remains correct. See docs/06-scheduler.md.
 */
export class Reaper {
  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    config: ReaperConfig = {},
    logger: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }),
    /** Opt-in, exactly like `Worker`'s observability param. See docs/07-observability.md. */
    private readonly metrics?: TaskMetrics,
  ) {
    this.intervalMs = config.intervalMs ?? 5_000;
    this.limit = config.limit ?? 100;
    this.logger = logger.child({ component: 'reaper' });
  }

  start(): void {
    this.logger.info({ intervalMs: this.intervalMs }, 'reaper starting');
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      const reclaimed = await reclaimExpired(this.pool, { limit: this.limit });
      if (reclaimed.length > 0) {
        this.logger.info(
          { count: reclaimed.length, taskIds: reclaimed },
          'reclaimed expired leases',
        );
        this.metrics?.tasksReclaimedTotal.inc(reclaimed.length);
      }
    } catch (err) {
      this.logger.error({ err }, 'reclaimExpired failed');
    }
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.logger.info('reaper stopped');
  }
}
