import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { createPool } from '../src/pool';

export interface TestDatabase {
  pool: Pool;
  /** For spawning real child processes that need their own DATABASE_URL. */
  connectionString: string;
  /** Truncates every user table between test cases so state never leaks across tests. */
  truncateAll: () => Promise<void>;
  stop: () => Promise<void>;
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Boots a real Postgres in a Docker container, runs all migrations against
 * it, and hands back a pool. One container per integration test file —
 * call this in `beforeAll` and `stop()` in `afterAll`.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16',
  ).start();
  const connectionString = container.getConnectionUri();

  await runner({
    databaseUrl: connectionString,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {
      /* silence node-pg-migrate's own console logging during tests */
    },
  });

  const pool = createPool({ connectionString });

  async function truncateAll(): Promise<void> {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('pgmigrations')`,
    );
    if (rows.length === 0) return;
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  }

  async function stop(): Promise<void> {
    await pool.end();
    await container.stop();
  }

  return { pool, connectionString, truncateAll, stop };
}
