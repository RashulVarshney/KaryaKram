import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropicProvider';
import { createProviderFromEnv } from './config';
import { LlmConfigError } from './errors';
import { MockProvider } from './mockProvider';

describe('createProviderFromEnv', () => {
  it('defaults to the mock provider', () => {
    expect(createProviderFromEnv({})).toBeInstanceOf(MockProvider);
    expect(createProviderFromEnv({ LLM_PROVIDER: 'mock' })).toBeInstanceOf(MockProvider);
  });

  it('refuses anthropic without a key — and never falls back to the mock', () => {
    const attempt = (): unknown => createProviderFromEnv({ LLM_PROVIDER: 'anthropic' });
    expect(attempt).toThrow(LlmConfigError);
    expect(attempt).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(attempt).toThrow(/silently fall back/);
  });

  it('builds the anthropic provider when a key is present (no network call is made)', () => {
    const provider = createProviderFromEnv({
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_MODEL: 'claude-test',
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('anthropic');
  });

  it('rejects an unknown provider name', () => {
    expect(() => createProviderFromEnv({ LLM_PROVIDER: 'openai' })).toThrow(/Unknown LLM_PROVIDER/);
  });

  it('configures mock latency and scripted failures from env', async () => {
    const provider = createProviderFromEnv({
      LLM_PROVIDER: 'mock',
      MOCK_LLM_FAILURES: '[{"on":429,"failAttempts":1,"retryAfterMs":10}]',
    });
    await expect(
      provider.complete({ model: 'default', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 10 });
  });
});
