import path from 'node:path';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'packages', 'db', 'migrations');

export interface ScratchDb {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database on the same Postgres server as DATABASE_URL,
 * runs every migration in it, and hands it back. Benchmarks and chaos runs
 * TRUNCATE tables freely, so they must never be pointed at the dev database
 * itself; this keeps the real data untouched.
 */
export async function createScratchDb(baseUrl: string): Promise<ScratchDb> {
  const name = `karyakram_scratch_${String(Date.now())}`;
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const scratchUrl = url.toString();

  await runner({
    databaseUrl: scratchUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });

  const pool = new Pool({ connectionString: scratchUrl, max: 5 });
  return {
    url: scratchUrl,
    pool,
    async drop() {
      await pool.end();
      const dropper = new Pool({ connectionString: baseUrl, max: 1 });
      await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await dropper.end();
    },
  };
}
