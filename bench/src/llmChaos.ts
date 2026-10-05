/**
 * Runs the chaos harness (real worker processes, real kill -9) for N runs
 * against a throwaway database and saves the raw per-run results.
 *
 *   pnpm chaos:llm                  # 50 runs
 *   CHAOS_RUNS=10 pnpm chaos:llm
 */
import fs from 'node:fs';
import path from 'node:path';
import { runChaos, type ChaosRunResult } from '@karyakram/worker-sdk';
import { createScratchDb } from './scratchDb';

async function main(): Promise<void> {
  const baseUrl = process.env['DATABASE_URL'];
  if (!baseUrl) throw new Error('DATABASE_URL is not set');
  const runs = Number(process.env['CHAOS_RUNS'] ?? '50');
  const seed = Number(process.env['CHAOS_SEED'] ?? '20260105');

  const db = await createScratchDb(baseUrl);
  const startedAt = new Date();
  try {
    console.log(
      `chaos: ${String(runs)} runs, seed ${String(seed)}, scratch db ${db.url.split('/').pop() ?? ''}`,
    );
    const summary = await runChaos({
      databaseUrl: db.url,
      runs,
      seed,
      onRun: (r: ChaosRunResult) => {
        const w = r.steps
          .map((s) => `${s.stepId}:${s.window}x${String(s.providerCalls)}`)
          .join(' ');
        console.log(
          `run ${String(r.run).padStart(3)} ${r.fault.padEnd(30)} crashed=${String(r.crashed).padEnd(5)} done_before_kill=${String(r.completedBeforeCrash).padEnd(5)} ` +
            `${r.workflowStatus} recovery=${String(r.recoveryMs)}ms  ${w}` +
            (r.violations.length ? `  VIOLATIONS: ${r.violations.join('; ')}` : ''),
        );
      },
    });

    const outDir = path.resolve(__dirname, '..', '..', 'docs', 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `chaos-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), ...summary },
        null,
        2,
      ),
    );

    console.log('\n== summary ==');
    console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
    console.log(`\nraw results: ${path.relative(process.cwd(), file)}`);
    process.exitCode = summary.violations === 0 ? 0 : 1;
  } finally {
    await db.drop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
