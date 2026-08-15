import type { Pool, PoolClient } from 'pg';
import { computeRetryDelaySeconds } from './backoff';

/**
 * Every queue function takes a Pool or an already-checked-out PoolClient,
 * so callers can compose them inside their own transaction (e.g. "append
 * an event and enqueue a task" as one atomic unit).
 */
export type Queryable = Pool | PoolClient;

export type TaskType = 'workflow' | 'activity' | 'timer';
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
  /** The enqueuer's W3C `traceparent`, if it ran inside an active span. See docs/07-observability.md. */
  traceContext: string | null;
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
  trace_context: string | null;
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
    traceContext: row.trace_context,
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

// A PoolClient (not a bare Pool) has .release() — used to detect whether
// `enqueue` might be running inside a caller-managed transaction that
// spans more than this one statement.
function isPoolClient(client: Queryable): client is PoolClient {
  return typeof (client as Partial<PoolClient>).release === 'function';
}

export interface EnqueueInput {
  taskType: TaskType;
  workflowId: string;
  queue?: string;
  scheduledEventSeq?: string | number | null;
  runAfter?: Date;
  maxAttempts?: number;
  /** Serialized `traceparent` of the enqueuer's active span, if any. See docs/07-observability.md. */
  traceContext?: string | null;
}

/**
 * Inserts a task. If this is a `workflow` task and one is already
 * pending/leased for this workflow, the partial unique index
 * `one_workflow_task_per_wf` rejects the insert — that's the correct
 * outcome (see docs/01-task-queue.md), so we swallow it and return null
 * rather than throwing.
 *
 * That swallow needs care when `client` is a `PoolClient` inside a
 * caller-managed transaction (e.g. `appendEvents` in eventStore.ts):
 * Postgres marks the *whole* transaction aborted after any error, even
 * one the client catches — every later statement on that connection
 * fails with `25P02` until an explicit ROLLBACK, unless the failing
 * statement was wrapped in a SAVEPOINT. So when composing inside a
 * transaction, the insert runs inside a savepoint that gets rolled back
 * (not the whole transaction) on the expected conflict, leaving the rest
 * of the caller's transaction usable. A bare `Pool` doesn't need this —
 * each of its statements is already its own isolated implicit
 * transaction, so a caught error there can't poison anything else.
 *
 * Also issues `pg_notify('tasks_available', queue)` on the same
 * client/session right after the insert, so delivery is transactional —
 * a listener only ever hears about a task after the transaction that
 * created it has actually committed. Purely a latency shortcut for
 * `Worker`'s poll loop (docs/06-scheduler.md); nothing depends on this
 * notification arriving.
 *
 * The `pg_notify` call is a separate statement, not folded into the
 * insert's `WITH` clause. It was originally written as an unreferenced
 * plain-`SELECT` CTE (`WITH inserted AS (INSERT ...), notified AS
 * (SELECT pg_notify(...) FROM inserted) SELECT * FROM inserted`) — that
 * silently never notified anyone: Postgres only *guarantees* execution
 * for data-modifying CTEs (`INSERT`/`UPDATE`/`DELETE`), not a plain
 * `SELECT` CTE whose output nothing reads, even one calling a volatile
 * function. Confirmed empirically (a separate `LISTEN`ing connection
 * never received a single notification across 5 enqueues under the old
 * form) before switching to this shape.
 */
export async function enqueue(client: Queryable, input: EnqueueInput): Promise<Task | null> {
  const {
    taskType,
    workflowId,
    queue = 'default',
    scheduledEventSeq = null,
    runAfter = new Date(),
    maxAttempts = 3,
    traceContext = null,
  } = input;

  const useSavepoint = isPoolClient(client);
  if (useSavepoint) await client.query('SAVEPOINT enqueue_attempt');

  try {
    const result = await client.query<TaskRow>(
      `INSERT INTO tasks (task_type, workflow_id, queue, scheduled_event_seq, status, run_after, max_attempts, trace_context)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING *`,
      [taskType, workflowId, queue, scheduledEventSeq, runAfter, maxAttempts, traceContext],
    );
    const row = result.rows[0];
    if (!row) throw new Error('enqueue: INSERT ... RETURNING produced no row');
    await client.query('SELECT pg_notify($1, $2)', ['tasks_available', queue]);
    if (useSavepoint) await client.query('RELEASE SAVEPOINT enqueue_attempt');
    return mapRow(row);
  } catch (err) {
    if (useSavepoint) await client.query('ROLLBACK TO SAVEPOINT enqueue_attempt');
    if (isUniqueViolation(err, 'one_workflow_task_per_wf')) {
      return null;
    }
    throw err;
  }
}

export interface DequeueInput {
  workerId: string;
  queue?: string;
  /**
   * Filter to just this task type. M1 never needed this (its Worker only
   * ran a dummy handler against whatever was in the queue), but M2 adds
   * real `workflow`-type tasks that nothing consumes yet — a worker that
   * doesn't filter would pick one up and fail it as if it were an
   * activity. Omit to dequeue any type (M1's original behavior).
   */
  taskType?: TaskType;
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
  const { workerId, queue = 'default', taskType, limit, leaseSeconds } = input;

  const result = await client.query<TaskRow>(
    `WITH candidate AS (
       SELECT id FROM tasks
       WHERE status = 'pending' AND queue = $1 AND run_after <= now()
         AND ($5::text IS NULL OR task_type = $5)
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
    [queue, limit, workerId, leaseSeconds, taskType ?? null],
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
  /** The task's current attempt count (from the `Task` returned by `dequeue`) — used to compute jittered backoff. */
  attempt: number;
}

/**
 * Records a failed attempt. Dead-letters the task once `max_attempts` is
 * reached; otherwise puts it back to `pending` after a full-jitter
 * exponential backoff (see docs/04-durability.md). Guarded by ownership
 * the same way `complete` is.
 */
export async function fail(client: Queryable, input: FailInput): Promise<boolean> {
  const { taskId, workerId, error, attempt } = input;
  const delaySeconds = computeRetryDelaySeconds(attempt);

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
    [taskId, workerId, delaySeconds, error],
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

/**
 * Current task count by status, for the `karyakram_queue_depth` gauge.
 * Global state, not per-worker — published only by whichever replica
 * currently holds leadership (see `packages/scheduler`), the same
 * single-writer reasoning as the reaper. See docs/07-observability.md.
 */
export async function getQueueDepth(client: Queryable): Promise<Record<TaskStatus, number>> {
  const result = await client.query<{ status: TaskStatus; count: string }>(
    'SELECT status, COUNT(*) AS count FROM tasks GROUP BY status',
  );
  const depth: Record<TaskStatus, number> = { pending: 0, leased: 0, completed: 0, dead: 0 };
  for (const row of result.rows) {
    depth[row.status] = Number(row.count);
  }
  return depth;
}
