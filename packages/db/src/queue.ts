import type { Pool, PoolClient } from 'pg';

/**
 * Every queue function takes a Pool or an already-checked-out PoolClient,
 * so callers can compose them inside their own transaction (e.g. "append
 * an event and enqueue a task" as one atomic unit).
 */
export type Queryable = Pool | PoolClient;

export type TaskType = 'workflow' | 'activity';
export type TaskStatus = 'pending' | 'leased' | 'completed' | 'dead';

export interface Task {
  id: string; // BIGSERIAL comes back from pg as a string to avoid precision loss.
  taskType: TaskType;
  workflowId: string;
  queue: string;
  scheduledEventSeq: string | null;
  status: TaskStatus;
  runAfter: Date;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  leasedBy: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
}

interface TaskRow {
  id: string;
  task_type: TaskType;
  workflow_id: string;
  queue: string;
  scheduled_event_seq: string | null;
  status: TaskStatus;
  run_after: Date;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  leased_by: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
}

function mapRow(row: TaskRow): Task {
  return {
    id: row.id,
    taskType: row.task_type,
    workflowId: row.workflow_id,
    queue: row.queue,
    scheduledEventSeq: row.scheduled_event_seq,
    status: row.status,
    runAfter: row.run_after,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    leasedBy: row.leased_by,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
  };
}

// Postgres error shape for a unique-violation (pg's DatabaseError isn't a
// distinct exported class we can `instanceof`-check reliably here, so we
// duck-type the fields we need).
interface PgUniqueViolationError {
  code: string;
  constraint?: string;
}

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Partial<PgUniqueViolationError>;
  return e.code === '23505' && e.constraint === constraintName;
}

export interface EnqueueInput {
  taskType: TaskType;
  workflowId: string;
  queue?: string;
  scheduledEventSeq?: string | number | null;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Inserts a task. If this is a `workflow` task and one is already
 * pending/leased for this workflow, the partial unique index
 * `one_workflow_task_per_wf` rejects the insert — that's the correct
 * outcome (see docs/01-task-queue.md), so we swallow it and return null
 * rather than throwing.
 */
export async function enqueue(client: Queryable, input: EnqueueInput): Promise<Task | null> {
  const {
    taskType,
    workflowId,
    queue = 'default',
    scheduledEventSeq = null,
    runAfter = new Date(),
    maxAttempts = 3,
  } = input;

  try {
    const result = await client.query<TaskRow>(
      `INSERT INTO tasks (task_type, workflow_id, queue, scheduled_event_seq, status, run_after, max_attempts)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING *`,
      [taskType, workflowId, queue, scheduledEventSeq, runAfter, maxAttempts],
    );
    const row = result.rows[0];
    if (!row) throw new Error('enqueue: INSERT ... RETURNING produced no row');
    return mapRow(row);
  } catch (err) {
    if (isUniqueViolation(err, 'one_workflow_task_per_wf')) {
      return null;
    }
    throw err;
  }
}

export interface DequeueInput {
  workerId: string;
  queue?: string;
  limit: number;
  leaseSeconds: number;
}

/**
 * Atomically leases up to `limit` pending tasks using
 * `FOR UPDATE SKIP LOCKED`, so concurrent workers never contend for the
 * same rows. See docs/01-task-queue.md for why this doesn't collapse to
 * serialized throughput the way plain `FOR UPDATE` would.
 */
export async function dequeue(client: Queryable, input: DequeueInput): Promise<Task[]> {
  const { workerId, queue = 'default', limit, leaseSeconds } = input;

  const result = await client.query<TaskRow>(
    `WITH candidate AS (
       SELECT id FROM tasks
       WHERE status = 'pending' AND queue = $1 AND run_after <= now()
       ORDER BY run_after, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE tasks t
        SET status = 'leased',
            leased_by = $3,
            lease_expires_at = now() + ($4 || ' seconds')::interval,
            attempt = t.attempt + 1
       FROM candidate c
      WHERE t.id = c.id
     RETURNING t.*`,
    [queue, limit, workerId, leaseSeconds],
  );

  return result.rows.map(mapRow);
}

export interface HeartbeatInput {
  taskIds: string[];
  workerId: string;
  leaseSeconds: number;
}

/**
 * Extends the lease on every task in `taskIds` still owned by `workerId`.
 * Returns the number of rows actually updated — if that's less than
 * `taskIds.length`, this worker has already lost at least one lease
 * (likely reclaimed by the reaper) and must stop working on it: see
 * docs/01-task-queue.md's stolen-lease guard.
 */
export async function heartbeat(client: Queryable, input: HeartbeatInput): Promise<number> {
  const { taskIds, workerId, leaseSeconds } = input;
  if (taskIds.length === 0) return 0;

  const result = await client.query(
    `UPDATE tasks
        SET lease_expires_at = now() + ($1 || ' seconds')::interval
      WHERE id = ANY($2::bigint[])
        AND leased_by = $3
        AND status = 'leased'`,
    [leaseSeconds, taskIds, workerId],
  );

  return result.rowCount ?? 0;
}

export interface CompleteInput {
  taskId: string;
  workerId: string;
}

/**
 * Marks a task completed, guarded by ownership so a worker that lost its
 * lease (reclaimed and possibly already re-leased to someone else) can't
 * mark it done out from under the new owner. Returns whether it applied.
 */
export async function complete(client: Queryable, input: CompleteInput): Promise<boolean> {
  const { taskId, workerId } = input;

  const result = await client.query(
    `UPDATE tasks
        SET status = 'completed'
      WHERE id = $1
        AND leased_by = $2
        AND status = 'leased'`,
    [taskId, workerId],
  );

  return (result.rowCount ?? 0) > 0;
}

export interface FailInput {
  taskId: string;
  workerId: string;
  error: string;
}

// TODO(M4): replace with real exponential backoff + jitter. Fixed for M1.
const RETRY_BACKOFF_SECONDS = 30;

/**
 * Records a failed attempt. Dead-letters the task once `max_attempts` is
 * reached; otherwise puts it back to `pending` after a fixed backoff.
 * Guarded by ownership the same way `complete` is.
 */
export async function fail(client: Queryable, input: FailInput): Promise<boolean> {
  const { taskId, workerId, error } = input;

  const result = await client.query(
    `UPDATE tasks
        SET status = CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'pending' END,
            run_after = CASE
              WHEN attempt >= max_attempts THEN run_after
              ELSE now() + ($3 || ' seconds')::interval
            END,
            last_error = $4,
            leased_by = NULL,
            lease_expires_at = NULL
      WHERE id = $1
        AND leased_by = $2
        AND status = 'leased'`,
    [taskId, workerId, RETRY_BACKOFF_SECONDS, error],
  );

  return (result.rowCount ?? 0) > 0;
}

export interface ReclaimExpiredInput {
  limit: number;
}

/**
 * The reaper query: finds leases past `lease_expires_at` and puts those
 * tasks back to `pending`. Deliberately does NOT increment `attempt` —
 * `dequeue` already did that when the lease was first taken, so a
 * crash-looping task still dead-letters after exactly `max_attempts`
 * dequeues, not `max_attempts` reclaims.
 */
export async function reclaimExpired(
  client: Queryable,
  input: ReclaimExpiredInput,
): Promise<string[]> {
  const { limit } = input;

  const result = await client.query<{ id: string }>(
    `UPDATE tasks
        SET status = 'pending', leased_by = NULL, lease_expires_at = NULL
      WHERE id IN (
        SELECT id FROM tasks
        WHERE status = 'leased' AND lease_expires_at < now()
        ORDER BY lease_expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [limit],
  );

  return result.rows.map((r) => r.id);
}
