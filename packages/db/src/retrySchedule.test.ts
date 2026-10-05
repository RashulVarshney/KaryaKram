import { describe, expect, it } from 'vitest';
import { computeRetryDelaySeconds, computeRetryDelayWithFloorSeconds } from './backoff';

/** A fake clock: retries are scheduled by advancing it, never by waiting. */
class FakeClock {
  constructor(public nowMs = 0) {}
  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }
}

/** Walks a failing task through its attempts and returns each retry's `run_after` on the fake clock. */
function retryTimeline(
  failures: { attempt: number; retryAfterMs?: number }[],
  random: () => number,
): number[] {
  const clock = new FakeClock();
  const runAfter: number[] = [];
  for (const f of failures) {
    const delay = computeRetryDelayWithFloorSeconds(f.attempt, (f.retryAfterMs ?? 0) / 1000, {
      random,
    });
    runAfter.push(clock.nowMs + delay * 1000);
    clock.advance(delay); // the retry runs when it becomes due
  }
  return runAfter;
}

describe('retry schedule (full-jitter exponential backoff + retryAfter floor)', () => {
  it('at max jitter the delays double each attempt (1,2,4,8,16s) then cap at maxSeconds', () => {
    const delays = [1, 2, 3, 4, 5].map((a) => computeRetryDelaySeconds(a, { random: () => 1 }));
    expect(delays).toEqual([1, 2, 4, 8, 16]);
    expect(computeRetryDelaySeconds(20, { random: () => 1 })).toBe(300);
    expect(computeRetryDelaySeconds(20, { random: () => 1, maxSeconds: 60 })).toBe(60);
  });

  it('at zero jitter the delay is zero, and jitter always lies within [0, cap]', () => {
    expect(computeRetryDelaySeconds(4, { random: () => 0 })).toBe(0);
    for (const r of [0.1, 0.5, 0.999]) {
      const d = computeRetryDelaySeconds(3, { random: () => r });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(4);
    }
  });

  it('honours retryAfter as a floor even when jitter draws less', () => {
    // attempt 1 jitter cap is 1s; a 30s Retry-After must win
    expect(computeRetryDelayWithFloorSeconds(1, 30, { random: () => 0.01 })).toBe(30);
    // but backoff still wins when it is already longer than the floor
    expect(computeRetryDelayWithFloorSeconds(5, 2, { random: () => 1 })).toBe(16);
  });

  it('builds a monotone run_after timeline on a fake clock', () => {
    const t = retryTimeline(
      [{ attempt: 1 }, { attempt: 2, retryAfterMs: 5_000 }, { attempt: 3 }],
      () => 1,
    );
    // delays: 1s, max(2s, 5s)=5s, 4s  -> due at 1s, 1+5=6s, 6+4=10s
    expect(t).toEqual([1_000, 6_000, 10_000]);
  });

  it('rejects an attempt below 1', () => {
    expect(() => computeRetryDelayWithFloorSeconds(0)).toThrow(/attempt must be >= 1/);
  });
});
