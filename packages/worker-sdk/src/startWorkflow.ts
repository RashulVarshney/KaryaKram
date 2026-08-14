import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendEvents, withTransaction } from '@karyakram/db';
import type { WorkflowDefinition } from './authoring';

/**
 * Creates the `workflow_executions` row and appends just
 * `[WorkflowStarted]` — scheduling the first activity is the replay
 * worker's job now (via `scheduleActivity` inside the workflow function),
 * not the caller's. This is the concrete difference from M2, where
 * starting a workflow also hardcoded its first `ActivityScheduled` event.
 */
export async function startWorkflow<Input>(
  pool: Pool,
  definition: WorkflowDefinition<Input, unknown>,
  input: Input,
): Promise<string> {
  const workflowId = randomUUID();

  await pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status)
     VALUES ($1, $2, $3::jsonb, 'RUNNING')`,
    [workflowId, definition.workflowType, JSON.stringify(input)],
  );

  await withTransaction(pool, (client) =>
    appendEvents(client, {
      workflowId,
      events: [{ type: 'WorkflowStarted', workflowType: definition.workflowType, input }],
    }),
  );

  return workflowId;
}
