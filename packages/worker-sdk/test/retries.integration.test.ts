import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmCompletedEvent, LlmFailedEvent, ToolFailedEvent } from '@karyakram/core';
import { getEvents, listDeadTasks, listProviderCalls, listSideEffects } from '@karyakram/db';
import { MockProvider } from '@karyakram/llm';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { defineWorkflow } from '../src/authoring';
import { loadLlmStepConfig } from '../src/llmConfig';
import { startWorkflow } from '../src/startWorkflow';
import { ToolError, ToolRegistry } from '../src/tools';
import { audit, llmReq, startCluster, waitForStatus, type Cluster } from './llmHarness';

const oneStep = defineWorkflow<{ prompt: string }, string>('wf-retry', async (input, ctx) => {
  return (await ctx.llmCall(llmReq(input.prompt, { mockOutput: 'done' }))).text;
});

describe('retries: LLM steps', () => {
  let db: TestDatabase;
  let cluster: Cluster | null = null;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });
  afterEach(async () => {
    await cluster?.stop();
    cluster = null;
  });

  it('retries a 429 and waits at least the provider-supplied retryAfterMs before calling again', async () => {
    const provider = new MockProvider({
      audit: audit(db.pool),
      failures: [{ on: 429, failAttempts: 1, retryAfterMs: 1_500 }],
    });
    cluster = startCluster(db.pool, { provider, workflows: [oneStep] });
    const id = await startWorkflow(db.pool, oneStep, { prompt: 'rate limited' });
    await waitForStatus(db.pool, id, 'COMPLETED', 20_000);

    const calls = await listProviderCalls(db.pool, id);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    const gapMs = (calls[1]?.calledAt.getTime() ?? 0) - (calls[0]?.calledAt.getTime() ?? 0);
    expect(gapMs).toBeGreaterThanOrEqual(1_450); // Retry-After floor (minus clock/IO slack)

    const completed = (await getEvents(db.pool, id)).find((e) => e.event.type === 'LLM_COMPLETED')
      ?.event as LlmCompletedEvent;
    expect(completed.attempt).toBe(2);
  });

  it('retries 500s and timeouts with backoff until the call succeeds', async () => {
    for (const on of [500, 'timeout'] as const) {
      await db.truncateAll();
      const provider = new MockProvider({
        audit: audit(db.pool),
        failures: [{ on, failAttempts: 2 }],
      });
      cluster = startCluster(db.pool, { provider, workflows: [oneStep] });
      const id = await startWorkflow(db.pool, oneStep, { prompt: `flaky ${String(on)}` });
      await waitForStatus(db.pool, id, 'COMPLETED', 20_000);
      expect((await listProviderCalls(db.pool, id)).map((c) => c.attempt)).toEqual([1, 2, 3]);
      await cluster.stop();
      cluster = null;
    }
  });

  it('does NOT retry a non-retryable 4xx: one call, LLM_FAILED, workflow fails', async () => {
    const provider = new MockProvider({
      audit: audit(db.pool),
      failures: [{ on: 400, failAttempts: 99 }],
    });
    cluster = startCluster(db.pool, { provider, workflows: [oneStep] });
    const id = await startWorkflow(db.pool, oneStep, { prompt: 'bad request' });
    await waitForStatus(db.pool, id, 'FAILED');
    expect(await listProviderCalls(db.pool, id)).toHaveLength(1);
    expect(await listDeadTasks(db.pool)).toHaveLength(0); // handled, not dead-lettered
  });

  it('after max attempts: records LLM_FAILED for the workflow AND dead-letters the task', async () => {
    const provider = new MockProvider({
      audit: audit(db.pool),
      failures: [{ on: 500, failAttempts: 99 }],
    });
    const llmConfig = loadLlmStepConfig({}, { maxAttempts: 3 });
    cluster = startCluster(db.pool, { provider, workflows: [oneStep], llmConfig });
    const id = await startWorkflow(db.pool, oneStep, { prompt: 'always down' });
    await waitForStatus(db.pool, id, 'FAILED', 25_000);

    expect(await listProviderCalls(db.pool, id)).toHaveLength(3);
    const failed = (await getEvents(db.pool, id)).find((e) => e.event.type === 'LLM_FAILED')
      ?.event as LlmFailedEvent;
    expect(failed).toMatchObject({ retryable: true, code: 'server_error', attempts: 3 });

    const dead = await listDeadTasks(db.pool);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ taskType: 'llm', attempt: 3, maxAttempts: 3 });
    expect(dead[0]?.lastError).toMatch(/server error/);
  });
});

describe('retries: tool steps', () => {
  let db: TestDatabase;
  let cluster: Cluster | null = null;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });
  afterEach(async () => {
    await cluster?.stop();
    cluster = null;
  });

  const toolFlow = defineWorkflow<{ n: number }, unknown>('wf-tool-retry', async (_i, ctx) =>
    ctx.toolCall('flaky', { id: 'x' }),
  );

  function flakyRegistry(failTimes: number): { registry: ToolRegistry; calls: () => number } {
    let calls = 0;
    const registry = new ToolRegistry().register<{ id: string }, { ok: true }>({
      name: 'flaky',
      argsSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async handler(_args, ctx) {
        calls++;
        // the side effect happens first, so a retry that duplicated it would show up
        await ctx.client.query(
          `INSERT INTO side_effects (workflow_id, step_id, kind, payload) VALUES ($1, $2, 'effect', '{}'::jsonb)`,
          [ctx.workflowId, ctx.stepId],
        );
        if (calls <= failTimes) throw new ToolError('transient', { retryable: true });
        return { ok: true };
      },
    });
    return { registry, calls: () => calls };
  }

  it('retries a retryable ToolError with backoff; the side effect still lands exactly once', async () => {
    const { registry, calls } = flakyRegistry(2);
    cluster = startCluster(db.pool, {
      provider: new MockProvider(),
      workflows: [toolFlow],
      registry,
    });
    const id = await startWorkflow(db.pool, toolFlow, { n: 1 });
    await waitForStatus(db.pool, id, 'COMPLETED', 20_000);
    expect(calls()).toBe(3);
    expect(await listSideEffects(db.pool, id)).toHaveLength(1);
  });

  it('after max attempts: TOOL_FAILED for the workflow AND a dead-lettered task, with no leaked side effect', async () => {
    const { registry } = flakyRegistry(99);
    const llmConfig = loadLlmStepConfig({}, { toolMaxAttempts: 2 });
    cluster = startCluster(db.pool, {
      provider: new MockProvider(),
      workflows: [toolFlow],
      registry,
      llmConfig,
    });
    const id = await startWorkflow(db.pool, toolFlow, { n: 1 });
    await waitForStatus(db.pool, id, 'FAILED', 20_000);

    const failed = (await getEvents(db.pool, id)).find((e) => e.event.type === 'TOOL_FAILED')
      ?.event as ToolFailedEvent;
    expect(failed).toMatchObject({ retryable: true, attempts: 2 });
    expect(await listSideEffects(db.pool, id)).toEqual([]);
    const dead = await listDeadTasks(db.pool);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ taskType: 'tool', attempt: 2, maxAttempts: 2 });
  });
});
