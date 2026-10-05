import type { LlmRequest, LlmToolCall } from '@karyakram/core';
import { canonicalLlmRequest } from '@karyakram/core';
import type { ProviderCallAudit } from './audit';
import { LlmProviderError } from './errors';
import { hashLlmRequest, sha256Hex } from './hash';
import type { LLMProvider, LlmCallContext, LlmResponse } from './types';

export type MockFailureOn = 429 | 500 | 503 | 400 | 'timeout';

/**
 * A scripted failure. It is keyed off the task attempt number the engine
 * passes in (`ctx.attempt`), not off hidden counters inside the provider,
 * so the same script behaves identically across worker processes and
 * across crashes: "fail while attempt <= failAttempts".
 */
export interface MockFailureRule {
  on: MockFailureOn;
  failAttempts: number;
  retryAfterMs?: number;
  /** Restrict the rule to one step (e.g. `llm-1`) and/or one request hash. */
  stepId?: string;
  requestHash?: string;
}

export interface MockProviderOptions {
  /** Every invocation is recorded here — including ones that then fail. */
  audit?: ProviderCallAudit;
  model?: string;
  /** Simulated latency; also the value reported as `latencyMs`. */
  latencyMs?: number | ((request: LlmRequest) => number);
  failures?: MockFailureRule[];
  /** Injectable so tests need no real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Deterministic provider for tests, benchmarks and demos — no network, no
 * key. The *response* (text, tool calls, token counts) is a pure function
 * of the request. Scripted failures depend only on `ctx.attempt`.
 *
 * Two request params steer the output: `mockOutput` (string) fixes the
 * text, `mockToolCall` (`{ name, arguments }`) makes it return a tool call.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  private readonly model: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: MockProviderOptions = {}) {
    this.model = options.model ?? 'mock-1';
    this.sleep = options.sleep ?? realSleep;
  }

  async complete(request: LlmRequest, ctx?: LlmCallContext): Promise<LlmResponse> {
    // Hashed here from the request actually received — deliberately not
    // trusting any hash the engine computed — so the audit stays an
    // independent witness of what reached the provider.
    const requestHash = hashLlmRequest(request);
    const attempt = ctx?.attempt ?? 1;

    await this.options.audit?.record({
      workflowId: ctx?.workflowId ?? 'unknown',
      stepId: ctx?.stepId ?? 'unknown',
      requestHash,
      attempt,
    });

    const latencyMs =
      typeof this.options.latencyMs === 'function'
        ? this.options.latencyMs(request)
        : (this.options.latencyMs ?? 0);
    if (latencyMs > 0) await this.sleep(latencyMs);

    this.maybeFail(requestHash, ctx, attempt);

    const params = request.params ?? {};
    const fixedOutput = typeof params['mockOutput'] === 'string' ? params['mockOutput'] : null;
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const digest = sha256Hex(canonicalLlmRequest(request)).slice(0, 12);
    const text = fixedOutput ?? `mock(${digest}): ${lastUser.slice(0, 80)}`;

    const toolCalls: LlmToolCall[] = [];
    const scripted = params['mockToolCall'] as { name?: string; arguments?: unknown } | undefined;
    if (scripted && typeof scripted.name === 'string') {
      toolCalls.push({
        id: `call_${digest.slice(0, 8)}`,
        name: scripted.name,
        arguments: scripted.arguments ?? {},
      });
    }

    const inputChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: approxTokens('x'.repeat(inputChars)),
        outputTokens: approxTokens(text),
      },
      latencyMs,
      model: request.model === 'default' || request.model === '' ? this.model : request.model,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }

  private maybeFail(requestHash: string, ctx: LlmCallContext | undefined, attempt: number): void {
    for (const rule of this.options.failures ?? []) {
      if (attempt > rule.failAttempts) continue;
      if (rule.stepId !== undefined && rule.stepId !== ctx?.stepId) continue;
      if (rule.requestHash !== undefined && rule.requestHash !== requestHash) continue;
      throw this.failureFor(rule);
    }
  }

  private failureFor(rule: MockFailureRule): LlmProviderError {
    switch (rule.on) {
      case 429:
        return new LlmProviderError('mock: rate limited (429)', {
          retryable: true,
          code: 'rate_limit',
          status: 429,
          ...(rule.retryAfterMs !== undefined ? { retryAfterMs: rule.retryAfterMs } : {}),
        });
      case 500:
      case 503:
        return new LlmProviderError(`mock: server error (${rule.on})`, {
          retryable: true,
          code: 'server_error',
          status: rule.on,
        });
      case 'timeout':
        return new LlmProviderError('mock: request timed out', {
          retryable: true,
          code: 'timeout',
        });
      case 400:
        return new LlmProviderError('mock: bad request (400)', {
          retryable: false,
          code: 'invalid_request',
          status: 400,
        });
    }
  }
}
