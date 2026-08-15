import { Client, Pool } from 'pg';

export interface PoolConfig {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
}

/**
 * Creates a Postgres connection pool with sane defaults for this project.
 * Callers own the pool's lifecycle (close it on shutdown).
 */
export function createPool(config: PoolConfig): Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    statement_timeout: config.statementTimeoutMs ?? 30_000,
  });
}

export function createPoolFromEnv(): Pool {
  return createPool({ connectionString: requireDatabaseUrl() });
}

function requireDatabaseUrl(): string {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  return connectionString;
}

/**
 * A single, non-pooled connection. Needed anywhere session-scoped state
 * matters — a Postgres advisory lock (M6 leader election) or a `LISTEN`
 * subscription (M6 notify wake-up) — since a pooled connection can be
 * handed back and reused by someone else between queries, silently
 * losing whatever was scoped to that specific session.
 */
export function createClientFromEnv(): Client {
  return new Client({ connectionString: requireDatabaseUrl() });
}
