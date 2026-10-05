import Anthropic from '@anthropic-ai/sdk';
import type { LlmRequest, LlmToolCall } from '@karyakram/core';
import { LlmProviderError } from './errors';
import type { LLMProvider, LlmResponse } from './types';

/** The one method we use, so tests can inject a fake client with no network. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Used when a request's model is the `'default'` sentinel. */
  defaultModel: string;
  defaultMaxTokens?: number;
  client?: AnthropicMessagesClient;
}

interface HeaderLike {
  get?: (name: string) => string | null;
  [key: string]: unknown;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as HeaderLike;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  const value = h[name];
  return typeof value === 'string' ? value : undefined;
}

function retryAfterMs(headers: unknown): number | undefined {
  const ms = readHeader(headers, 'retry-after-ms');
  if (ms !== undefined && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const seconds = readHeader(headers, 'retry-after');
  if (seconds !== undefined && Number.isFinite(Number(seconds))) {
    return Math.max(0, Number(seconds) * 1000);
  }
  return undefined;
}

/**
 * Classifies an SDK failure. Retryable: 408/409/429, every 5xx (including
 * 529 "overloaded"), timeouts and connection errors. Not retryable: other
 * 4xx. The SDK's own retries are turned off, because the engine owns
 * retry policy (durable, jittered, visible in the DLQ).
 */
export function mapAnthropicError(err: unknown): LlmProviderError {
  if (err instanceof LlmProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmProviderError(err.message, { retryable: true, code: 'timeout', cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmProviderError(err.message, { retryable: true, code: 'connection', cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const after = retryAfterMs(err.headers);
    const base = {
      status: status ?? 0,
      cause: err,
      ...(after !== undefined ? { retryAfterMs: after } : {}),
    };
    if (status === 429) {
      return new LlmProviderError(err.message, { retryable: true, code: 'rate_limit', ...base });
    }
    if (status !== undefined && (status >= 500 || status === 408 || status === 409)) {
      return new LlmProviderError(err.message, { retryable: true, code: 'server_error', ...base });
    }
    if (status === 401 || status === 403) {
      return new LlmProviderError(err.message, { retryable: false, code: 'auth', ...base });
    }
    return new LlmProviderError(err.message, {
      retryable: false,
      code: 'invalid_request',
      ...base,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(message, { retryable: false, code: 'unknown', cause: err });
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: AnthropicMessagesClient;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.defaultModel = options.defaultModel;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
  }

  /** Builds the Messages API request. Exposed for tests; no network involved. */
  buildParams(request: LlmRequest): Anthropic.MessageCreateParamsNonStreaming {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages: Anthropic.MessageParam[] = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const params = request.params ?? {};
    const maxTokens =
      typeof params['maxTokens'] === 'number' ? params['maxTokens'] : this.defaultMaxTokens;
    const out: Anthropic.MessageCreateParamsNonStreaming = {
      model:
        request.model === 'default' || request.model === '' ? this.defaultModel : request.model,
      max_tokens: maxTokens,
      messages,
    };
    if (system) out.system = system;
    // Only forwarded when the workflow asked for it: several current models
    // reject non-default sampling parameters.
    if (typeof params['temperature'] === 'number') out.temperature = params['temperature'];
    if (request.tools && request.tools.length > 0) {
      out.tools = request.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));
    }
    return out;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(this.buildParams(request));
    } catch (err) {
      throw mapAnthropicError(err);
    }

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
      }
    }
    return {
      text,
      toolCalls,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      latencyMs: Date.now() - started,
      model: message.model,
      ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
    };
  }
}
