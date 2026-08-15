import type { Queryable } from './queue';

export interface WorkflowExecutionSummary {
  id: string;
  workflowType: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowExecutionRow {
  id: string;
  workflow_type: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: WorkflowExecutionRow): WorkflowExecutionSummary {
  return {
    id: row.id,
    workflowType: row.workflow_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWorkflowExecutions(
  client: Queryable,
  limit = 50,
): Promise<WorkflowExecutionSummary[]> {
  const { rows } = await client.query<WorkflowExecutionRow>(
    'SELECT id, workflow_type, status, created_at, updated_at FROM workflow_executions ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return rows.map(mapRow);
}

export async function getWorkflowExecution(
  client: Queryable,
  workflowId: string,
): Promise<WorkflowExecutionSummary | null> {
  const { rows } = await client.query<WorkflowExecutionRow>(
    'SELECT id, workflow_type, status, created_at, updated_at FROM workflow_executions WHERE id = $1',
    [workflowId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
