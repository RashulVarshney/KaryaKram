/**
 * Types and pure helpers shared by the replay engine, the event store and
 * the browser debugger for durable LLM / tool steps. No IO, no clock, no
 * randomness, and no `node:crypto` — this package is also bundled for the
 * browser. The actual sha256 is injected by the worker layer; this file
 * only defines *what* gets hashed (the canonical JSON below).
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/**
 * Everything that determines what a provider is asked: the model, the
 * conversation, sampling/limit params and the tool definitions offered to
 * the model. The request hash covers exactly these four things.
 *
 * `model: 'default'` is a sentinel meaning "whatever the deployment
 * configures" — it is hashed as the literal string, so changing the
 * configured model never invalidates recorded outputs.
 */
export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  params?: Record<string, unknown>;
  tools?: LlmToolDefinition[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** What workflow code receives from `ctx.llmCall` — the recorded outcome, never a live value. */
export interface LlmCallResult {
  text: string;
  toolCalls: LlmToolCall[];
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** True if the stored response was cut to the configured size cap. */
  truncated: boolean;
}

export interface NormalizedLlmRequest {
  model: string;
  messages: LlmMessage[];
  params: Record<string, unknown>;
  tools: LlmToolDefinition[];
}

/** Fills optional fields so `{}` vs absent never changes the hash. */
export function normalizeLlmRequest(request: LlmRequest): NormalizedLlmRequest {
  return {
    model: request.model,
    messages: request.messages,
    params: request.params ?? {},
    tools: request.tools ?? [],
  };
}

function canonicalize(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') {
      return canonicalize(withToJson.toJSON());
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item === undefined ? null : item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` dropped,
 * no whitespace. Two logically equal values always serialize identically,
 * regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** The exact string a request hash is computed over. */
export function canonicalLlmRequest(request: LlmRequest): string {
  return canonicalJson(normalizeLlmRequest(request));
}

/** The exact string a tool-call hash is computed over. */
export function canonicalToolCall(tool: string, args: unknown): string {
  return canonicalJson({ tool, args: args ?? null });
}
