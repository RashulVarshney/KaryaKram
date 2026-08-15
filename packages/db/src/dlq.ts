import type { Queryable } from './queue';

/**
 * There is no separate dead-letter table — "the DLQ" is just `tasks`
 * rows with `status = 'dead'`. These two functions make that queryable
 * and manually actionable rather than only visible via raw SQL. See
 * docs/04-durability.md.
 */
export interface DeadTask {
  id: string;
  taskType: string;
  workflowId: string;
  queue: string;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
}

interface DeadTaskRow {
  id: string;
  task_type: string;
  workflow_id: string;
  queue: string;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
}

function mapDeadTaskRow(row: DeadTaskRow): DeadTask {
  return {
    id: row.id,
    taskType: row.task_type,
    workflowId: row.workflow_id,
    queue: row.queue,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export interface ListDeadTasksInput {
  queue?: string;
  limit?: number;
}

export async function listDeadTasks(
  client: Queryable,
  input: ListDeadTasksInput = {},
): Promise<DeadTask[]> {
  const { queue, limit = 100 } = input;

  const result = await client.query<DeadTaskRow>(
    `SELECT id, task_type, workflow_id, queue, attempt, max_attempts, last_error, created_at
       FROM tasks
      WHERE status = 'dead' AND ($1::text IS NULL OR queue = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [queue ?? null, limit],
  );

  return result.rows.map(mapDeadTaskRow);
}

export interface RequeueDeadTaskInput {
  taskId: string;
}

/**
 * Manual operator recovery, not automatic retry: resets a dead task back
 * to `pending` with a clean attempt count. Returns whether it applied
 * (false if the task wasn't actually `dead`, e.g. already requeued by
 * someone else).
 */
export async function requeueDeadTask(
  client: Queryable,
  input: RequeueDeadTaskInput,
): Promise<boolean> {
  const { taskId } = input;

  const result = await client.query(
    `UPDATE tasks
        SET status = 'pending', attempt = 0, run_after = now(), last_error = NULL
      WHERE id = $1 AND status = 'dead'`,
    [taskId],
  );

  return (result.rowCount ?? 0) > 0;
}
