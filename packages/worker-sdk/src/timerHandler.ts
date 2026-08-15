import type { Pool } from 'pg';
import { appendEvents, withTransaction, type Task } from '@karyakram/db';
import type { TaskHandler } from './worker';

/**
 * A `TaskHandler` for `timer`-type tasks. Deliberately simple: being
 * dequeued at all already proves `run_after` (== the timer's `fireAt`)
 * has passed — M1's dequeue query guarantees that — so there's nothing
 * to check, just append `TimerFired` unconditionally.
 */
export function createTimerHandler(pool: Pool): TaskHandler {
  return async (task: Task) => {
    if (task.scheduledEventSeq === null) {
      throw new Error(`timer task ${task.id} has no scheduled_event_seq`);
    }
    const scheduledSeq = Number(task.scheduledEventSeq);

    await withTransaction(pool, (client) =>
      appendEvents(client, {
        workflowId: task.workflowId,
        events: [{ type: 'TimerFired', scheduledEventSeq: scheduledSeq }],
      }),
    );
  };
}
