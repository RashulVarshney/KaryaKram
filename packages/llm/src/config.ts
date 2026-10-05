import type { ProviderCallAudit } from './audit';
import { AnthropicProvider } from './anthropicProvider';
import { LlmConfigError } from './errors';
import { MockProvider, type MockFailureRule } from './mockProvider';
import type { LLMProvider } from './types';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/**
 * Selects the provider from `LLM_PROVIDER` (`mock` | `anthropic`, default
 * `mock`). Choosing `anthropic` without `ANTHROPIC_API_KEY` throws — it
 * never quietly falls back to the mock, because that would make a
 * misconfigured production deployment look healthy while producing fake
 * output.
 */
export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: { audit?: ProviderCallAudit } = {},
): LLMProvider {
  const choice = (env['LLM_PROVIDER'] ?? 'mock').trim().toLowerCase();

  if (choice === 'mock') {
    const failures = env['MOCK_LLM_FAILURES']
      ? (JSON.parse(env['MOCK_LLM_FAILURES']) as MockFailureRule[])
      : undefined;
    const latency = env['MOCK_LLM_LATENCY_MS'];
    return new MockProvider({
      ...(deps.audit ? { audit: deps.audit } : {}),
      ...(failures ? { failures } : {}),
      ...(latency !== undefined ? { latencyMs: Number(latency) } : {}),
    });
  }

  if (choice === 'anthropic') {
    const apiKey = env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new LlmConfigError(
        'LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. Set the key, or set ' +
          'LLM_PROVIDER=mock. KaryaKram will not silently fall back to the mock provider.',
      );
    }
    return new AnthropicProvider({
      apiKey,
      defaultModel: env['ANTHROPIC_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL,
    });
  }

  throw new LlmConfigError(`Unknown LLM_PROVIDER "${choice}" (expected "mock" or "anthropic").`);
}
