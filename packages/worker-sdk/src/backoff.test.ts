import { describe, expect, it } from 'vitest';
import { PollBackoff } from './backoff';

describe('PollBackoff', () => {
  it('starts at minMs', () => {
    const backoff = new PollBackoff({ minMs: 100, maxMs: 2_000, multiplier: 2 });
    expect(backoff.delayMs).toBe(100);
  });

  it('doubles on each consecutive empty poll, capped at maxMs', () => {
    const backoff = new PollBackoff({ minMs: 100, maxMs: 1_000, multiplier: 2 });
    backoff.onEmpty();
    expect(backoff.delayMs).toBe(200);
    backoff.onEmpty();
    expect(backoff.delayMs).toBe(400);
    backoff.onEmpty();
    expect(backoff.delayMs).toBe(800);
    backoff.onEmpty();
    expect(backoff.delayMs).toBe(1_000); // capped, not 1600
    backoff.onEmpty();
    expect(backoff.delayMs).toBe(1_000); // stays capped
  });

  it('resets to minMs the instant work is found', () => {
    const backoff = new PollBackoff({ minMs: 100, maxMs: 2_000, multiplier: 2 });
    backoff.onEmpty();
    backoff.onEmpty();
    expect(backoff.delayMs).toBe(400);
    backoff.onWork();
    expect(backoff.delayMs).toBe(100);
  });

  it('rejects a non-positive minMs', () => {
    expect(() => new PollBackoff({ minMs: 0, maxMs: 1_000, multiplier: 2 })).toThrow(/minMs/);
  });

  it('rejects maxMs below minMs', () => {
    expect(() => new PollBackoff({ minMs: 500, maxMs: 100, multiplier: 2 })).toThrow(/maxMs/);
  });

  it('rejects a multiplier that would never grow the delay', () => {
    expect(() => new PollBackoff({ minMs: 100, maxMs: 1_000, multiplier: 1 })).toThrow(
      /multiplier/,
    );
  });
});
