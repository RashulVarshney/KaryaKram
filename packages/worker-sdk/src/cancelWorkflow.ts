import type { Pool } from 'pg';
import { appendEvents, withTransaction } from '@karyakram/db';

/**
 * The external entrypoint for canceling a workflow — never called from
 * workflow code. Appends `CancellationRequested`; the replay worker
 * (`createWorkflowReplayHandler`) checks for it and ends the workflow
 * directly, without ever calling `replay()` for that decision. This is
 * "hard" cancellation, not cooperative — see docs/04-durability.md.
 */
export async function cancelWorkflow(
  pool: Pool,
  workflowId: string,
  reason?: string,
): Promise<void> {
  await withTransaction(pool, (client) =>
    appendEvents(client, {
      workflowId,
      events: [{ type: 'CancellationRequested', reason }],
    }),
  );
}
