import type { Pool } from 'pg';
import { appendEvents, withTransaction } from '@karyakram/db';

/**
 * The external entrypoint for pushing a signal into a running workflow —
 * never called from workflow code itself. Just an `appendEvents` call
 * like anything else that durably happens to a workflow; the resulting
 * `workflow` task wakes the replay worker up to notice it. See
 * docs/04-durability.md.
 */
export async function sendSignal(
  pool: Pool,
  workflowId: string,
  signalName: string,
  payload: unknown,
): Promise<void> {
  await withTransaction(pool, (client) =>
    appendEvents(client, {
      workflowId,
      events: [{ type: 'SignalReceived', signalName, payload }],
    }),
  );
}
