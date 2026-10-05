import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@karyakram/core';
import {
  AnthropicProvider,
  mapAnthropicError,
  type AnthropicMessagesClient,
} from './anthropicProvider';
import { LlmProviderError } from './errors';

const request: LlmRequest = {
  model: 'default',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ],
};

function providerWith(client: AnthropicMessagesClient): AnthropicProvider {
  return new AnthropicProvider({ apiKey: 'unused', defaultModel: 'claude-test', client });
}

describe('AnthropicProvider.buildParams', () => {
  const provider = providerWith({
    messages: { create: () => Promise.reject(new Error('no network')) },
  });

  it('moves system messages to `system`, resolves the default model, sets max_tokens', () => {
    const params = provider.buildParams(request);
    expect(params.system).toBe('Be brief.');
    expect(params.model).toBe('claude-test');
    expect(params.max_tokens).toBe(4096);
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect('temperature' in params).toBe(false);
  });

  it('only forwards temperature, maxTokens and tools when the request asks for them', () => {
    const params = provider.buildParams({
      ...request,
      model: 'claude-x',
      params: { temperature: 0.2, maxTokens: 123 },
      tools: [
        { name: 'lookup', description: 'd', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    expect(params.model).toBe('claude-x');
    expect(params.temperature).toBe(0.2);
    expect(params.max_tokens).toBe(123);
    expect(params.tools?.[0]).toMatchObject({ name: 'lookup', description: 'd' });
  });
});

describe('AnthropicProvider.complete', () => {
  it('maps text, tool_use blocks and usage from the response', async () => {
    const provider = providerWith({
      messages: {
        create: () =>
          Promise.resolve({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-served',
            stop_reason: 'tool_use',
            stop_sequence: null,
            content: [
              { type: 'text', text: 'Looking it up. ' },
              { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { id: 7 } },
            ],
            usage: { input_tokens: 11, output_tokens: 22 },
          } as unknown as Anthropic.Message),
      },
    });
    const res = await provider.complete(request);
    expect(res.text).toBe('Looking it up. ');
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'lookup', arguments: { id: 7 } }]);
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(res.model).toBe('claude-served');
    expect(res.stopReason).toBe('tool_use');
  });

  it('turns SDK failures into typed LlmProviderErrors', async () => {
    const provider = providerWith({
      messages: {
        create: () =>
          Promise.reject(
            Anthropic.APIError.generate(429, {}, 'slow down', new Headers({ 'retry-after': '3' })),
          ),
      },
    });
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'LlmProviderError',
      retryable: true,
      retryAfterMs: 3000,
    });
  });
});

describe('mapAnthropicError', () => {
  const gen = (status: number, headers?: Headers): unknown =>
    Anthropic.APIError.generate(status, {}, `status ${String(status)}`, headers ?? new Headers());

  it('429 is retryable and honours retry-after / retry-after-ms', () => {
    expect(mapAnthropicError(gen(429, new Headers({ 'retry-after': '2' })))).toMatchObject({
      retryable: true,
      code: 'rate_limit',
      status: 429,
      retryAfterMs: 2000,
    });
    expect(mapAnthropicError(gen(429, new Headers({ 'retry-after-ms': '250' })))).toMatchObject({
      retryAfterMs: 250,
    });
  });

  it('every 5xx (including 529 overloaded) is retryable', () => {
    for (const status of [500, 502, 503, 529]) {
      expect(mapAnthropicError(gen(status))).toMatchObject({
        retryable: true,
        code: 'server_error',
      });
    }
  });

  it('other 4xx are not retryable', () => {
    expect(mapAnthropicError(gen(400))).toMatchObject({
      retryable: false,
      code: 'invalid_request',
    });
    expect(mapAnthropicError(gen(401))).toMatchObject({ retryable: false, code: 'auth' });
    expect(mapAnthropicError(gen(404))).toMatchObject({
      retryable: false,
      code: 'invalid_request',
    });
  });

  it('timeouts and connection errors are retryable; unknown errors are not', () => {
    expect(mapAnthropicError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({
      retryable: true,
      code: 'timeout',
    });
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'reset' }))).toMatchObject(
      {
        retryable: true,
        code: 'connection',
      },
    );
    expect(mapAnthropicError(new Error('boom'))).toMatchObject({
      retryable: false,
      code: 'unknown',
    });
  });

  it('passes an LlmProviderError through unchanged', () => {
    const original = new LlmProviderError('x', { retryable: true, code: 'timeout' });
    expect(mapAnthropicError(original)).toBe(original);
  });
});
