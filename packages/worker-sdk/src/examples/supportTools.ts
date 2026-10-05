import { recordSideEffect } from '@karyakram/db';
import { sha256Hex } from '@karyakram/llm';
import { ToolRegistry } from '../tools';

export interface LookupCustomerArgs {
  customerId: string;
}
export interface Customer {
  customerId: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  email: string;
}

export interface SendReplyArgs {
  ticketId: string;
  to: string;
  body: string;
}
export interface SentReply {
  messageId: string;
}

const PLANS = ['free', 'pro', 'enterprise'] as const;

/**
 * Two deliberately side-effecting demo tools. Each records its effect in
 * `side_effects` THROUGH the transaction's connection, so the effect and
 * the engine's record that it happened commit (or roll back) together.
 * Results are deterministic functions of the arguments, so a chaos run
 * can compare final outputs against a no-crash reference run.
 */
export function createSupportToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register<LookupCustomerArgs, Customer>({
    name: 'lookup_customer',
    description: 'Look up a customer record (and write an audit entry).',
    argsSchema: {
      type: 'object',
      properties: { customerId: { type: 'string', minLength: 1 } },
      required: ['customerId'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      await recordSideEffect(ctx.client, {
        workflowId: ctx.workflowId,
        stepId: ctx.stepId,
        kind: 'customer_lookup',
        payload: args,
      });
      const h = sha256Hex(args.customerId);
      return {
        customerId: args.customerId,
        name: `Customer ${h.slice(0, 6)}`,
        plan: PLANS[parseInt(h.slice(0, 2), 16) % PLANS.length] ?? 'free',
        email: `${h.slice(0, 8)}@example.test`,
      };
    },
  });

  registry.register<SendReplyArgs, SentReply>({
    name: 'send_reply',
    description: 'Send a reply to a customer (records the outbound message).',
    argsSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', minLength: 1 },
        to: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
      },
      required: ['ticketId', 'to', 'body'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      await recordSideEffect(ctx.client, {
        workflowId: ctx.workflowId,
        stepId: ctx.stepId,
        kind: 'reply_sent',
        payload: args,
      });
      return {
        messageId: `msg-${sha256Hex(`${args.ticketId}|${args.to}|${args.body}`).slice(0, 12)}`,
      };
    },
  });

  return registry;
}
