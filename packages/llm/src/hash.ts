import { createHash } from 'node:crypto';
import { canonicalLlmRequest, canonicalToolCall, type LlmRequest } from '@karyakram/core';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** sha256 of the canonical JSON of (model, messages, params, tools). */
export function hashLlmRequest(request: LlmRequest): string {
  return sha256Hex(canonicalLlmRequest(request));
}

export function hashToolCall(tool: string, args: unknown): string {
  return sha256Hex(canonicalToolCall(tool, args));
}
