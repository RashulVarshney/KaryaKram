import type { Queryable } from './queue';

/**
 * One row per call that reached a provider, written by the provider
 * itself (not by the engine) so duplicate calls can be counted
 * independently of the engine's own event log. See docs/DECISIONS.md.
 */
export interface ProviderCallRecord {
  workflowId: string;
  stepId: string;
  requestHash: string;
  attempt?: number | null;
}

export async function recordProviderCall(
  client: Queryable,
  record: ProviderCallRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO provider_call_audit (workflow_id, step_id, request_hash, attempt)
     VALUES ($1, $2, $3, $4)`,
    [record.workflowId, record.stepId, record.requestHash, record.attempt ?? null],
  );
}

export interface ProviderCallRow {
  workflowId: string;
  stepId: string;
  requestHash: string;
  attempt: number | null;
  calledAt: Date;
}

interface ProviderCallDbRow {
  workflow_id: string;
  step_id: string;
  request_hash: string;
  attempt: number | null;
  called_at: Date;
}

export async function listProviderCalls(
  client: Queryable,
  workflowId: string,
): Promise<ProviderCallRow[]> {
  const { rows } = await client.query<ProviderCallDbRow>(
    `SELECT workflow_id, step_id, request_hash, attempt, called_at
       FROM provider_call_audit WHERE workflow_id = $1 ORDER BY id`,
    [workflowId],
  );
  return rows.map((r) => ({
    workflowId: r.workflow_id,
    stepId: r.step_id,
    requestHash: r.request_hash,
    attempt: r.attempt,
    calledAt: r.called_at,
  }));
}

/** Provider calls per step for one workflow, e.g. `{ 'llm-0': 1, 'llm-1': 2 }`. */
export async function countProviderCallsByStep(
  client: Queryable,
  workflowId: string,
): Promise<Record<string, number>> {
  const { rows } = await client.query<{ step_id: string; n: string }>(
    `SELECT step_id, COUNT(*) AS n FROM provider_call_audit
      WHERE workflow_id = $1 GROUP BY step_id`,
    [workflowId],
  );
  return Object.fromEntries(rows.map((r) => [r.step_id, Number(r.n)]));
}
