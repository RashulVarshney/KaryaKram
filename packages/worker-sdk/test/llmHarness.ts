import type { Pool } from 'pg';
import { foldEvents, type LlmRequest, type WorkflowStatus } from '@karyakram/core';
import { getEvents } from '@karyakram/db';
import { PgProviderCallAudit, type LLMProvider } from '@karyakram/llm';
import type { AnyWorkflowDefinition } from '../src/authoring';
import { createLlmCallHandler } from '../src/llmHandler';
import type { LlmStepConfig } from '../src/llmConfig';
import { Reaper } from '../src/reaper';
import { createWorkflowReplayHandler } from '../src/workflowReplayHandler';
import { Worker } from '../src/worker';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs = 25 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: condition never became true in time');
    await sleep(intervalMs);
  }
}

export const audit = (pool: Pool): PgProviderCallAudit => new PgProviderCallAudit(pool);

export const llmReq = (content: string, params?: Record<string, unknown>): LlmRequest => ({
  model: 'default',
  messages: [
    { role: 'system', content: 'You are a test assistant.' },
    { role: 'user', content },
  ],
  ...(params ? { params } : {}),
});

export interface ClusterOptions {
  provider: LLMProvider;
  workflows: AnyWorkflowDefinition[];
  llmConfig?: LlmStepConfig;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  reaperIntervalMs?: number;
  /** Skip the llm worker (to inspect a freshly requested step by hand). */
  withoutLlmWorker?: boolean;
}

export interface Cluster {
  stop(): Promise<void>;
}

/** A workflow-replay worker + an llm worker (+ optional reaper), all in this process. */
export function startCluster(pool: Pool, options: ClusterOptions): Cluster {
  const common = {
    maxConcurrency: 5,
    leaseSeconds: options.leaseSeconds ?? 10,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 2_000,
    pollIntervalMs: options.pollIntervalMs ?? 20,
  };
  const workflowWorker = new Worker(
    pool,
    { ...common, workerId: 'wf-worker', taskType: 'workflow' },
    createWorkflowReplayHandler(
      pool,
      options.workflows,
      undefined,
      options.llmConfig ? { llm: options.llmConfig } : {},
    ),
  );
  const workers = [workflowWorker];
  if (!options.withoutLlmWorker) {
    workers.push(
      new Worker(
        pool,
        { ...common, workerId: 'llm-worker', taskType: 'llm' },
        createLlmCallHandler(pool, {
          provider: options.provider,
          workflows: options.workflows,
          ...(options.llmConfig ? { config: options.llmConfig } : {}),
        }),
      ),
    );
  }
  const reaper = options.reaperIntervalMs
    ? new Reaper(pool, { intervalMs: options.reaperIntervalMs })
    : null;
  for (const w of workers) w.start();
  reaper?.start();
  return {
    async stop() {
      reaper?.stop();
      await Promise.all(workers.map((w) => w.stop()));
    },
  };
}

export async function workflowStatus(pool: Pool, workflowId: string): Promise<WorkflowStatus> {
  const events = await getEvents(pool, workflowId);
  return foldEvents(events).status;
}

export async function waitForStatus(
  pool: Pool,
  workflowId: string,
  status: WorkflowStatus,
  timeoutMs = 15_000,
): Promise<void> {
  await pollUntil(async () => (await workflowStatus(pool, workflowId)) === status, { timeoutMs });
}

export async function waitForEventType(
  pool: Pool,
  workflowId: string,
  type: string,
  timeoutMs = 15_000,
): Promise<void> {
  await pollUntil(
    async () => (await getEvents(pool, workflowId)).some((e) => e.event.type === type),
    { timeoutMs },
  );
}

export async function eventTypes(pool: Pool, workflowId: string): Promise<string[]> {
  return (await getEvents(pool, workflowId)).map((e) => e.event.type);
}
