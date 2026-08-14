import { defineConfig } from 'vitest/config';

// Two projects, run by separate scripts (`test:unit`, `test:integration`):
//   - unit:        packages/**/*.test.ts              — fast, no DB, no Docker
//   - integration: packages/**/*.integration.test.ts  — real Postgres via testcontainers
// The suffix is the only thing that distinguishes them, so a stray unit
// test can never accidentally skip DB setup or vice versa.
export default defineConfig({
  test: {
    // TODO(M1): remove once real unit tests exist (backoff calc, etc).
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts'],
          exclude: ['packages/**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
          // TODO(M1): remove once real unit tests exist (backoff calc, etc).
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // container start + migrations can be slow, especially on first pull
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
