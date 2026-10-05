import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { foldEvents, type ToolCompletedEvent, type ToolFailedEvent } from '@karyakram/core';
import { dequeue, getEvents, listSideEffects } from '@karyakram/db';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { defineWorkflow } from '../src/authoring';
import { createSupportToolRegistry } from '../src/examples/supportTools';
import { LeaseLostError } from '../src/fencing';
import { createToolCallHandler } from '../src/toolHandler';
import { ToolError, ToolRegistry } from '../src/tools';
import { startWorkflow } from '../src/startWorkflow';
import {
  eventTypes,
  startCluster,
  waitForEventType,
  waitForStatus,
  type Cluster,
} from './llmHarness';
import { MockProvider } from '@karyakram/llm';

const lookupFlow = defineWorkflow<{ customerId: string }, string>(
  'wf-lookup',
  async (input, ctx) => {
    const c = await ctx.toolCall<{ name: string }>('lookup_customer', {
      customerId: input.customerId,
    });
    return c.name;
  },
);

const badToolFlow = defineWorkflow<{ tool: string; args: unknown }, unknown>(
  'wf-bad-tool',
  async (input, ctx) => ctx.toolCall(input.tool, input.args),
);

const provider = new MockProvider();

async function leaseOnly(
  db: TestDatabase,
  registry: ToolRegistry,
  wf: typeof lookupFlow,
  input: { customerId: string },
) {
  // workflow worker only: leaves the tool task pending so tests can lease it by hand
  const cluster = startCluster(db.pool, { provider, workflows: [wf], registry: undefined });
  const id = await startWorkflow(db.pool, wf, input);
  await waitForEventType(db.pool, id, 'TOOL_REQUESTED');
  await cluster.stop();
  const [task] = await dequeue(db.pool, {
    workerId: 'w1',
    taskType: 'tool',
    limit: 1,
    leaseSeconds: 30,
  });
  if (!task) throw new Error('expected a tool task');
  return { id, task, handler: createToolCallHandler(db.pool, { registry }) };
}

describe('durable tool_call step', () => {
  let db: TestDatabase;
  let cluster: Cluster | null = null;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });
  afterEach(async () => {
    await cluster?.stop();
    cluster = null;
  });

  it('runs a registered tool end to end and records the ledger row, the side effect and the events', async () => {
    cluster = startCluster(db.pool, {
      provider,
      workflows: [lookupFlow],
      registry: createSupportToolRegistry(),
    });
    const id = await startWorkflow(db.pool, lookupFlow, { customerId: 'cust-1' });
    await waitForStatus(db.pool, id, 'COMPLETED');

    expect(await eventTypes(db.pool, id)).toEqual([
      'WorkflowStarted',
      'TOOL_REQUESTED',
      'TOOL_COMPLETED',
      'WorkflowCompleted',
    ]);
    const completed = (await getEvents(db.pool, id))[2]?.event as ToolCompletedEvent;
    expect(completed).toMatchObject({ stepId: 'tool-0', tool: 'lookup_customer', attempt: 1 });
    expect(await listSideEffects(db.pool, id)).toEqual([
      { workflowId: id, stepId: 'tool-0', kind: 'customer_lookup' },
    ]);
    const { rows } = await db.pool.query(
      'SELECT step_id, completed_at IS NOT NULL AS done FROM tool_executions WHERE workflow_id = $1',
      [id],
    );
    expect(rows).toEqual([{ step_id: 'tool-0', done: true }]);
    expect(foldEvents(await getEvents(db.pool, id)).result).toMatch(/^Customer /);
  });

  it('rejects an unknown tool: TOOL_FAILED, handler never runs, no side effect', async () => {
    cluster = startCluster(db.pool, {
      provider,
      workflows: [badToolFlow],
      registry: createSupportToolRegistry(),
    });
    const id = await startWorkflow(db.pool, badToolFlow, { tool: 'rm_rf', args: {} });
    await waitForStatus(db.pool, id, 'FAILED');

    const failed = (await getEvents(db.pool, id)).find((e) => e.event.type === 'TOOL_FAILED')
      ?.event as ToolFailedEvent;
    expect(failed).toMatchObject({ code: 'unknown_tool', retryable: false });
    expect(failed.error).toMatch(/not registered/);
    expect(await listSideEffects(db.pool, id)).toEqual([]);
    expect((await db.pool.query('SELECT 1 FROM tool_executions')).rowCount).toBe(0);
  });

  it('rejects arguments that violate the schema: TOOL_FAILED invalid_args, handler never runs', async () => {
    cluster = startCluster(db.pool, {
      provider,
      workflows: [badToolFlow],
      registry: createSupportToolRegistry(),
    });
    const id = await startWorkflow(db.pool, badToolFlow, {
      tool: 'lookup_customer',
      args: { customerId: 42, extra: true },
    });
    await waitForStatus(db.pool, id, 'FAILED');

    const failed = (await getEvents(db.pool, id)).find((e) => e.event.type === 'TOOL_FAILED')
      ?.event as ToolFailedEvent;
    expect(failed).toMatchObject({ code: 'invalid_args', retryable: false });
    expect(failed.error).toMatch(/invalid arguments for tool "lookup_customer"/);
    expect(await listSideEffects(db.pool, id)).toEqual([]);
  });

  it('is idempotent: a redelivered task after success applies the side effect zero more times', async () => {
    const registry = createSupportToolRegistry();
    const { id, task, handler } = await leaseOnly(db, registry, lookupFlow, { customerId: 'c' });
    await handler(task);
    await handler(task); // redelivery
    await handler(task);
    expect(await listSideEffects(db.pool, id)).toHaveLength(1);
    expect((await eventTypes(db.pool, id)).filter((t) => t === 'TOOL_COMPLETED')).toHaveLength(1);
  });

  it('two concurrent executions of the same step apply the side effect exactly once and return one result', async () => {
    const registry = createSupportToolRegistry();
    const { id, task, handler } = await leaseOnly(db, registry, lookupFlow, { customerId: 'race' });
    await Promise.all([handler(task), handler(task), handler(task)]);
    expect(await listSideEffects(db.pool, id)).toHaveLength(1);
    expect((await eventTypes(db.pool, id)).filter((t) => t === 'TOOL_COMPLETED')).toHaveLength(1);
    expect((await db.pool.query('SELECT 1 FROM tool_executions')).rowCount).toBe(1);
  });

  it('a failure after the side effect but before the result is recorded rolls the effect back, so the retry applies it once', async () => {
    let calls = 0;
    const registry = new ToolRegistry().register<{ customerId: string }, { ok: true }>({
      name: 'lookup_customer',
      argsSchema: {
        type: 'object',
        properties: { customerId: { type: 'string' } },
        required: ['customerId'],
      },
      async handler(args, ctx) {
        calls++;
        await ctx.client.query(
          `INSERT INTO side_effects (workflow_id, step_id, kind, payload) VALUES ($1, $2, 'effect', '{}'::jsonb)`,
          [ctx.workflowId, ctx.stepId],
        );
        if (calls === 1) throw new ToolError('crashed after the side effect', { retryable: true });
        return { ok: true };
      },
    });
    const { id, task, handler } = await leaseOnly(db, registry, lookupFlow, { customerId: 'x' });

    await expect(handler(task)).rejects.toBeInstanceOf(ToolError);
    expect(await listSideEffects(db.pool, id)).toEqual([]); // rolled back with everything else
    expect((await db.pool.query('SELECT 1 FROM tool_executions')).rowCount).toBe(0);

    await handler({ ...task, attempt: task.attempt }); // the retry
    expect(await listSideEffects(db.pool, id)).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('a worker that lost its lease writes nothing, and its side effect is rolled back', async () => {
    const registry = createSupportToolRegistry();
    const { id, task, handler } = await leaseOnly(db, registry, lookupFlow, {
      customerId: 'fenced',
    });
    await db.pool.query(
      `UPDATE tasks SET leased_by = 'w2', attempt = 2, lease_expires_at = now() + interval '30 seconds' WHERE id = $1`,
      [task.id],
    );
    await expect(handler(task)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await listSideEffects(db.pool, id)).toEqual([]);
    expect((await eventTypes(db.pool, id)).includes('TOOL_COMPLETED')).toBe(false);

    await handler({ ...task, leasedBy: 'w2', attempt: 2 });
    expect(await listSideEffects(db.pool, id)).toHaveLength(1);
  });
});
