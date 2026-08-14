import { randomUUID } from 'node:crypto';
import { foldEvents } from '@karyakram/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendEvents, getEvents } from '../src/eventStore';
import { withTransaction } from '../src/transaction';
import { startTestDatabase, type TestDatabase } from './testcontainers';

async function createWorkflow(db: TestDatabase): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES ($1, 'demo', '{}'::jsonb, 'RUNNING')`,
    [id],
  );
  return id;
}

describe('eventStore against real Postgres', () => {
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

  it('assigns strictly increasing seq, even under concurrent appenders', async () => {
    const workflowId = await createWorkflow(db);

    // Two concurrent callers, each appending 2 events to the same
    // workflow. The FOR UPDATE lock in appendEvents should serialize
    // them — no duplicate or gapped seq afterward.
    await Promise.all([
      withTransaction(db.pool, (client) =>
        appendEvents(client, {
          workflowId,
          events: [
            { type: 'WorkflowStarted', workflowType: 'demo', input: {} },
            { type: 'ActivityScheduled', activityType: 'a', input: null },
          ],
        }),
      ),
      withTransaction(db.pool, (client) =>
        appendEvents(client, {
          workflowId,
          events: [
            { type: 'ActivityScheduled', activityType: 'b', input: null },
            { type: 'ActivityScheduled', activityType: 'c', input: null },
          ],
        }),
      ),
    ]);

    const events = await getEvents(db.pool, workflowId);
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(4);
  });

  it('enqueues exactly one activity task per ActivityScheduled event, with matching scheduled_event_seq', async () => {
    const workflowId = await createWorkflow(db);

    const { storedEvents } = await withTransaction(db.pool, (client) =>
      appendEvents(client, {
        workflowId,
        events: [
          { type: 'WorkflowStarted', workflowType: 'demo', input: {} },
          { type: 'ActivityScheduled', activityType: 'reserve', input: null },
        ],
      }),
    );
    const scheduledSeq = storedEvents.find((e) => e.event.type === 'ActivityScheduled')?.seq;

    const { rows } = await db.pool.query<{ scheduled_event_seq: string; task_type: string }>(
      `SELECT scheduled_event_seq, task_type FROM tasks WHERE workflow_id = $1 AND task_type = 'activity'`,
      [workflowId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.scheduled_event_seq)).toBe(scheduledSeq);
  });

  it('enqueues exactly one workflow task per appendEvents call, swallowing the conflict on later calls', async () => {
    const workflowId = await createWorkflow(db);

    await withTransaction(db.pool, (client) =>
      appendEvents(client, {
        workflowId,
        events: [{ type: 'WorkflowStarted', workflowType: 'demo', input: {} }],
      }),
    );
    await withTransaction(db.pool, (client) =>
      appendEvents(client, {
        workflowId,
        events: [{ type: 'ActivityScheduled', activityType: 'reserve', input: null }],
      }),
    );

    // M1's invariant: at most one live `workflow` task per workflow,
    // regardless of how many times appendEvents tried to enqueue one.
    const { rows } = await db.pool.query(
      `SELECT id FROM tasks WHERE workflow_id = $1 AND task_type = 'workflow'`,
      [workflowId],
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps workflow_executions.status in sync with foldEvents(getEvents(...)) after every append', async () => {
    const workflowId = await createWorkflow(db);

    async function statusInDb(): Promise<string> {
      const { rows } = await db.pool.query<{ status: string }>(
        'SELECT status FROM workflow_executions WHERE id = $1',
        [workflowId],
      );
      const status = rows[0]?.status;
      if (!status) throw new Error('unreachable');
      return status;
    }

    await withTransaction(db.pool, (client) =>
      appendEvents(client, {
        workflowId,
        events: [
          { type: 'WorkflowStarted', workflowType: 'demo', input: {} },
          { type: 'ActivityScheduled', activityType: 'reserve', input: null },
        ],
      }),
    );
    let events = await getEvents(db.pool, workflowId);
    expect(await statusInDb()).toBe(foldEvents(events).status);
    expect(await statusInDb()).toBe('RUNNING');

    const scheduledSeq = events.find((e) => e.event.type === 'ActivityScheduled')?.seq;
    if (scheduledSeq === undefined) throw new Error('unreachable');

    await withTransaction(db.pool, (client) =>
      appendEvents(client, {
        workflowId,
        events: [
          { type: 'ActivityCompleted', scheduledEventSeq: scheduledSeq, result: null },
          { type: 'WorkflowCompleted', result: { ok: true } },
        ],
      }),
    );
    events = await getEvents(db.pool, workflowId);
    expect(await statusInDb()).toBe(foldEvents(events).status);
    expect(await statusInDb()).toBe('COMPLETED');
  });
});
