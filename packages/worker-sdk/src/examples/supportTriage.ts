import { defineWorkflow } from '../authoring';
import type { Customer, SentReply } from './supportTools';

export interface TriageInput {
  ticketId: string;
  customerId: string;
  subject: string;
  body: string;
}

export interface TriageResult {
  ticketId: string;
  category: string;
  customerName: string;
  plan: string;
  reply: string;
  messageId: string;
}

/**
 * Support-ticket triage: classify (LLM) -> look up the customer (tool,
 * side-effecting) -> draft a reply (LLM) -> send it (tool, side-effecting).
 *
 * Every step is durable: kill the worker at any point and the workflow
 * resumes from the event log without re-calling a step that already has
 * a recorded outcome, and without repeating a side effect.
 *
 * Nothing here reads the clock, randomness or the environment: the
 * workflow function is replayed from the top on every decision, so it
 * must build the same requests every time.
 */
export const supportTicketTriage = defineWorkflow<TriageInput, TriageResult>(
  'support-ticket-triage',
  async (input, ctx) => {
    const classification = await ctx.llmCall({
      model: 'default',
      messages: [
        {
          role: 'system',
          content:
            'You triage customer support tickets. Reply with exactly one category: billing, technical, account or other.',
        },
        { role: 'user', content: `Subject: ${input.subject}\n\n${input.body}` },
      ],
      params: { maxTokens: 16 },
    });
    const category = classification.text.trim().split('\n')[0] ?? '';

    const customer = await ctx.toolCall<Customer>('lookup_customer', {
      customerId: input.customerId,
    });

    const draft = await ctx.llmCall({
      model: 'default',
      messages: [
        {
          role: 'system',
          content: 'You write short, polite support replies. Do not promise refunds.',
        },
        {
          role: 'user',
          content:
            `Customer: ${customer.name} (${customer.plan} plan)\n` +
            `Category: ${category}\n` +
            `Ticket: ${input.subject}\n\n${input.body}\n\nWrite the reply.`,
        },
      ],
      params: { maxTokens: 400 },
    });

    const sent = await ctx.toolCall<SentReply>('send_reply', {
      ticketId: input.ticketId,
      to: customer.email,
      body: draft.text,
    });

    return {
      ticketId: input.ticketId,
      category,
      customerName: customer.name,
      plan: customer.plan,
      reply: draft.text,
      messageId: sent.messageId,
    };
  },
);

/** Deterministic sample tickets, so a crash run and its no-crash reference see identical input. */
export function sampleTicket(i: number): TriageInput {
  const topics = [
    ['Double charged on my invoice', 'I was billed twice for March. Please fix.'],
    ['Cannot log in', 'The password reset email never arrives.'],
    ['Export is failing', 'CSV export spins forever on large projects.'],
    ['Change my plan', 'How do I move from the free plan to pro?'],
  ] as const;
  const [subject, body] = topics[i % topics.length] ?? topics[0];
  return {
    ticketId: `T-${String(i).padStart(4, '0')}`,
    customerId: `C-${String(i % 7)}`,
    subject,
    body,
  };
}
