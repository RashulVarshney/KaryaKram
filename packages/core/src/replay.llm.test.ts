import { describe, expect, it } from 'vitest';
import type { LlmRequest } from './llm';
import { NonDeterminismError, replay, StepRequestMismatchError, type WorkflowFn } from './replay';
import { foldEvents, type StoredWorkflowEvent } from './workflow';

// A stand-in for sha256: stable, cheap, and obviously not a real hash.
const hash = (canonical: string): string => `h(${canonical})`.padEnd(64, '0');
const opts = { hash };

function ev(seq: number, event: StoredWorkflowEvent['event']): StoredWorkflowEvent {
  return { seq, event };
}

const req = (content: string): LlmRequest => ({
  model: 'default',
  messages: [{ role: 'user', content }],
});

const twoStep: WorkflowFn<{ topic: string }, { summary: string }> = async (input, ctx) => {
  const first = await ctx.llmCall(req(`classify ${input.topic}`));
  const second = await ctx.llmCall(req(`draft for ${first.text}`));
  return { summary: second.text };
};

// The real canonical string, via the engine itself, so tests don't depend on key order by hand.
async function firstCommandHash<I, R>(wf: WorkflowFn<I, R>, input: I): Promise<string> {
  const r = await replay(wf, input, [], opts);
  const cmd = r.commands[0];
  if (!cmd || cmd.type !== 'RequestLlmCall') throw new Error('expected RequestLlmCall');
  return cmd.requestHash;
}

function completed(
  seq: number,
  scheduledSeq: number,
  stepId: string,
  text: string,
  requestHash: string,
): StoredWorkflowEvent {
  return ev(seq, {
    type: 'LLM_COMPLETED',
    stepId,
    scheduledEventSeq: scheduledSeq,
    requestHash,
    text,
    toolCalls: [],
    truncated: false,
    model: 'mock-1',
    tokensIn: 10,
    tokensOut: 5,
    latencyMs: 1,
    estimatedCostUsd: 0.001,
    attempt: 1,
  });
}

describe('replay: llmCall', () => {
  it('emits a RequestLlmCall command with a position-derived step id on first reach', async () => {
    const result = await replay(twoStep, { topic: 'x' }, [], opts);
    expect(result.status).toBe('RUNNING');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ type: 'RequestLlmCall', stepId: 'llm-0' });
    expect(result.pendingLlmRequests).toBeUndefined();
  });

  it('while a call is in flight emits nothing and exposes the pending request', async () => {
    const hash0 = await firstCommandHash(twoStep, { topic: 'x' });
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { topic: 'x' } }),
      ev(2, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-0',
        requestHash: hash0,
        requestStorage: 'none',
        maxAttempts: 5,
      }),
    ];
    const result = await replay(twoStep, { topic: 'x' }, history, opts);
    expect(result.commands).toEqual([]);
    expect(result.pendingLlmRequests).toEqual({ 'llm-0': req('classify x') });
  });

  it('reuses a recorded output and moves on to the next step without re-requesting', async () => {
    const hash0 = await firstCommandHash(twoStep, { topic: 'x' });
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { topic: 'x' } }),
      ev(2, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-0',
        requestHash: hash0,
        requestStorage: 'full',
        request: req('classify x'),
        maxAttempts: 5,
      }),
      completed(3, 2, 'llm-0', 'billing', hash0),
    ];
    const result = await replay(twoStep, { topic: 'x' }, history, opts);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ type: 'RequestLlmCall', stepId: 'llm-1' });
    // the second request is built from the *recorded* first output
    expect(result.commands[0]).toMatchObject({ request: req('draft for billing') });
  });

  it('completes the workflow purely from recorded outputs', async () => {
    const h0 = await firstCommandHash(twoStep, { topic: 'x' });
    const afterFirst = await replay(
      twoStep,
      { topic: 'x' },
      [
        ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { topic: 'x' } }),
        ev(2, {
          type: 'LLM_REQUESTED',
          stepId: 'llm-0',
          requestHash: h0,
          requestStorage: 'full',
          request: req('classify x'),
          maxAttempts: 5,
        }),
        completed(3, 2, 'llm-0', 'billing', h0),
      ],
      opts,
    );
    const cmd = afterFirst.commands[0];
    if (!cmd || cmd.type !== 'RequestLlmCall') throw new Error('expected command');
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { topic: 'x' } }),
      ev(2, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-0',
        requestHash: h0,
        requestStorage: 'full',
        request: req('classify x'),
        maxAttempts: 5,
      }),
      completed(3, 2, 'llm-0', 'billing', h0),
      ev(4, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-1',
        requestHash: cmd.requestHash,
        requestStorage: 'full',
        request: cmd.request,
        maxAttempts: 5,
      }),
      completed(5, 4, 'llm-1', 'dear customer', cmd.requestHash),
    ];
    const result = await replay(twoStep, { topic: 'x' }, history, opts);
    expect(result.status).toBe('COMPLETED');
    expect(result.result).toEqual({ summary: 'dear customer' });
    expect(result.commands).toEqual([
      { type: 'CompleteWorkflow', result: { summary: 'dear customer' } },
    ]);
  });

  it('throws StepRequestMismatchError (a NonDeterminismError) when the request hash changed', async () => {
    const h0 = await firstCommandHash(twoStep, { topic: 'x' });
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { topic: 'x' } }),
      ev(2, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-0',
        requestHash: h0,
        requestStorage: 'full',
        request: req('classify x'),
        maxAttempts: 5,
      }),
      completed(3, 2, 'llm-0', 'billing', h0),
    ];
    // same history, but the deployed code's prompt changed
    const changed: WorkflowFn<{ topic: string }, string> = async (input, ctx) =>
      (await ctx.llmCall(req(`NEW PROMPT ${input.topic}`))).text;
    const err = await replay(changed, { topic: 'x' }, history, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepRequestMismatchError);
    expect(err).toBeInstanceOf(NonDeterminismError);
    expect((err as Error).message).toMatch(/llm-0/);
    expect((err as Error).message).toMatch(/refusing to silently re-call/);
  });

  it('rejects the awaited promise for an LLM_FAILED step so workflow code can handle it', async () => {
    const h0 = await firstCommandHash(twoStep, { topic: 'x' });
    const resilient: WorkflowFn<{ topic: string }, string> = async (input, ctx) => {
      try {
        return (await ctx.llmCall(req(`classify ${input.topic}`))).text;
      } catch (err) {
        return `fallback: ${(err as Error).message}`;
      }
    };
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { topic: 'x' } }),
      ev(2, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-0',
        requestHash: h0,
        requestStorage: 'full',
        request: req('classify x'),
        maxAttempts: 5,
      }),
      ev(3, {
        type: 'LLM_FAILED',
        stepId: 'llm-0',
        scheduledEventSeq: 2,
        error: 'boom',
        code: 'invalid_request',
        retryable: false,
        attempts: 1,
      }),
    ];
    const result = await replay(resilient, { topic: 'x' }, history, opts);
    expect(result.result).toBe('fallback: boom');
  });

  it('emits two commands for two concurrent calls, with distinct step ids', async () => {
    const parallel: WorkflowFn<unknown, string[]> = async (_i, ctx) =>
      (await Promise.all([ctx.llmCall(req('a')), ctx.llmCall(req('b'))])).map((r) => r.text);
    const result = await replay(parallel, {}, [], opts);
    expect(result.commands.map((c) => (c.type === 'RequestLlmCall' ? c.stepId : c.type))).toEqual([
      'llm-0',
      'llm-1',
    ]);
  });

  it('fails loudly if llmCall is used without a hash function', async () => {
    const result = await replay(twoStep, { topic: 'x' }, []);
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/options\.hash is required/);
  });

  it('is deterministic: the same history always yields the same commands', async () => {
    const a = await replay(twoStep, { topic: 'x' }, [], opts);
    const b = await replay(twoStep, { topic: 'x' }, [], opts);
    expect(b).toEqual(a);
  });
});

describe('foldEvents: llm calls', () => {
  it('tracks status, tokens, latency and cost per LLM_REQUESTED seq', () => {
    const state = foldEvents([
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: {} }),
      ev(2, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-0',
        requestHash: 'h',
        requestStorage: 'full',
        request: req('x'),
        maxAttempts: 5,
      }),
    ]);
    expect(state.llmCalls[2]).toMatchObject({
      stepId: 'llm-0',
      status: 'REQUESTED',
      requestHash: 'h',
    });

    const done = foldEvents([
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: {} }),
      ev(2, {
        type: 'LLM_REQUESTED',
        stepId: 'llm-0',
        requestHash: 'h',
        requestStorage: 'full',
        request: req('x'),
        maxAttempts: 5,
      }),
      completed(3, 2, 'llm-0', 'out', 'h'),
    ]);
    expect(done.llmCalls[2]).toMatchObject({
      status: 'COMPLETED',
      text: 'out',
      model: 'mock-1',
      tokensIn: 10,
      tokensOut: 5,
      estimatedCostUsd: 0.001,
    });
  });

  it('ignores an outcome that points at an unknown request', () => {
    const state = foldEvents([completed(1, 99, 'llm-0', 'x', 'h')]);
    expect(state.llmCalls).toEqual({});
  });
});
