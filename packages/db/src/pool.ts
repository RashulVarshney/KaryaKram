import { Pool } from 'pg';

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
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  return createPool({ connectionString });
}
