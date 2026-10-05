/**
 * Fault injection for the chaos tests. Production never sets
 * KARYAKRAM_FAULT, so every function here is a no-op that costs one env
 * read. When a fault point is armed, the process kills ITSELF with
 * SIGKILL — the same thing `kill -9` does: no handlers, no cleanup, no
 * flushed buffers — at exactly the named point.
 *
 *   after_provider_before_persist  provider returned, nothing written yet
 *   after_persist                  outcome committed, task not yet completed
 *   before_tool_commit             tool side effect executed, txn not committed
 *   random_delay                   SIGKILL after a seeded random delay from startup
 *
 * Optional: KARYAKRAM_FAULT_AFTER=<n> fires on the n-th hit (default 1);
 * KARYAKRAM_FAULT_MAX_MS / KARYAKRAM_FAULT_SEED shape `random_delay`.
 */
export type FaultPoint =
  'after_provider_before_persist' | 'after_persist' | 'before_tool_commit' | 'random_delay';

let hits = 0;

function armed(point: FaultPoint): boolean {
  return process.env['KARYAKRAM_FAULT'] === point;
}

export function maybeFault(point: FaultPoint): void {
  if (!armed(point)) return;
  const after = Number(process.env['KARYAKRAM_FAULT_AFTER'] ?? '1');
  hits++;
  if (hits >= after) process.kill(process.pid, 'SIGKILL');
}

/** mulberry32: tiny seeded PRNG so a chaos run's kill time is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Call once at worker startup. For `random_delay`, schedules a SIGKILL at a seeded random time. */
export function armRandomDelayFault(): void {
  if (!armed('random_delay')) return;
  const maxMs = Number(process.env['KARYAKRAM_FAULT_MAX_MS'] ?? '1500');
  const seed = Number(process.env['KARYAKRAM_FAULT_SEED'] ?? '1');
  const delay = Math.floor(seeded(seed)() * maxMs);
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), delay).unref();
}
