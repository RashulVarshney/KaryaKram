import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { reclaimExpired } from '@karyakram/db';

export interface ReaperConfig {
  intervalMs?: number;
  limit?: number;
}

/**
 * Standalone loop that puts expired leases back to `pending`. Its own
 * process for M1. TODO(M6): move into the scheduler behind leader
 * election — running this from every replica concurrently (as multiple
 * standalone reaper processes would) is harmless but wasteful; it isn't
 * wrong because reclaimExpired is itself SKIP LOCKED-safe.
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
