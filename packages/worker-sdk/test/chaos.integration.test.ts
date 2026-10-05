import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { runChaos } from '../src/chaos/chaosRunner';

/**
 * Real worker processes, real `kill -9`, real Postgres. N is configurable:
 *   KARYAKRAM_CHAOS_RUNS=10 pnpm test:integration   (default 50)
 */
const RUNS = Number(process.env['KARYAKRAM_CHAOS_RUNS'] ?? '50');

describe('chaos: kill -9 a worker mid-workflow', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db.stop();
  });

  it(
    `${String(RUNS)} runs: every workflow completes with reference output, every side effect once, no step called more than allowed`,
    async () => {
      const summary = await runChaos({
        databaseUrl: db.connectionString,
        runs: RUNS,
        seed: 20260105,
      });

      const failures = summary.results.filter((r) => r.violations.length > 0);
      expect(
        failures.map((f) => ({ run: f.run, fault: f.fault, violations: f.violations })),
      ).toEqual([]);

      expect(summary.runs).toBe(RUNS);
      expect(summary.outputsMatchedReferenceRuns).toBe(RUNS);
      expect(summary.sideEffectsExactlyOnceRuns).toBe(RUNS);
      // steps persisted before the crash, or first called after it, were called EXACTLY once
      for (const w of ['persisted_before_crash', 'after_crash'] as const) {
        expect(summary.windows[w].maxCalls).toBeLessThanOrEqual(1);
      }
      // steps that crashed inside the unavoidable window may have been called at most twice
      expect(summary.windows.in_window.maxCalls).toBeLessThanOrEqual(2);
      // the killer actually killed (not a no-op test)
      const crashed = summary.results.filter((r) => r.crashed).length;
      expect(crashed).toBeGreaterThanOrEqual(Math.floor(RUNS * 0.9));
    },
    RUNS * 15_000 + 60_000,
  );
});
