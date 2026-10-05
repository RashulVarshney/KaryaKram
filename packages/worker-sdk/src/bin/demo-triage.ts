/**
 * Runs the support-ticket triage workflow end to end against the dev
 * Postgres: spawns a real worker process (`llm-agent-app.ts`), starts N
 * tickets, waits for them, and prints each result plus how many provider
 * calls and side effects each ticket caused. With the default
 * LLM_PROVIDER=mock it needs no network and no API key.
 *
 *   pnpm demo:llm                  # 3 tickets, mock provider
 *   TICKETS=10 pnpm demo:llm
 *   LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm demo:llm
 *
 * Requires `docker compose up -d` and `pnpm db:migrate` first.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { foldEvents } from '@karyakram/core';
import {
  countProviderCallsByStep,
  createPoolFromEnv,
  getEvents,
  listSideEffects,
} from '@karyakram/db';
import { sampleTicket, supportTicketTriage } from '../examples/supportTriage';
import { startWorkflow } from '../startWorkflow';

const WORKER_SDK_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const tickets = Number(process.env['TICKETS'] ?? '3');
  const pool = createPoolFromEnv();

  console.log(
    `== durable LLM steps demo (provider: ${process.env['LLM_PROVIDER'] ?? 'mock'}) ==\n`,
  );
  const worker = spawn(process.execPath, ['--import', TSX_LOADER, 'src/bin/llm-agent-app.ts'], {
    cwd: WORKER_SDK_DIR,
    env: {
      ...process.env,
      LOG_LEVEL: 'warn',
      NOTIFY_CONNECTION_STRING:
        process.env['NOTIFY_CONNECTION_STRING'] ?? process.env['DATABASE_URL'] ?? '',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let workerExited = false;
  worker.on('exit', (code) => {
    workerExited = true;
    if (code !== 0 && code !== null) console.error(`worker exited with code ${String(code)}`);
  });

  try {
    const ids: string[] = [];
    for (let i = 0; i < tickets; i++) {
      ids.push(await startWorkflow(pool, supportTicketTriage, sampleTicket(i)));
    }
    console.log(`started ${String(tickets)} workflow(s)...\n`);

    const deadline = Date.now() + 60_000;
    for (const id of ids) {
      for (;;) {
        const state = foldEvents(await getEvents(pool, id));
        if (state.status !== 'RUNNING') break;
        if (workerExited) throw new Error('worker exited before the workflows finished');
        if (Date.now() > deadline) throw new Error(`timed out waiting for workflow ${id}`);
        await sleep(100);
      }
    }

    for (const id of ids) {
      const events = await getEvents(pool, id);
      const state = foldEvents(events);
      const calls = await countProviderCallsByStep(pool, id);
      const effects = await listSideEffects(pool, id);
      console.log(`workflow ${id}  ->  ${state.status}`);
      console.log(`  result: ${JSON.stringify(state.result)}`);
      console.log(`  provider calls per step: ${JSON.stringify(calls)}`);
      console.log(`  side effects: ${effects.map((e) => `${e.stepId}:${e.kind}`).join(', ')}`);
      console.log(`  events: ${events.map((e) => e.event.type).join(' > ')}\n`);
    }
  } finally {
    worker.kill('SIGTERM');
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
