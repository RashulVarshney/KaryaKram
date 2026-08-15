import type { Client } from 'pg';
import type { Queryable } from './queue';

/**
 * Arbitrary fixed key for the scheduler's leader advisory lock. Postgres
 * advisory locks are keyed by an application-chosen bigint with no
 * built-in namespacing — this project only ever takes one such lock, so
 * one constant is enough. Its value carries no meaning beyond "fixed and
 * not used for anything else."
 */
export const LEADER_LOCK_KEY = 727_310;

/**
 * Attempts to acquire the leader advisory lock on `client`'s current
 * session without blocking. `client` must be a dedicated, non-pooled
 * connection held open for as long as leadership should last — the lock
 * is scoped to that exact session and Postgres releases it automatically
 * the instant the connection closes, for any reason. See
 * docs/06-scheduler.md.
 */
export async function tryAcquireLeaderLock(client: Client): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [LEADER_LOCK_KEY],
  );
  return result.rows[0]?.acquired ?? false;
}

/** Explicitly releases the leader lock without closing the connection. */
export async function releaseLeaderLock(client: Client): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
}

/**
 * Records who currently holds leadership, purely for observability
 * (`SELECT`-able by a demo or an operator) — never consulted by the
 * election logic itself, which relies solely on the advisory lock. See
 * docs/06-scheduler.md.
 */
export async function recordLeadership(client: Client, leaderId: string): Promise<void> {
  await client.query(
    `INSERT INTO scheduler_leadership (id, leader_id, acquired_at)
     VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET leader_id = $1, acquired_at = now()`,
    [leaderId],
  );
}

export interface CurrentLeader {
  leaderId: string;
  acquiredAt: Date;
}

export async function getCurrentLeader(client: Queryable): Promise<CurrentLeader | null> {
  const result = await client.query<{ leader_id: string; acquired_at: Date }>(
    'SELECT leader_id, acquired_at FROM scheduler_leadership WHERE id = 1',
  );
  const row = result.rows[0];
  return row ? { leaderId: row.leader_id, acquiredAt: row.acquired_at } : null;
}
