import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from './config';

describe('resolveWorkerConfig', () => {
  it('fills in defaults', () => {
    const config = resolveWorkerConfig({ maxConcurrency: 4 });
    expect(config.maxConcurrency).toBe(4);
    expect(config.queue).toBe('default');
    expect(config.leaseSeconds).toBe(30);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.pollIntervalMs).toBe(100);
    expect(config.maxPollIntervalMs).toBe(2_000);
    expect(config.drainTimeoutMs).toBe(30_000);
    expect(config.workerId).toBeTruthy();
  });

  it('preserves an explicit workerId instead of generating one', () => {
    const config = resolveWorkerConfig({ maxConcurrency: 1, workerId: 'fixed-id' });
    expect(config.workerId).toBe('fixed-id');
  });

  it('rejects maxConcurrency <= 0', () => {
    expect(() => resolveWorkerConfig({ maxConcurrency: 0 })).toThrow(/maxConcurrency/);
    expect(() => resolveWorkerConfig({ maxConcurrency: -1 })).toThrow(/maxConcurrency/);
  });

  it('rejects a non-integer maxConcurrency', () => {
    expect(() => resolveWorkerConfig({ maxConcurrency: 1.5 })).toThrow(/maxConcurrency/);
  });

  it('rejects leaseSeconds <= 0', () => {
    expect(() => resolveWorkerConfig({ maxConcurrency: 1, leaseSeconds: 0 })).toThrow(
      /leaseSeconds/,
    );
  });

  it('rejects a heartbeat interval that would let leases expire between heartbeats', () => {
    expect(() =>
      resolveWorkerConfig({ maxConcurrency: 1, leaseSeconds: 5, heartbeatIntervalMs: 5_000 }),
    ).toThrow(/heartbeatIntervalMs/);
    expect(() =>
      resolveWorkerConfig({ maxConcurrency: 1, leaseSeconds: 5, heartbeatIntervalMs: 6_000 }),
    ).toThrow(/heartbeatIntervalMs/);
  });

  it('accepts a heartbeat interval comfortably under the lease TTL', () => {
    const config = resolveWorkerConfig({
      maxConcurrency: 1,
      leaseSeconds: 30,
      heartbeatIntervalMs: 10_000,
    });
    expect(config.heartbeatIntervalMs).toBe(10_000);
  });

  it('rejects maxPollIntervalMs below pollIntervalMs', () => {
    expect(() =>
      resolveWorkerConfig({ maxConcurrency: 1, pollIntervalMs: 500, maxPollIntervalMs: 100 }),
    ).toThrow(/maxPollIntervalMs/);
  });
});
