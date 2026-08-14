import type { Pool } from 'pg';
import { appendEvents, getEvents, withTransaction, type Task } from '@karyakram/db';
import type { AnyActivityDefinition } from './authoring';
import type { TaskHandler } from './worker';

/**
 * A `TaskHandler` for `activity`-type tasks: find which
 * `ActivityScheduled` event this task's `scheduled_event_seq` points to,
 * run the registered activity function for real, and record the outcome.
 * The activity function runs outside any transaction (it may be slow —
 * a real activity could call Stripe) and only the resulting
 * `appendEvents` call, which is quick, holds a connection.
 */
export function createActivityHandler(
  pool: Pool,
  activities: AnyActivityDefinition[],
): TaskHandler {
  const registry = new Map(activities.map((a) => [a.activityType, a]));

  return async (task: Task) => {
    if (task.scheduledEventSeq === null) {
      throw new Error(`activity task ${task.id} has no scheduled_event_seq`);
    }
    const scheduledSeq = Number(task.scheduledEventSeq);

    const history = await getEvents(pool, task.workflowId);
    const scheduled = history.find((e) => e.seq === scheduledSeq);
    if (!scheduled || scheduled.event.type !== 'ActivityScheduled') {
      throw new Error(`no ActivityScheduled event at seq ${scheduledSeq} for task ${task.id}`);
    }
    const { activityType, input } = scheduled.event;

    const definition = registry.get(activityType);
    if (!definition) {
      throw new Error(`no activity registered for type "${activityType}"`);
    }

    let outcomeEvent:
      | { type: 'ActivityCompleted'; scheduledEventSeq: number; result: unknown }
      | {
          type: 'ActivityFailed';
          scheduledEventSeq: number;
          error: string;
        };
    try {
      const result = await definition.fn(input);
      outcomeEvent = { type: 'ActivityCompleted', scheduledEventSeq: scheduled.seq, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomeEvent = { type: 'ActivityFailed', scheduledEventSeq: scheduled.seq, error: message };
    }

    await withTransaction(pool, (client) =>
      appendEvents(client, { workflowId: task.workflowId, events: [outcomeEvent] }),
    );
  };
}
