export type LlmErrorCode =
  'rate_limit' | 'server_error' | 'timeout' | 'connection' | 'invalid_request' | 'auth' | 'unknown';

export interface LlmProviderErrorOptions {
  retryable: boolean;
  code: LlmErrorCode;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * The one error type a provider is allowed to throw. The engine decides
 * what to do from `retryable` / `retryAfterMs` alone, so a provider must
 * classify its own failures: 429, 5xx and timeouts are retryable; other
 * 4xx are not (retrying a malformed or unauthorized request can't help).
 */
export class LlmProviderError extends Error {
  readonly retryable: boolean;
  readonly code: LlmErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: LlmProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmProviderError';
    this.retryable = options.retryable;
    this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** Misconfiguration (e.g. `LLM_PROVIDER=anthropic` without a key). Never retryable, never swallowed. */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}
