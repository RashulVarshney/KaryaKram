import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@karyakram/core';
import {
  buildStoredRequest,
  capResponse,
  loadLlmStepConfig,
  redactSecrets,
  truncateUtf8,
} from './llmConfig';

const cfg = (over: Parameters<typeof loadLlmStepConfig>[1] = {}) => loadLlmStepConfig({}, over);

const req = (content: string): LlmRequest => ({
  model: 'default',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content },
  ],
});

describe('loadLlmStepConfig', () => {
  it('defaults: prompts stored, 256KB cap, 5 attempts', () => {
    const c = loadLlmStepConfig({});
    expect(c.storePrompts).toBe(true);
    expect(c.maxStoredBytes).toBe(262144);
    expect(c.maxAttempts).toBe(5);
  });

  it('reads KARYAKRAM_STORE_PROMPTS=false and numeric overrides from env', () => {
    const c = loadLlmStepConfig({
      KARYAKRAM_STORE_PROMPTS: 'false',
      KARYAKRAM_MAX_STORED_BYTES: '1024',
      KARYAKRAM_LLM_MAX_ATTEMPTS: '2',
    });
    expect(c).toMatchObject({ storePrompts: false, maxStoredBytes: 1024, maxAttempts: 2 });
  });

  it('rejects a non-positive size cap', () => {
    expect(() => loadLlmStepConfig({ KARYAKRAM_MAX_STORED_BYTES: '0' })).toThrow(
      /positive integer/,
    );
  });
});

describe('truncateUtf8', () => {
  it('leaves short text alone', () => {
    expect(truncateUtf8('hello', 10)).toEqual({ text: 'hello', truncated: false });
  });

  it('cuts at a byte budget without splitting a multi-byte character', () => {
    // each "é" is 2 bytes; a budget of 5 bytes must yield 2 whole characters (4 bytes), not a broken third
    const out = truncateUtf8('ééééé', 5);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe('éé');
    expect(out.text).not.toContain('�');
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(5);
  });

  it('handles 4-byte characters at the boundary', () => {
    const out = truncateUtf8('a😀b', 3);
    expect(out.text).toBe('a');
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(3);
  });
});

describe('redactSecrets', () => {
  it('strips API-key-like strings', () => {
    const samples = [
      'key sk-ant-api03-AbCdEfGhIjKlMnOp',
      'openai sk-AbCdEfGhIjKlMnOpQrStUvWx',
      'aws AKIAIOSFODNN7EXAMPLE',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'slack xoxb-1234567890-abcdefghij',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    ];
    for (const s of samples) {
      const out = redactSecrets(s);
      expect(out).toContain('[REDACTED]');
      expect(out).not.toMatch(/AbCdEfGhIjKl|IOSFODNN7EXAMPLE|abcdefghijklmnopqrstuvwxyz0123/);
    }
  });

  it('redacts the value of key=value style secrets but keeps the key name', () => {
    expect(redactSecrets('api_key: "abcdef1234567890"')).toBe('api_key: "[REDACTED]"');
    expect(redactSecrets('password=hunter2hunter2hunter2')).toBe('password=[REDACTED]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'My invoice #1234 is wrong, please refund the sk8ter shoes order';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('buildStoredRequest', () => {
  it('stores verbatim as `full` when nothing needs changing', () => {
    const r = req('hi');
    expect(buildStoredRequest(r, cfg())).toEqual({ requestStorage: 'full', request: r });
  });

  it('stores nothing but the hash when prompts are disabled', () => {
    expect(buildStoredRequest(req('secret prompt'), cfg({ storePrompts: false }))).toEqual({
      requestStorage: 'none',
    });
  });

  it('marks the copy `redacted` and strips the secret from what is stored', () => {
    const out = buildStoredRequest(req('use sk-ant-api03-AbCdEfGhIjKlMnOp please'), cfg());
    expect(out.requestStorage).toBe('redacted');
    expect(JSON.stringify(out.request)).not.toContain('AbCdEfGhIjKl');
    expect(JSON.stringify(out.request)).toContain('[REDACTED]');
  });

  it('shrinks to the cap and flags `truncated` for an oversized prompt', () => {
    const big = req('x'.repeat(5000));
    const out = buildStoredRequest(big, cfg({ maxStoredBytes: 1000 }));
    expect(out.requestStorage).toBe('truncated');
    expect(Buffer.byteLength(JSON.stringify(out.request))).toBeLessThanOrEqual(1000);
    expect(out.request?.messages[0]?.role).toBe('system');
  });
});

describe('capResponse', () => {
  it('passes a small response through untouched', () => {
    const r = capResponse('ok', [{ id: '1', name: 't', arguments: {} }], 1000);
    expect(r).toEqual({
      text: 'ok',
      toolCalls: [{ id: '1', name: 't', arguments: {} }],
      truncated: false,
    });
  });

  it('truncates text and sets the flag', () => {
    const r = capResponse('y'.repeat(100), [], 10);
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(10);
  });

  it('drops tool calls that do not fit and sets the flag', () => {
    const calls = [
      { id: '1', name: 'a', arguments: { v: 'x'.repeat(10) } },
      { id: '2', name: 'b', arguments: { v: 'y'.repeat(500) } },
    ];
    const r = capResponse('', calls, 100);
    expect(r.toolCalls.map((c) => c.id)).toEqual(['1']);
    expect(r.truncated).toBe(true);
  });
});
