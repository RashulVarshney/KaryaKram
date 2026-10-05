import { Ajv, type ValidateFunction } from 'ajv';
import type { PoolClient } from 'pg';
import type { LlmToolDefinition } from '@karyakram/core';

/**
 * What a tool handler gets. `client` is a connection already inside the
 * transaction that will also record the tool's result and the
 * `TOOL_COMPLETED` event: do your database side effects THROUGH it and
 * they commit atomically with that record — a crash before commit rolls
 * the side effect back too, so it can never be applied without being
 * recorded. For side effects outside Postgres (an email API, Stripe),
 * pass `idempotencyKey` to the external system; that narrows the
 * duplicate window but cannot remove it.
 */
export interface ToolContext {
  client: PoolClient;
  workflowId: string;
  stepId: string;
  /** `${workflowId}:${stepId}` — stable across retries and crashes. */
  idempotencyKey: string;
}

/** Throw this from a handler to control retry behaviour; any other error is non-retryable. */
export class ToolError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { retryable?: boolean; code?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ToolError';
    this.retryable = options.retryable ?? false;
    this.code = options.code ?? 'tool_error';
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ToolDefinition<Args = unknown, Result = unknown> {
  name: string;
  description?: string;
  /** JSON Schema the arguments must satisfy before the handler is allowed to run. */
  argsSchema: Record<string, unknown>;
  handler(args: Args, ctx: ToolContext): Promise<Result>;
}

export type ToolValidation =
  { ok: true } | { ok: false; code: 'unknown_tool' | 'invalid_args'; message: string };

/** Only tools registered here can ever run. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true });

  register<Args, Result>(tool: ToolDefinition<Args, Result>): this {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.validators.set(tool.name, this.ajv.compile(tool.argsSchema));
    this.tools.set(tool.name, tool as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  validate(name: string, args: unknown): ToolValidation {
    const validator = this.validators.get(name);
    if (!validator) {
      return { ok: false, code: 'unknown_tool', message: `tool "${name}" is not registered` };
    }
    if (!validator(args)) {
      return {
        ok: false,
        code: 'invalid_args',
        message: `invalid arguments for tool "${name}": ${this.ajv.errorsText(validator.errors)}`,
      };
    }
    return { ok: true };
  }

  /** Tool definitions in the shape an LLM request offers to the model. */
  toLlmTools(): LlmToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.argsSchema,
    }));
  }
}
