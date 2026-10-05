/**
 * A worker process for the durable-LLM demo: a workflow-replay worker, an
 * `llm` worker and a `tool` worker in one process, running the
 * support-ticket triage workflow. Configured entirely by env vars so tests
 * and demos can spawn real OS processes of it and `kill -9` them.
 *
 *   LLM_PROVIDER=mock|anthropic   (default mock; anthropic needs ANTHROPIC_API_KEY)
 *   KARYAKRAM_FAULT=...           self-inflicted SIGKILL at a named point (chaos tests)
 */
import { createPoolFromEnv } from '@karyakram/db';
import { createProviderFromEnv, PgProviderCallAudit } from '@karyakram/llm';
import { createSupportToolRegistry } from '../examples/supportTools';
import { supportTicketTriage } from '../examples/supportTriage';
import { armRandomDelayFault } from '../faults';
import { createLlmCallHandler } from '../llmHandler';
import { loadLlmStepConfig } from '../llmConfig';
import { createToolCallHandler } from '../toolHandler';
import { createWorkflowReplayHandler } from '../workflowReplayHandler';
import { Worker } from '../worker';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();
  // Throws a clear LlmConfigError if LLM_PROVIDER=anthropic has no key — never falls back to mock.
  const provider = createProviderFromEnv(process.env, { audit: new PgProviderCallAudit(pool) });
  const config = loadLlmStepConfig();
  const workflows = [supportTicketTriage];

  const prefix = process.env['WORKER_ID'] ?? 'llm-app';
  const common = {
    maxConcurrency: envInt('MAX_CONCURRENCY', 5),
    leaseSeconds: envInt('LEASE_SECONDS', 10),
    heartbeatIntervalMs: envInt('HEARTBEAT_INTERVAL_MS', 2_000),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 20),
    // LISTEN/NOTIFY wake-up (M6): without it an idle worker's poll backoff climbs to
    // its 2s ceiling, which is then paid again by every step after a crash recovery.
    ...(process.env['NOTIFY_CONNECTION_STRING']
      ? { notifyConnectionString: process.env['NOTIFY_CONNECTION_STRING'] }
      : {}),
  };

  const workers = [
    new Worker(
      pool,
      { ...common, workerId: `${prefix}-workflow`, taskType: 'workflow' },
      createWorkflowReplayHandler(pool, workflows, undefined, { llm: config }),
    ),
    new Worker(
      pool,
      { ...common, workerId: `${prefix}-llm`, taskType: 'llm' },
      createLlmCallHandler(pool, { provider, workflows, config }),
    ),
    new Worker(
      pool,
      { ...common, workerId: `${prefix}-tool`, taskType: 'tool' },
      createToolCallHandler(pool, { registry: createSupportToolRegistry() }),
    ),
  ];

  for (const w of workers) w.start();
  armRandomDelayFault();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.all(workers.map((w) => w.stop()))
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
