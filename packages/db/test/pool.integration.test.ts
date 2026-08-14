import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testcontainers';

// Throwaway M0 test: proves the whole harness works end to end —
// container boots, migrations run, a query round-trips, truncation works.
describe('db test harness sanity check', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  it('inserts and selects a row through the migrated schema', async () => {
    await db.pool.query('INSERT INTO _health_check (note) VALUES ($1)', ['hello']);
    const { rows } = await db.pool.query<{ note: string }>('SELECT note FROM _health_check');
    expect(rows).toEqual([{ note: 'hello' }]);
  });

  it('starts empty after truncation', async () => {
    const { rows } = await db.pool.query('SELECT * FROM _health_check');
    expect(rows).toHaveLength(0);
  });
});
