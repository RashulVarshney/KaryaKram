import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@karyakram/core';
import { InMemoryProviderCallAudit } from './audit';
import { LlmProviderError } from './errors';
import { hashLlmRequest } from './hash';
import { MockProvider } from './mockProvider';

const request: LlmRequest = {
  model: 'default',
  messages: [
    { role: 'system', content: 'You classify tickets.' },
    { role: 'user', content: 'My invoice is wrong' },
  ],
};
const ctx = { workflowId: 'wf-1', stepId: 'llm-0', attempt: 1 };

describe('MockProvider determinism', () => {
  it('returns an identical response for an identical request, regardless of key order', async () => {
    const provider = new MockProvider();
    const a = await provider.complete(request, ctx);
    const b = await provider.complete(
      { messages: request.messages, model: request.model, params: {}, tools: [] },
      ctx,
    );
    expect(b).toEqual(a);
    expect(a.model).toBe('mock-1');
    expect(a.usage.inputTokens).toBeGreaterThan(0);
  });

  it('returns a different response for a different request', async () => {
    const provider = new MockProvider();
    const a = await provider.complete(request, ctx);
    const b = await provider.complete(
      { ...request, messages: [{ role: 'user', content: 'something else' }] },
      ctx,
    );
    expect(b.text).not.toBe(a.text);
  });

  it('honours mockOutput and mockToolCall', async () => {
    const provider = new MockProvider();
    const res = await provider.complete(
      {
        ...request,
        params: { mockOutput: 'billing', mockToolCall: { name: 'lookup', arguments: { id: 1 } } },
      },
      ctx,
    );
    expect(res.text).toBe('billing');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({ name: 'lookup', arguments: { id: 1 } });
    expect(res.stopReason).toBe('tool_use');
  });

  it('simulates and reports configured latency without real waiting when sleep is injected', async () => {
    const slept: number[] = [];
    const provider = new MockProvider({
      latencyMs: 250,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const res = await provider.complete(request, ctx);
    expect(slept).toEqual([250]);
    expect(res.latencyMs).toBe(250);
  });
});

describe('MockProvider audit', () => {
  it('records every invocation with a hash computed from the request it actually received', async () => {
    const audit = new InMemoryProviderCallAudit();
    const provider = new MockProvider({ audit });
    await provider.complete(request, ctx);
    await provider.complete(request, { ...ctx, attempt: 2 });
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]).toEqual({
      workflowId: 'wf-1',
      stepId: 'llm-0',
      requestHash: hashLlmRequest(request),
      attempt: 1,
    });
    expect(audit.entries[1]?.attempt).toBe(2);
  });

  it('records calls that then fail', async () => {
    const audit = new InMemoryProviderCallAudit();
    const provider = new MockProvider({ audit, failures: [{ on: 500, failAttempts: 1 }] });
    await expect(provider.complete(request, ctx)).rejects.toBeInstanceOf(LlmProviderError);
    expect(audit.entries).toHaveLength(1);
  });
});

describe('MockProvider scripted failures', () => {
  it('fails retryably with retryAfterMs for 429 while attempt <= failAttempts, then succeeds', async () => {
    const provider = new MockProvider({
      failures: [{ on: 429, failAttempts: 2, retryAfterMs: 1500 }],
    });
    for (const attempt of [1, 2]) {
      const err = await provider.complete(request, { ...ctx, attempt }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmProviderError);
      expect(err).toMatchObject({
        retryable: true,
        code: 'rate_limit',
        status: 429,
        retryAfterMs: 1500,
      });
    }
    await expect(provider.complete(request, { ...ctx, attempt: 3 })).resolves.toBeDefined();
  });

  it('classifies 500 and timeout as retryable and 400 as not', async () => {
    const cases = [
      [{ on: 500 as const, failAttempts: 1 }, true, 'server_error'],
      [{ on: 'timeout' as const, failAttempts: 1 }, true, 'timeout'],
      [{ on: 400 as const, failAttempts: 1 }, false, 'invalid_request'],
    ] as const;
    for (const [rule, retryable, code] of cases) {
      const err = await new MockProvider({ failures: [rule] })
        .complete(request, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ retryable, code });
    }
  });

  it('can target one step or one request hash', async () => {
    const provider = new MockProvider({
      failures: [{ on: 500, failAttempts: 9, stepId: 'llm-1' }],
    });
    await expect(provider.complete(request, ctx)).resolves.toBeDefined();
    await expect(provider.complete(request, { ...ctx, stepId: 'llm-1' })).rejects.toBeInstanceOf(
      LlmProviderError,
    );
  });
});
