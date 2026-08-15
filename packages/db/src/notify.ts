import type { Client } from 'pg';

/**
 * Subscribes a dedicated `Client` (never a pooled connection — `LISTEN`
 * is session-scoped, so it has to stay on one specific connection for
 * the life of the subscription) to `channel` and calls `onNotify` for
 * every notification delivered on it. Callers own the client's
 * lifecycle: connect it before calling this, and close it to stop
 * listening. See docs/06-scheduler.md for why this is a latency
 * shortcut layered on top of polling, never a replacement for it.
 */
export async function listenForTasks(
  client: Client,
  channel: string,
  onNotify: () => void,
): Promise<void> {
  client.on('notification', (msg) => {
    if (msg.channel === channel) onNotify();
  });
  // `LISTEN` doesn't accept a bind parameter for the channel name — it's
  // always one of this project's own fixed constants (never user input),
  // so a quoted identifier is enough to guard against it containing
  // anything unexpected.
  await client.query(`LISTEN "${channel.replace(/"/g, '""')}"`);
}
