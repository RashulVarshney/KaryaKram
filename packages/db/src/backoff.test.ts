import { describe, expect, it } from 'vitest';
import { computeRetryDelaySeconds } from './backoff';

describe('computeRetryDelaySeconds', () => {
  it('grows exponentially with attempt, before jitter', () => {
    // random() = 1 removes jitter entirely (full window every time).
    const random = () => 1;
    expect(computeRetryDelaySeconds(1, { baseSeconds: 1, random })).toBe(1);
    expect(computeRetryDelaySeconds(2, { baseSeconds: 1, random })).toBe(2);
    expect(computeRetryDelaySeconds(3, { baseSeconds: 1, random })).toBe(4);
    expect(computeRetryDelaySeconds(4, { baseSeconds: 1, random })).toBe(8);
  });

  it('caps the exponential growth at maxSeconds', () => {
    const random = () => 1;
    const delay = computeRetryDelaySeconds(20, { baseSeconds: 1, maxSeconds: 300, random });
    expect(delay).toBe(300);
  });

  it('applies jitter by scaling the capped exponential value by random()', () => {
    const delay = computeRetryDelaySeconds(3, { baseSeconds: 1, random: () => 0.5 });
    expect(delay).toBe(2); // 0.5 * min(300, 1 * 2^2) = 0.5 * 4
  });

  it('a random() of 0 produces a 0 delay (full jitter can retry immediately)', () => {
    const delay = computeRetryDelaySeconds(5, { random: () => 0 });
    expect(delay).toBe(0);
  });

  it('rejects attempt < 1', () => {
    expect(() => computeRetryDelaySeconds(0)).toThrow(/attempt/);
  });
});
