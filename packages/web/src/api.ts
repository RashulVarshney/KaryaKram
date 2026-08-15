import type { StoredWorkflowEvent } from '@karyakram/core';

const API_BASE_URL =
  (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? 'http://localhost:3001';

export interface WorkflowSummary {
  id: string;
  workflowType: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const response = await fetch(`${API_BASE_URL}/workflows`);
  const body = (await response.json()) as { workflows: WorkflowSummary[] };
  return body.workflows;
}

export async function getWorkflowEvents(workflowId: string): Promise<StoredWorkflowEvent[]> {
  const response = await fetch(`${API_BASE_URL}/workflows/${workflowId}/events`);
  const body = (await response.json()) as { events: StoredWorkflowEvent[] };
  return body.events;
}

export async function startWorkflow(orderId?: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  });
  const body = (await response.json()) as { workflowId: string };
  return body.workflowId;
}

/** Returns an unsubscribe function. See docs/05-control-plane.md for why this is polling-based SSE, not LISTEN/NOTIFY. */
export function streamWorkflowEvents(
  workflowId: string,
  sinceSeq: number,
  onEvent: (event: StoredWorkflowEvent) => void,
): () => void {
  const source = new EventSource(
    `${API_BASE_URL}/workflows/${workflowId}/stream?since=${sinceSeq}`,
  );
  source.onmessage = (message: MessageEvent<string>) => {
    const event = JSON.parse(message.data) as StoredWorkflowEvent;
    onEvent(event);
  };
  return () => {
    source.close();
  };
}
