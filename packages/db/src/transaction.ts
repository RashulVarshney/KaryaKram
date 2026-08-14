import type { Pool, PoolClient } from 'pg';

/**
 * Checks out a client, runs `fn` inside BEGIN/COMMIT, rolls back on
 * error, always releases. `appendEvents` (see eventStore.ts) needs its
 * `SELECT ... FOR UPDATE` lock and its several writes to be one atomic
 * unit — that only actually holds if they all run on the same connection
 * inside one transaction, which is exactly what this provides.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
