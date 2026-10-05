import { describe, expect, it } from 'vitest';
import { replay, StepRequestMismatchError, type WorkflowFn } from './replay';
import { foldEvents, type StoredWorkflowEvent } from './workflow';

const hash = (canonical: string): string => `h(${canonical})`.padEnd(64, '0');
const opts = { hash };
const ev = (seq: number, event: StoredWorkflowEvent['event']): StoredWorkflowEvent => ({
  seq,
  event,
});

const lookup: WorkflowFn<{ id: string }, string> = async (input, ctx) => {
  const customer = await ctx.toolCall<{ name: string }>('lookup_customer', { id: input.id });
  return customer.name;
};

async function argsHash(): Promise<string> {
  const r = await replay(lookup, { id: 'c1' }, [], opts);
  const cmd = r.commands[0];
  if (!cmd || cmd.type !== 'RequestToolCall') throw new Error('expected RequestToolCall');
  return cmd.argsHash;
}

describe('replay: toolCall', () => {
  it('emits a RequestToolCall command with a position-derived step id', async () => {
    const r = await replay(lookup, { id: 'c1' }, [], opts);
    expect(r.commands).toEqual([
      {
        type: 'RequestToolCall',
        stepId: 'tool-0',
        tool: 'lookup_customer',
        args: { id: 'c1' },
        argsHash: await argsHash(),
      },
    ]);
  });

  it('resolves with the recorded result and completes without re-requesting', async () => {
    const h = await argsHash();
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { id: 'c1' } }),
      ev(2, {
        type: 'TOOL_REQUESTED',
        stepId: 'tool-0',
        tool: 'lookup_customer',
        args: { id: 'c1' },
        argsHash: h,
        maxAttempts: 3,
      }),
      ev(3, {
        type: 'TOOL_COMPLETED',
        stepId: 'tool-0',
        scheduledEventSeq: 2,
        tool: 'lookup_customer',
        result: { name: 'Ada' },
        latencyMs: 1,
        attempt: 1,
      }),
    ];
    const r = await replay(lookup, { id: 'c1' }, history, opts);
    expect(r.status).toBe('COMPLETED');
    expect(r.result).toBe('Ada');
    expect(r.commands).toEqual([{ type: 'CompleteWorkflow', result: 'Ada' }]);
  });

  it('stays quiet while the call is in flight', async () => {
    const h = await argsHash();
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { id: 'c1' } }),
      ev(2, {
        type: 'TOOL_REQUESTED',
        stepId: 'tool-0',
        tool: 'lookup_customer',
        args: { id: 'c1' },
        argsHash: h,
        maxAttempts: 3,
      }),
    ];
    const r = await replay(lookup, { id: 'c1' }, history, opts);
    expect(r).toEqual({ status: 'RUNNING', commands: [] });
  });

  it('rejects for a TOOL_FAILED outcome', async () => {
    const h = await argsHash();
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { id: 'c1' } }),
      ev(2, {
        type: 'TOOL_REQUESTED',
        stepId: 'tool-0',
        tool: 'lookup_customer',
        args: { id: 'c1' },
        argsHash: h,
        maxAttempts: 3,
      }),
      ev(3, {
        type: 'TOOL_FAILED',
        stepId: 'tool-0',
        scheduledEventSeq: 2,
        tool: 'lookup_customer',
        error: 'no such customer',
        code: 'tool_error',
        retryable: false,
        attempts: 1,
      }),
    ];
    const r = await replay(lookup, { id: 'c1' }, history, opts);
    expect(r.status).toBe('FAILED');
    expect(r.error).toBe('no such customer');
  });

  it('throws StepRequestMismatchError (tool wording) if the arguments changed', async () => {
    const h = await argsHash();
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: { id: 'c1' } }),
      ev(2, {
        type: 'TOOL_REQUESTED',
        stepId: 'tool-0',
        tool: 'lookup_customer',
        args: { id: 'c1' },
        argsHash: h,
        maxAttempts: 3,
      }),
    ];
    const err = await replay(lookup, { id: 'DIFFERENT' }, history, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepRequestMismatchError);
    expect((err as Error).message).toMatch(/tool-0/);
    expect((err as Error).message).toMatch(/refusing to silently re-execute the tool/);
  });

  it('numbers llm and tool steps independently: llm-0, tool-0, llm-1', async () => {
    const mixed: WorkflowFn<unknown, unknown> = async (_i, ctx) => {
      const a = ctx.llmCall({ model: 'default', messages: [{ role: 'user', content: 'a' }] });
      const t = ctx.toolCall('t', {});
      const b = ctx.llmCall({ model: 'default', messages: [{ role: 'user', content: 'b' }] });
      return Promise.all([a, t, b]);
    };
    const r = await replay(mixed, {}, [], opts);
    expect(r.commands.map((c) => ('stepId' in c ? c.stepId : c.type))).toEqual([
      'llm-0',
      'tool-0',
      'llm-1',
    ]);
  });
});

describe('foldEvents: tool calls', () => {
  it('tracks status and result per TOOL_REQUESTED seq', () => {
    const state = foldEvents([
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: {} }),
      ev(2, {
        type: 'TOOL_REQUESTED',
        stepId: 'tool-0',
        tool: 't',
        args: {},
        argsHash: 'h',
        maxAttempts: 3,
      }),
      ev(3, {
        type: 'TOOL_COMPLETED',
        stepId: 'tool-0',
        scheduledEventSeq: 2,
        tool: 't',
        result: 42,
        latencyMs: 7,
        attempt: 1,
      }),
    ]);
    expect(state.toolCalls[2]).toMatchObject({
      stepId: 'tool-0',
      tool: 't',
      status: 'COMPLETED',
      result: 42,
      latencyMs: 7,
    });
  });
});
