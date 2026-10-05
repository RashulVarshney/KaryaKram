import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  foldEvents,
  type LlmCompletedEvent,
  type LlmFailedEvent,
  type LlmRequestedEvent,
} from '@karyakram/core';
import { countProviderCallsByStep, dequeue, getEvents, listProviderCalls } from '@karyakram/db';
import { hashLlmRequest, MockProvider } from '@karyakram/llm';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { defineWorkflow } from '../src/authoring';
import { LeaseLostError } from '../src/fencing';
import { createLlmCallHandler } from '../src/llmHandler';
import { loadLlmStepConfig } from '../src/llmConfig';
import { sendSignal } from '../src/sendSignal';
import { startWorkflow } from '../src/startWorkflow';
import {
  audit,
  eventTypes,
  llmReq,
  pollUntil,
  sleep,
  startCluster,
  waitForEventType,
  waitForStatus,
  type Cluster,
} from './llmHarness';

/** classify -> wait for a signal -> draft. The pause is what lets tests replay a half-done workflow. */
const gated = defineWorkflow<{ topic: string }, { label: string; final: string }>(
  'wf-gated',
  async (input, ctx) => {
    const a = await ctx.llmCall(llmReq(`classify ${input.topic}`, { mockOutput: 'billing' }));
    await ctx.waitForSignal('go');
    const b = await ctx.llmCall(llmReq(`draft a reply about ${a.text}`));
    return { label: a.text, final: b.text };
  },
);

const oneStep = defineWorkflow<{ prompt: string; params?: Record<string, unknown> }, string>(
  'wf-one-step',
  async (input, ctx) => (await ctx.llmCall(llmReq(input.prompt, input.params))).text,
);

describe('durable llm_call step', () => {
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

  it('runs a two-step LLM workflow end to end, recording requested/completed events', async () => {
    const provider = new MockProvider({ audit: audit(db.pool), latencyMs: 5 });
    cluster = startCluster(db.pool, { provider, workflows: [gated] });

    const id = await startWorkflow(db.pool, gated, { topic: 'invoice' });
    await waitForEventType(db.pool, id, 'LLM_COMPLETED');
    await sendSignal(db.pool, id, 'go', {});
    await waitForStatus(db.pool, id, 'COMPLETED');

    expect(await eventTypes(db.pool, id)).toEqual([
      'WorkflowStarted',
      'LLM_REQUESTED',
      'LLM_COMPLETED',
      'SignalReceived',
      'LLM_REQUESTED',
      'LLM_COMPLETED',
      'WorkflowCompleted',
    ]);

    const events = await getEvents(db.pool, id);
    const requested = events[1]?.event as LlmRequestedEvent;
    const completed = events[2]?.event as LlmCompletedEvent;
    expect(requested).toMatchObject({ stepId: 'llm-0', requestStorage: 'full', maxAttempts: 5 });
    expect(requested.requestHash).toBe(
      hashLlmRequest(llmReq('classify invoice', { mockOutput: 'billing' })),
    );
    expect(completed).toMatchObject({
      stepId: 'llm-0',
      scheduledEventSeq: 2,
      text: 'billing',
      truncated: false,
      model: 'mock-1',
      latencyMs: 5,
      attempt: 1,
    });
    expect(completed.tokensIn).toBeGreaterThan(0);
    expect(completed.estimatedCostUsd).toBeGreaterThan(0);

    const state = foldEvents(events);
    expect(state.result).toMatchObject({ label: 'billing' });
    // exactly one provider call per step, counted by the provider itself
    expect(await countProviderCallsByStep(db.pool, id)).toEqual({ 'llm-0': 1, 'llm-1': 1 });
  });

  it('replay reuses the recorded output: repeated replays of a half-done workflow make ZERO new provider calls', async () => {
    const provider = new MockProvider({ audit: audit(db.pool) });
    cluster = startCluster(db.pool, { provider, workflows: [gated] });

    const id = await startWorkflow(db.pool, gated, { topic: 'x' });
    await waitForEventType(db.pool, id, 'LLM_COMPLETED');
    expect(await countProviderCallsByStep(db.pool, id)).toEqual({ 'llm-0': 1 });

    // Each signal appends an event and triggers a full replay from the top, which passes over llm-0.
    for (let i = 0; i < 5; i++) {
      await sendSignal(db.pool, id, 'noise', { i });
      await sleep(80);
    }
    expect(await countProviderCallsByStep(db.pool, id)).toEqual({ 'llm-0': 1 });

    await sendSignal(db.pool, id, 'go', {});
    await waitForStatus(db.pool, id, 'COMPLETED');
    expect(await countProviderCallsByStep(db.pool, id)).toEqual({ 'llm-0': 1, 'llm-1': 1 });
  });

  it('fails the workflow with a clear reason — and makes no provider call — when the prompt changed mid-flight', async () => {
    const v1 = defineWorkflow<{ n: number }, string>('wf-drift', async (_i, ctx) => {
      const a = await ctx.llmCall(llmReq('PROMPT ONE', { mockOutput: 'a' }));
      await ctx.waitForSignal('go');
      return a.text;
    });
    const v2 = defineWorkflow<{ n: number }, string>('wf-drift', async (_i, ctx) => {
      const a = await ctx.llmCall(llmReq('PROMPT TWO (edited after deploy)', { mockOutput: 'a' }));
      await ctx.waitForSignal('go');
      return a.text;
    });
    const provider = new MockProvider({ audit: audit(db.pool) });

    cluster = startCluster(db.pool, { provider, workflows: [v1] });
    const id = await startWorkflow(db.pool, v1, { n: 1 });
    await waitForEventType(db.pool, id, 'LLM_COMPLETED');
    await cluster.stop();

    // "deploy" v2 and resume the same workflow
    cluster = startCluster(db.pool, { provider, workflows: [v2] });
    await sendSignal(db.pool, id, 'go', {});
    await waitForStatus(db.pool, id, 'FAILED');

    const state = foldEvents(await getEvents(db.pool, id));
    expect(state.error).toMatch(/Non-deterministic workflow/);
    expect(state.error).toMatch(/llm-0/);
    expect(state.error).toMatch(/refusing to silently re-call the provider/);
    expect(await countProviderCallsByStep(db.pool, id)).toEqual({ 'llm-0': 1 });
  });

  it('records LLM_FAILED (and does not retry) for a non-retryable provider error, and the workflow sees it', async () => {
    const provider = new MockProvider({
      audit: audit(db.pool),
      failures: [{ on: 400, failAttempts: 99 }],
    });
    cluster = startCluster(db.pool, { provider, workflows: [oneStep] });

    const id = await startWorkflow(db.pool, oneStep, { prompt: 'will be rejected' });
    await waitForStatus(db.pool, id, 'FAILED');

    const events = await getEvents(db.pool, id);
    const failed = events.find((e) => e.event.type === 'LLM_FAILED')?.event as LlmFailedEvent;
    expect(failed).toMatchObject({ retryable: false, code: 'invalid_request', attempts: 1 });
    expect(await countProviderCallsByStep(db.pool, id)).toEqual({ 'llm-0': 1 });
  });

  describe('lease fencing', () => {
    it('a worker that lost its lease discards its result: nothing is written', async () => {
      const provider = new MockProvider({ audit: audit(db.pool) });
      // only the workflow worker runs, so the llm task stays pending for us to lease by hand
      cluster = startCluster(db.pool, { provider, workflows: [oneStep], withoutLlmWorker: true });
      const id = await startWorkflow(db.pool, oneStep, { prompt: 'fence me' });
      await waitForEventType(db.pool, id, 'LLM_REQUESTED');
      await cluster.stop();
      cluster = null;

      const [stale] = await dequeue(db.pool, {
        workerId: 'w1',
        taskType: 'llm',
        limit: 1,
        leaseSeconds: 30,
      });
      if (!stale) throw new Error('expected an llm task');
      expect(stale.attempt).toBe(1);

      // The reaper reclaims it and w2 leases it (attempt 2) while w1 is still "calling the provider".
      await db.pool.query(
        `UPDATE tasks SET leased_by = 'w2', attempt = 2, lease_expires_at = now() + interval '30 seconds' WHERE id = $1`,
        [stale.id],
      );

      const handler = createLlmCallHandler(db.pool, { provider, workflows: [oneStep] });
      await expect(handler(stale)).rejects.toBeInstanceOf(LeaseLostError);
      expect((await eventTypes(db.pool, id)).includes('LLM_COMPLETED')).toBe(false);
      expect((await listProviderCalls(db.pool, id)).length).toBe(1); // it did call; the result was discarded

      // The real owner completes; exactly one outcome lands.
      await handler({ ...stale, leasedBy: 'w2', attempt: 2 });
      const types = await eventTypes(db.pool, id);
      expect(types.filter((t) => t === 'LLM_COMPLETED')).toHaveLength(1);
      const completed = (await getEvents(db.pool, id)).find((e) => e.event.type === 'LLM_COMPLETED')
        ?.event as LlmCompletedEvent;
      expect(completed.attempt).toBe(2);

      // and a redelivery after the outcome exists does not call the provider again
      const before = (await listProviderCalls(db.pool, id)).length;
      await handler({ ...stale, leasedBy: 'w2', attempt: 2 });
      expect((await listProviderCalls(db.pool, id)).length).toBe(before);
    });

    it('also rejects when the lease was reclaimed back to pending (no owner at all)', async () => {
      const provider = new MockProvider({ audit: audit(db.pool) });
      cluster = startCluster(db.pool, { provider, workflows: [oneStep], withoutLlmWorker: true });
      const id = await startWorkflow(db.pool, oneStep, { prompt: 'reclaimed' });
      await waitForEventType(db.pool, id, 'LLM_REQUESTED');
      await cluster.stop();
      cluster = null;

      const [stale] = await dequeue(db.pool, {
        workerId: 'w1',
        taskType: 'llm',
        limit: 1,
        leaseSeconds: 30,
      });
      if (!stale) throw new Error('expected an llm task');
      await db.pool.query(
        `UPDATE tasks SET status = 'pending', leased_by = NULL, lease_expires_at = NULL WHERE id = $1`,
        [stale.id],
      );
      const handler = createLlmCallHandler(db.pool, { provider, workflows: [oneStep] });
      await expect(handler(stale)).rejects.toBeInstanceOf(LeaseLostError);
      expect((await eventTypes(db.pool, id)).includes('LLM_COMPLETED')).toBe(false);
    });
  });

  it('keeps the lease alive (heartbeat) while a provider call outlasts it: one call, no reclaim', async () => {
    // lease 2s, provider takes 3.5s, an aggressive reaper runs every 100ms.
    const provider = new MockProvider({ audit: audit(db.pool), latencyMs: 3_500 });
    cluster = startCluster(db.pool, {
      provider,
      workflows: [oneStep],
      leaseSeconds: 2,
      heartbeatIntervalMs: 400,
      reaperIntervalMs: 100,
    });
    const id = await startWorkflow(db.pool, oneStep, { prompt: 'slow call' });
    await waitForStatus(db.pool, id, 'COMPLETED', 20_000);

    expect(await countProviderCallsByStep(db.pool, id)).toEqual({ 'llm-0': 1 });
    const { rows } = await db.pool.query<{ attempt: number }>(
      `SELECT attempt FROM tasks WHERE workflow_id = $1 AND task_type = 'llm'`,
      [id],
    );
    expect(rows[0]?.attempt).toBe(1); // never reclaimed, never re-leased
  });

  describe('storage controls', () => {
    it('truncates an oversized prompt/response, flags it, and still sends the FULL prompt to the provider', async () => {
      const bigPrompt = 'p'.repeat(3_000);
      const bigOutput = 'o'.repeat(4_000);
      const provider = new MockProvider({ audit: audit(db.pool) });
      const config = loadLlmStepConfig({}, { maxStoredBytes: 1_000 });
      cluster = startCluster(db.pool, { provider, workflows: [oneStep], llmConfig: config });

      const params = { mockOutput: bigOutput };
      const id = await startWorkflow(db.pool, oneStep, { prompt: bigPrompt, params });
      await waitForStatus(db.pool, id, 'COMPLETED');

      const events = await getEvents(db.pool, id);
      const requested = events.find((e) => e.event.type === 'LLM_REQUESTED')
        ?.event as LlmRequestedEvent;
      const completed = events.find((e) => e.event.type === 'LLM_COMPLETED')
        ?.event as LlmCompletedEvent;
      expect(requested.requestStorage).toBe('truncated');
      expect(Buffer.byteLength(JSON.stringify(requested.request))).toBeLessThanOrEqual(1_000);
      expect(completed.truncated).toBe(true);
      expect(Buffer.byteLength(completed.text)).toBeLessThanOrEqual(1_000);

      // The provider received the complete, unmodified request.
      const calls = await listProviderCalls(db.pool, id);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.requestHash).toBe(hashLlmRequest(llmReq(bigPrompt, params)));
      expect(requested.requestHash).toBe(hashLlmRequest(llmReq(bigPrompt, params)));
    });

    it('KARYAKRAM_STORE_PROMPTS=false: the event log holds only hashes, yet the call still executes correctly', async () => {
      const secretPrompt = 'highly confidential customer data 4111-1111-1111-1111';
      const provider = new MockProvider({ audit: audit(db.pool) });
      const config = loadLlmStepConfig({ KARYAKRAM_STORE_PROMPTS: 'false' });
      cluster = startCluster(db.pool, { provider, workflows: [oneStep], llmConfig: config });

      const id = await startWorkflow(db.pool, oneStep, {
        prompt: secretPrompt,
        params: { mockOutput: 'ok' },
      });
      await waitForStatus(db.pool, id, 'COMPLETED');

      const events = await getEvents(db.pool, id);
      const requested = events.find((e) => e.event.type === 'LLM_REQUESTED')
        ?.event as LlmRequestedEvent;
      expect(requested.requestStorage).toBe('none');
      expect(requested.request).toBeUndefined();
      expect(requested.requestHash).toHaveLength(64);
      // the WorkflowStarted input is the caller's own data; the *prompt* is what must not be stored
      const llmEvents = JSON.stringify(
        events.filter((e) => e.event.type.startsWith('LLM_')).map((e) => e.event),
      );
      expect(llmEvents).not.toContain('confidential');

      // the provider still received the real prompt, recovered by re-deriving it from the workflow
      const calls = await listProviderCalls(db.pool, id);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.requestHash).toBe(
        hashLlmRequest(llmReq(secretPrompt, { mockOutput: 'ok' })),
      );
    });

    it('redacts API-key-like strings in the stored prompt but sends the original to the provider', async () => {
      const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrSt';
      const prompt = `please use ${key} to authenticate`;
      const provider = new MockProvider({ audit: audit(db.pool) });
      cluster = startCluster(db.pool, { provider, workflows: [oneStep] });

      const id = await startWorkflow(db.pool, oneStep, { prompt });
      await waitForStatus(db.pool, id, 'COMPLETED');

      const events = await getEvents(db.pool, id);
      const requested = events.find((e) => e.event.type === 'LLM_REQUESTED')
        ?.event as LlmRequestedEvent;
      expect(requested.requestStorage).toBe('redacted');
      expect(JSON.stringify(requested.request)).not.toContain('AbCdEfGhIjKl');
      expect(JSON.stringify(requested.request)).toContain('[REDACTED]');

      const calls = await listProviderCalls(db.pool, id);
      expect(calls[0]?.requestHash).toBe(hashLlmRequest(llmReq(prompt)));
    });
  });

  it('waits for the in-flight step rather than racing: an unrelated pollUntil sanity check', async () => {
    // guards the harness itself: pollUntil must time out, not hang
    await expect(pollUntil(() => Promise.resolve(false), { timeoutMs: 100 })).rejects.toThrow(
      /never became true/,
    );
  });
});
