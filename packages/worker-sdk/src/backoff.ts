export interface PollBackoffConfig {
  minMs: number;
  maxMs: number;
  multiplier: number;
}

/**
 * Tracks the poll interval for a worker's dequeue loop: eases up toward
 * `maxMs` on consecutive empty polls (idle DB load stays low), resets to
 * `minMs` the instant any poll returns work (latency stays low when busy).
 * Pure state machine — no timers, no IO — so it's trivially unit-testable.
 */
export class PollBackoff {
  private currentMs: number;

  constructor(private readonly config: PollBackoffConfig) {
    if (config.minMs <= 0) throw new Error(`minMs must be > 0, got ${config.minMs}`);
    if (config.maxMs < config.minMs) {
      throw new Error(`maxMs (${config.maxMs}) must be >= minMs (${config.minMs})`);
    }
    if (config.multiplier <= 1) {
      throw new Error(`multiplier must be > 1, got ${config.multiplier}`);
    }
    this.currentMs = config.minMs;
  }

  get delayMs(): number {
    return this.currentMs;
  }

  onEmpty(): void {
    this.currentMs = Math.min(this.currentMs * this.config.multiplier, this.config.maxMs);
  }

  onWork(): void {
    this.currentMs = this.config.minMs;
  }
}
