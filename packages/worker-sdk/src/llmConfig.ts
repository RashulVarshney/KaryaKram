import {
  canonicalJson,
  type LlmRequest,
  type LlmRequestStorage,
  type LlmToolCall,
} from '@karyakram/core';
import { loadPriceTable, type PriceTable } from '@karyakram/llm';

export const DEFAULT_MAX_STORED_BYTES = 256 * 1024;
export const DEFAULT_LLM_MAX_ATTEMPTS = 5;
export const DEFAULT_TOOL_MAX_ATTEMPTS = 3;

export interface LlmStepConfig {
  /** KARYAKRAM_STORE_PROMPTS=false stores only the request hash, never the prompt. */
  storePrompts: boolean;
  /** Cap on the stored size of a prompt or a response (bytes). */
  maxStoredBytes: number;
  /** Provider attempts before the task is dead-lettered. */
  maxAttempts: number;
  /** Attempts for a tool step before it is dead-lettered. */
  toolMaxAttempts: number;
  priceTable: PriceTable;
  /** Applied to the *stored* copy of a prompt only — never to what is sent to the provider. */
  redact: (text: string) => string;
}

/**
 * Patterns for secrets that tend to leak into prompts. A best-effort
 * safety net, not a guarantee: replace the whole hook if you have a real
 * DLP requirement.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, // Authorization headers
];
const KEY_VALUE_PATTERN =
  /\b(api[_-]?key|secret|token|password)(["'\s:=]+)([A-Za-z0-9_\-./+=]{12,})/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out.replace(KEY_VALUE_PATTERN, '$1$2[REDACTED]');
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

function envPositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer, got ${value}`);
  return n;
}

export function loadLlmStepConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<LlmStepConfig> = {},
): LlmStepConfig {
  return {
    storePrompts: envBool(env['KARYAKRAM_STORE_PROMPTS'], true),
    maxStoredBytes: envPositiveInt(
      'KARYAKRAM_MAX_STORED_BYTES',
      env['KARYAKRAM_MAX_STORED_BYTES'],
      DEFAULT_MAX_STORED_BYTES,
    ),
    maxAttempts: envPositiveInt(
      'KARYAKRAM_LLM_MAX_ATTEMPTS',
      env['KARYAKRAM_LLM_MAX_ATTEMPTS'],
      DEFAULT_LLM_MAX_ATTEMPTS,
    ),
    toolMaxAttempts: envPositiveInt(
      'KARYAKRAM_TOOL_MAX_ATTEMPTS',
      env['KARYAKRAM_TOOL_MAX_ATTEMPTS'],
      DEFAULT_TOOL_MAX_ATTEMPTS,
    ),
    priceTable: loadPriceTable(env),
    redact: redactSecrets,
    ...overrides,
  };
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  // 0b10xxxxxx marks a continuation byte: back up to the start of the character.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

function shrinkRequest(request: LlmRequest, maxBytes: number): LlmRequest {
  const skeleton: LlmRequest = {
    ...request,
    messages: request.messages.map((m) => ({ ...m, content: '' })),
  };
  const overhead = byteLength(JSON.stringify(skeleton));
  if (overhead >= maxBytes || request.messages.length === 0) {
    return { model: request.model, messages: [] };
  }
  const perMessage = Math.floor((maxBytes - overhead) / request.messages.length);
  return {
    ...request,
    messages: request.messages.map((m) => ({
      ...m,
      content: truncateUtf8(m.content, perMessage).text,
    })),
  };
}

export interface StoredRequest {
  requestStorage: LlmRequestStorage;
  request?: LlmRequest;
}

/**
 * Decides what part of a prompt goes into the event log:
 *   none      - KARYAKRAM_STORE_PROMPTS=false: hash only
 *   truncated - over the size cap: a shrunken copy
 *   redacted  - the redaction hook changed something
 *   full      - stored verbatim
 * Only `full` can be sent to a provider as-is; for the others the
 * executing worker re-derives the exact request from the workflow code.
 */
export function buildStoredRequest(request: LlmRequest, config: LlmStepConfig): StoredRequest {
  if (!config.storePrompts) return { requestStorage: 'none' };
  const redacted = mapStrings(request, config.redact) as LlmRequest;
  const changed = canonicalJson(redacted) !== canonicalJson(request);
  if (byteLength(JSON.stringify(redacted)) > config.maxStoredBytes) {
    return { requestStorage: 'truncated', request: shrinkRequest(redacted, config.maxStoredBytes) };
  }
  return { requestStorage: changed ? 'redacted' : 'full', request: redacted };
}

export interface CappedResponse {
  text: string;
  toolCalls: LlmToolCall[];
  truncated: boolean;
}

/** Applies the stored-size cap to a provider response; sets `truncated` if anything was cut. */
export function capResponse(
  text: string,
  toolCalls: LlmToolCall[],
  maxBytes: number,
): CappedResponse {
  const cut = truncateUtf8(text, maxBytes);
  let remaining = maxBytes - byteLength(cut.text);
  const kept: LlmToolCall[] = [];
  let truncated = cut.truncated;
  for (const call of toolCalls) {
    const size = byteLength(JSON.stringify(call));
    if (size <= remaining) {
      kept.push(call);
      remaining -= size;
    } else {
      truncated = true;
    }
  }
  return { text: cut.text, toolCalls: kept, truncated };
}
