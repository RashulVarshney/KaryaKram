import type { Pool, PoolClient } from 'pg';
import {
  appendEvents,
  isLeaseOwned,
  withTransaction,
  type LeaseFence,
  type Task,
} from '@karyakram/db';
import type { WorkflowEventPayload } from '@karyakram/core';

/**
 * Thrown when a worker discovers it no longer owns the task it is working
 * on. The result of whatever it was doing must be discarded, not written.
 * The `Worker` turns this into a `fail()` that matches nothing (the lease
 * check in `fail` fails too), so it is harmless there.
 */
export class LeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId}: lease lost — discarding result instead of writing it`);
    this.name = 'LeaseLostError';
  }
}

export function fenceOf(task: Task): LeaseFence {
  if (task.leasedBy === null) throw new LeaseLostError(task.id);
  return { taskId: task.id, workerId: task.leasedBy, attempt: task.attempt };
}

/** Run inside the transaction that does the guarded write. */
export async function assertLeaseOwned(client: PoolClient, task: Task): Promise<void> {
  if (!(await isLeaseOwned(client, fenceOf(task)))) throw new LeaseLostError(task.id);
}

export async function hasStepOutcome(
  client: PoolClient | Pool,
  workflowId: string,
  scheduledSeq: number,
  eventTypes: string[],
): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM workflow_events
      WHERE workflow_id = $1 AND event_type = ANY($2::text[])
        AND (payload->>'scheduledEventSeq')::bigint = $3
      LIMIT 1`,
    [workflowId, eventTypes, scheduledSeq],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Appends a step's outcome event iff this worker still owns the task and
 * no outcome is recorded yet — as one transaction. The ownership check
 * takes a row lock on the task, so the lease can't be reclaimed between
 * the check and the commit.
 */
export async function appendStepOutcome(
  pool: Pool,
  task: Task,
  scheduledSeq: number,
  event: WorkflowEventPayload,
  outcomeTypes: string[],
): Promise<'written' | 'already_recorded'> {
  return withTransaction(pool, async (client) => {
    await assertLeaseOwned(client, task);
    if (await hasStepOutcome(client, task.workflowId, scheduledSeq, outcomeTypes)) {
      return 'already_recorded';
    }
    await appendEvents(client, { workflowId: task.workflowId, events: [event] });
    return 'written';
  });
}
