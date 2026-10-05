import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalLlmRequest, canonicalToolCall, normalizeLlmRequest } from './llm';

describe('canonicalJson', () => {
  it('is independent of key insertion order, recursively', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'z' } };
    const b = { a: { c: 'z', d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"z","d":[1,{"x":1,"y":2}]},"b":1}');
  });

  it('drops undefined object members but keeps array positions', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('serializes dates through toJSON instead of as empty objects', () => {
    expect(canonicalJson({ at: new Date('2026-01-02T03:04:05.000Z') })).toBe(
      '{"at":"2026-01-02T03:04:05.000Z"}',
    );
  });

  it('distinguishes values that differ', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('canonicalLlmRequest', () => {
  const base = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('treats absent params/tools the same as empty ones', () => {
    expect(canonicalLlmRequest(base)).toBe(canonicalLlmRequest({ ...base, params: {}, tools: [] }));
    expect(normalizeLlmRequest(base).params).toEqual({});
  });

  it('changes when the model, a message, a param or a tool changes', () => {
    const ref = canonicalLlmRequest(base);
    expect(canonicalLlmRequest({ ...base, model: 'other' })).not.toBe(ref);
    expect(canonicalLlmRequest({ ...base, messages: [{ role: 'user', content: 'hi!' }] })).not.toBe(
      ref,
    );
    expect(canonicalLlmRequest({ ...base, params: { temperature: 0 } })).not.toBe(ref);
    expect(
      canonicalLlmRequest({ ...base, tools: [{ name: 't', inputSchema: { type: 'object' } }] }),
    ).not.toBe(ref);
  });
});

describe('canonicalToolCall', () => {
  it('is stable across key order and treats missing args as null', () => {
    expect(canonicalToolCall('t', { b: 1, a: 2 })).toBe(canonicalToolCall('t', { a: 2, b: 1 }));
    expect(canonicalToolCall('t', undefined)).toBe(canonicalToolCall('t', null));
    expect(canonicalToolCall('t', 1)).not.toBe(canonicalToolCall('u', 1));
  });
});
