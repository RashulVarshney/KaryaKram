import type { Queryable } from './queue';

export interface ToolClaim {
  workflowId: string;
  stepId: string;
  tool: string;
  argsHash: string;
}

export type ClaimResult = { claimed: true } | { claimed: false; result: unknown };

/**
 * Claims the right to execute a tool step. Run inside the same
 * transaction as the tool's side effect and its result record.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` on the (workflow_id, step_id)
 * primary key: if another transaction is mid-execution, this INSERT
 * *waits* for it to commit or roll back (Postgres blocks on the
 * conflicting unique-index entry). After a commit the row exists with
 * the stored result, so the caller returns that instead of executing
 * again; after a rollback the insert succeeds and this caller proceeds.
 * Because the row is inserted and completed in one transaction, a crash
 * can never leave a "claimed but not recorded" row behind.
 */
export async function claimToolExecution(
  client: Queryable,
  claim: ToolClaim,
): Promise<ClaimResult> {
  const inserted = await client.query(
    `INSERT INTO tool_executions (workflow_id, step_id, tool, args_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workflow_id, step_id) DO NOTHING
     RETURNING step_id`,
    [claim.workflowId, claim.stepId, claim.tool, claim.argsHash],
  );
  if ((inserted.rowCount ?? 0) > 0) return { claimed: true };

  const { rows } = await client.query<{ result: unknown }>(
    'SELECT result FROM tool_executions WHERE workflow_id = $1 AND step_id = $2',
    [claim.workflowId, claim.stepId],
  );
  return { claimed: false, result: rows[0]?.result ?? null };
}

export async function completeToolExecution(
  client: Queryable,
  workflowId: string,
  stepId: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `UPDATE tool_executions SET result = $3::jsonb, completed_at = now()
      WHERE workflow_id = $1 AND step_id = $2`,
    [workflowId, stepId, JSON.stringify(result ?? null)],
  );
}

export interface SideEffectInput {
  workflowId: string;
  stepId: string;
  kind: string;
  payload: unknown;
}

export async function recordSideEffect(client: Queryable, input: SideEffectInput): Promise<void> {
  await client.query(
    'INSERT INTO side_effects (workflow_id, step_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb)',
    [input.workflowId, input.stepId, input.kind, JSON.stringify(input.payload ?? null)],
  );
}

export interface SideEffectRow {
  workflowId: string;
  stepId: string;
  kind: string;
}

export async function listSideEffects(
  client: Queryable,
  workflowId: string,
): Promise<SideEffectRow[]> {
  const { rows } = await client.query<{ workflow_id: string; step_id: string; kind: string }>(
    'SELECT workflow_id, step_id, kind FROM side_effects WHERE workflow_id = $1 ORDER BY id',
    [workflowId],
  );
  return rows.map((r) => ({ workflowId: r.workflow_id, stepId: r.step_id, kind: r.kind }));
}
