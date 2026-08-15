import type { PoolClient } from 'pg';
import {
  foldEvents,
  type StoredWorkflowEvent,
  type WorkflowEventPayload,
  type WorkflowState,
} from '@karyakram/core';
import { enqueue, type Queryable } from './queue';

export interface AppendEventsInput {
  workflowId: string;
  events: WorkflowEventPayload[];
}

export interface AppendEventsResult {
  storedEvents: StoredWorkflowEvent[];
  state: WorkflowState;
}

/**
 * The atomic unit this whole system hangs off: append event(s) to a
 * workflow's history, enqueue whatever task(s) they imply, and refresh
 * the `workflow_executions.status` cache from the same pure fold every
 * other consumer uses. See docs/02-event-store.md for why each of these
 * three things has to happen together.
 *
 * Deliberately takes a `PoolClient`, not the `Pool | PoolClient` union
 * M1's queue functions accept: this function is several statements,
 * including a `SELECT ... FOR UPDATE` lock that only actually serializes
 * concurrent callers if every statement runs on the same connection
 * inside one transaction. A bare `Pool` would run each `.query()` call
 * autocommitted, independently, possibly on different connections —
 * silently breaking both the lock and the atomicity. Call this via
 * `withTransaction(pool, (client) => appendEvents(client, ...))`
 * (transaction.ts) rather than passing a `Pool` directly.
 */
export async function appendEvents(
  client: PoolClient,
  input: AppendEventsInput,
): Promise<AppendEventsResult> {
  const { workflowId, events } = input;
  if (events.length === 0) {
    throw new Error('appendEvents: events must be non-empty');
  }

  // Serializes concurrent appenders for the same workflow — there's no
  // SKIP LOCKED-style mechanism for "append the next event" the way M1
  // has one for dequeue, so an explicit row lock does the job instead.
  const { rows: lockedRows } = await client.query(
    'SELECT id FROM workflow_executions WHERE id = $1 FOR UPDATE',
    [workflowId],
  );
  if (lockedRows.length === 0) {
    throw new Error(`appendEvents: no workflow_executions row for workflow ${workflowId}`);
  }

  const { rows: maxSeqRows } = await client.query<{ max: string | null }>(
    'SELECT MAX(seq) AS max FROM workflow_events WHERE workflow_id = $1',
    [workflowId],
  );
  const startSeq = maxSeqRows[0]?.max ? Number(maxSeqRows[0].max) + 1 : 1;

  const storedEvents: StoredWorkflowEvent[] = events.map((event, i) => ({
    seq: startSeq + i,
    event,
  }));

  for (const stored of storedEvents) {
    await client.query(
      'INSERT INTO workflow_events (workflow_id, seq, event_type, payload) VALUES ($1, $2, $3, $4::jsonb)',
      [workflowId, stored.seq, stored.event.type, JSON.stringify(stored.event)],
    );
  }

  for (const stored of storedEvents) {
    if (stored.event.type === 'ActivityScheduled') {
      await enqueue(client, {
        taskType: 'activity',
        workflowId,
        scheduledEventSeq: stored.seq,
      });
    } else if (stored.event.type === 'TimerScheduled') {
      // A durable timer is just a task whose run_after is in the future
      // (M1's dequeue query already only picks up run_after <= now()) —
      // see docs/04-durability.md. No new queue primitive needed.
      await enqueue(client, {
        taskType: 'timer',
        workflowId,
        scheduledEventSeq: stored.seq,
        runAfter: new Date(stored.event.fireAt),
      });
    }
  }

  // Signals the replay worker that there's new history to look at —
  // no-op (returns null) if a workflow task is already pending/leased,
  // per M1's one-workflow-task-at-a-time invariant.
  await enqueue(client, { taskType: 'workflow', workflowId });

  const allEvents = await getEvents(client, workflowId);
  const state = foldEvents(allEvents);

  await client.query(
    'UPDATE workflow_executions SET status = $2, updated_at = now() WHERE id = $1',
    [workflowId, state.status],
  );

  return { storedEvents, state };
}

interface WorkflowEventRow {
  seq: string;
  payload: WorkflowEventPayload;
}

export async function getEvents(
  client: Queryable,
  workflowId: string,
): Promise<StoredWorkflowEvent[]> {
  const { rows } = await client.query<WorkflowEventRow>(
    'SELECT seq, payload FROM workflow_events WHERE workflow_id = $1 ORDER BY seq',
    [workflowId],
  );
  return rows.map((r) => ({ seq: Number(r.seq), event: r.payload }));
}
