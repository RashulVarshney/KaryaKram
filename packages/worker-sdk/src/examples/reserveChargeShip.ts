/**
 * M2's hand-scripted 3-activity workflow: reserve -> charge -> ship.
 * There is no decision engine here — the "what comes next" logic is a
 * hardcoded sequence lookup in the activity handler, not derived by
 * replaying workflow code. See docs/02-event-store.md's "driven
 * directly, not through worker replay" section for why that's correct
 * scope for this milestone. Shared by the demo and the end-to-end test
 * so there's exactly one copy of this hardcoded sequence.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendEvents, getEvents, withTransaction, type Task } from '@karyakram/db';
import type { TaskHandler } from '../worker';

export const ACTIVITY_SEQUENCE = ['reserve', 'charge', 'ship'] as const;
export type ActivityName = (typeof ACTIVITY_SEQUENCE)[number];

export async function startReserveChargeShipWorkflow(pool: Pool, orderId: string): Promise<string> {
  const workflowId = randomUUID();
  await pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status)
     VALUES ($1, 'reserve-charge-ship', $2::jsonb, 'RUNNING')`,
    [workflowId, JSON.stringify({ orderId })],
  );

  await withTransaction(pool, (client) =>
    appendEvents(client, {
      workflowId,
      events: [
        { type: 'WorkflowStarted', workflowType: 'reserve-charge-ship', input: { orderId } },
        { type: 'ActivityScheduled', activityType: ACTIVITY_SEQUENCE[0], input: { orderId } },
      ],
    }),
  );

  return workflowId;
}

/** A real M1 Worker's activity handler — reused, not reimplemented. */
export function createReserveChargeShipHandler(pool: Pool): TaskHandler {
  return async (task: Task) => {
    if (task.scheduledEventSeq === null) {
      throw new Error(`activity task ${task.id} has no scheduled_event_seq`);
    }
    const scheduledSeq = Number(task.scheduledEventSeq);

    const events = await getEvents(pool, task.workflowId);
    const scheduled = events.find((e) => e.seq === scheduledSeq);
    if (!scheduled || scheduled.event.type !== 'ActivityScheduled') {
      throw new Error(`no ActivityScheduled event at seq ${scheduledSeq} for task ${task.id}`);
    }
    const activityType = scheduled.event.activityType as ActivityName;

    // "Do the work" — fake/no-op, per the M2 plan; the real point is the
    // event store plumbing around it, not this activity's own logic.
    const result = { activityType, completedAt: new Date().toISOString() };

    const nextIndex = ACTIVITY_SEQUENCE.indexOf(activityType) + 1;
    const nextActivity = ACTIVITY_SEQUENCE[nextIndex];

    await withTransaction(pool, (client) => {
      if (nextActivity) {
        return appendEvents(client, {
          workflowId: task.workflowId,
          events: [
            { type: 'ActivityCompleted', scheduledEventSeq: scheduled.seq, result },
            { type: 'ActivityScheduled', activityType: nextActivity, input: null },
          ],
        });
      }
      return appendEvents(client, {
        workflowId: task.workflowId,
        events: [
          { type: 'ActivityCompleted', scheduledEventSeq: scheduled.seq, result },
          { type: 'WorkflowCompleted', result: { status: 'done' } },
        ],
      });
    });
  };
}
