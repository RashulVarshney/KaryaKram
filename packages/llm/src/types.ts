import type { LlmRequest, LlmToolCall } from '@karyakram/core';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  latencyMs: number;
  /** The model that actually served the request (resolved from the `'default'` sentinel). */
  model: string;
  stopReason?: string;
}

/** Identifies which workflow step a provider call belongs to (used for auditing and scripted failures). */
export interface LlmCallContext {
  workflowId: string;
  stepId: string;
  /** 1-based task attempt this call is made on. */
  attempt: number;
}

export interface LLMProvider {
  readonly name: string;
  complete(request: LlmRequest, ctx?: LlmCallContext): Promise<LlmResponse>;
}
