import { describe, expect, it } from 'vitest';
import type { StoredWorkflowEvent } from '@karyakram/core';
import { describeStepEvent, replayedStepSeqs, toDagStep } from './llmView';

const ev = (seq: number, event: StoredWorkflowEvent['event']): StoredWorkflowEvent => ({
  seq,
  event,
});

const requested = (seq: number, stepId: string): StoredWorkflowEvent =>
  ev(seq, {
    type: 'LLM_REQUESTED',
    stepId,
    requestHash: 'abcdef0123456789',
    requestStorage: 'full',
    request: { model: 'default', messages: [{ role: 'user', content: 'classify this' }] },
    maxAttempts: 5,
  });

const completed = (seq: number, scheduled: number, stepId: string): StoredWorkflowEvent =>
  ev(seq, {
    type: 'LLM_COMPLETED',
    stepId,
    scheduledEventSeq: scheduled,
    requestHash: 'abcdef0123456789',
    text: 'billing',
    toolCalls: [],
    truncated: false,
    model: 'mock-1',
    tokensIn: 12,
    tokensOut: 3,
    latencyMs: 40,
    estimatedCostUsd: 0.000018,
    attempt: 2,
  });

describe('toDagStep', () => {
  it('maps llm and tool requests to nodes, and ignores outcomes', () => {
    expect(toDagStep(requested(2, 'llm-0'))).toEqual({ seq: 2, kind: 'llm', label: 'LLM llm-0' });
    expect(
      toDagStep(
        ev(5, {
          type: 'TOOL_REQUESTED',
          stepId: 'tool-0',
          tool: 'send_reply',
          args: {},
          argsHash: 'h',
          maxAttempts: 3,
        }),
      ),
    ).toEqual({ seq: 5, kind: 'tool', label: 'tool send_reply (tool-0)' });
    expect(toDagStep(completed(3, 2, 'llm-0'))).toBeNull();
  });
});

describe('replayedStepSeqs', () => {
  it('marks a completion replayed only once a later decision was made by re-running the workflow', () => {
    const history = [
      ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: {} }),
      requested(2, 'llm-0'),
      completed(3, 2, 'llm-0'),
    ];
    // nothing decided after the completion yet: it has not been reused by any replay
    expect([...replayedStepSeqs(history)]).toEqual([]);

    const next = [...history, requested(4, 'llm-1')];
    expect([...replayedStepSeqs(next)]).toEqual([3]);

    const done = [
      ...next,
      completed(5, 4, 'llm-1'),
      ev(6, { type: 'WorkflowCompleted', result: 1 }),
    ];
    expect([...replayedStepSeqs(done)].sort()).toEqual([3, 5]);
  });

  it('is empty for a log with no llm/tool completions', () => {
    expect(
      replayedStepSeqs([ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: {} })]).size,
    ).toBe(0);
  });
});

describe('describeStepEvent', () => {
  it('shows the prompt for a stored request and a hash-only note otherwise', () => {
    expect(describeStepEvent(requested(2, 'llm-0'), false)?.blocks[0]?.text).toBe(
      'user: classify this',
    );
    const hashOnly = ev(2, {
      type: 'LLM_REQUESTED',
      stepId: 'llm-0',
      requestHash: 'abcdef0123456789',
      requestStorage: 'none',
      maxAttempts: 5,
    });
    const d = describeStepEvent(hashOnly, false);
    expect(d?.blocks[0]?.text).toMatch(/hash only/);
    expect(d?.badges).toEqual(['none']);
  });

  it('shows response, tokens, latency, cost, attempt and the replayed badge', () => {
    const d = describeStepEvent(completed(3, 2, 'llm-0'), true);
    expect(d?.badges).toEqual(['replayed']);
    expect(d?.blocks[0]).toEqual({ label: 'response', text: 'billing' });
    expect(Object.fromEntries(d?.rows ?? [])).toMatchObject({
      model: 'mock-1',
      'tokens in / out': '12 / 3',
      latency: '40 ms',
      'est. cost': '$0.000018',
      attempt: '2',
    });
    expect(describeStepEvent(completed(3, 2, 'llm-0'), false)?.badges).toEqual([]);
  });

  it('flags truncation and unknown prices', () => {
    const e = completed(3, 2, 'llm-0');
    if (e.event.type !== 'LLM_COMPLETED') throw new Error('x');
    const d = describeStepEvent(
      ev(3, { ...e.event, truncated: true, estimatedCostUsd: null }),
      false,
    );
    expect(d?.badges).toEqual(['truncated']);
    expect(Object.fromEntries(d?.rows ?? [])['est. cost']).toBe('unknown price');
  });

  it('describes tool events and returns null for other event types', () => {
    const d = describeStepEvent(
      ev(4, {
        type: 'TOOL_COMPLETED',
        stepId: 'tool-0',
        scheduledEventSeq: 3,
        tool: 'send_reply',
        result: { messageId: 'm' },
        latencyMs: 5,
        attempt: 1,
      }),
      true,
    );
    expect(d?.badges).toEqual(['replayed']);
    expect(d?.blocks[0]?.text).toContain('messageId');
    expect(
      describeStepEvent(ev(1, { type: 'WorkflowStarted', workflowType: 'w', input: {} }), false),
    ).toBeNull();
  });
});
