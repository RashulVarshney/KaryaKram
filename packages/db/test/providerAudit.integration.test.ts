import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countProviderCallsByStep,
  listProviderCalls,
  recordProviderCall,
} from '../src/providerAudit';
import { startTestDatabase, type TestDatabase } from './testcontainers';

describe('provider_call_audit', () => {
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

  it('records calls outside the workflow event store and counts them per step', async () => {
    await recordProviderCall(db.pool, {
      workflowId: 'wf',
      stepId: 'llm-0',
      requestHash: 'h0',
      attempt: 1,
    });
    await recordProviderCall(db.pool, {
      workflowId: 'wf',
      stepId: 'llm-1',
      requestHash: 'h1',
      attempt: 1,
    });
    await recordProviderCall(db.pool, {
      workflowId: 'wf',
      stepId: 'llm-1',
      requestHash: 'h1',
      attempt: 2,
    });
    await recordProviderCall(db.pool, { workflowId: 'other', stepId: 'llm-0', requestHash: 'h0' });

    expect(await countProviderCallsByStep(db.pool, 'wf')).toEqual({ 'llm-0': 1, 'llm-1': 2 });
    const rows = await listProviderCalls(db.pool, 'wf');
    expect(rows.map((r) => [r.stepId, r.attempt])).toEqual([
      ['llm-0', 1],
      ['llm-1', 1],
      ['llm-1', 2],
    ]);
    const events = await db.pool.query('SELECT count(*) AS n FROM workflow_events');
    expect(Number((events.rows[0] as { n: string }).n)).toBe(0);
  });
});
