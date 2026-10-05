export interface RetryDelayOptions {
  baseSeconds?: number;
  maxSeconds?: number;
  /** Injectable for deterministic tests — defaults to Math.random. */
  random?: () => number;
}

/**
 * Full-jitter exponential backoff: random() * min(maxSeconds, base * 2^attempt).
 * Full jitter (not plain exponential) spreads retries across the whole
 * window instead of clustering them on the same tick after a shared
 * outage — see docs/04-durability.md.
 */
export function computeRetryDelaySeconds(attempt: number, options: RetryDelayOptions = {}): number {
  const { baseSeconds = 1, maxSeconds = 300, random = Math.random } = options;
  if (attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`);

  const cappedExponential = Math.min(maxSeconds, baseSeconds * 2 ** (attempt - 1));
  return random() * cappedExponential;
}

/**
 * `max(full-jitter backoff, floor)`. Backoff spreads retries out; the
 * floor (e.g. a provider's `Retry-After`) says we must never retry
 * *sooner* than that, whatever the jitter drew.
 */
export function computeRetryDelayWithFloorSeconds(
  attempt: number,
  minDelaySeconds = 0,
  options: RetryDelayOptions = {},
): number {
  return Math.max(computeRetryDelaySeconds(attempt, options), minDelaySeconds);
}
