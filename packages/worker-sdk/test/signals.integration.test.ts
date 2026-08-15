import { foldEvents } from '@karyakram/core';
import { getEvents } from '@karyakram/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { defineWorkflow } from '../src/authoring';
import { createWorkflowReplayHandler } from '../src/workflowReplayHandler';
import { sendSignal } from '../src/sendSignal';
import { startWorkflow } from '../src/startWorkflow';
import { Worker } from '../src/worker';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const approvalWorkflow = defineWorkflow<{ orderId: string }, { approved: boolean }>(
  'approval-workflow',
  async (_input, ctx) => {
    const approval = await ctx.waitForSignal<{ approved: boolean }>('approval');
    return { approved: approval.approved };
  },
);

describe('signals end-to-end, through a real replay Worker', () => {
  let db: TestDatabase;
  let worker: Worker | undefined;

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
    await worker?.stop();
    worker = undefined;
  });

  it('a workflow blocked on waitForSignal resumes and completes once sendSignal is called', async () => {
    const workflowId = await startWorkflow(db.pool, approvalWorkflow, { orderId: 'sig-1' });

    worker = new Worker(
      db.pool,
      {
        workerId: 'workflow-1',
        taskType: 'workflow',
        maxConcurrency: 5,
        leaseSeconds: 10,
        heartbeatIntervalMs: 2_000,
        pollIntervalMs: 20,
      },
      createWorkflowReplayHandler(db.pool, [approvalWorkflow]),
    );
    worker.start();

    // Give the worker a moment to process the initial workflow task —
    // it should find nothing new to decide (waitForSignal hangs, no
    // command) and the workflow should still be RUNNING.
    await sleep(200);
    const { rows: beforeSignal } = await db.pool.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id = $1',
      [workflowId],
    );
    expect(beforeSignal[0]?.status).toBe('RUNNING');

    await sendSignal(db.pool, workflowId, 'approval', { approved: true });

    const deadline = Date.now() + 10_000;
    let status = 'RUNNING';
    while (status !== 'COMPLETED' && Date.now() < deadline) {
      const { rows } = await db.pool.query<{ status: string }>(
        'SELECT status FROM workflow_executions WHERE id = $1',
        [workflowId],
      );
      status = rows[0]?.status ?? 'RUNNING';
      if (status !== 'COMPLETED') await sleep(50);
    }
    expect(status).toBe('COMPLETED');

    const events = await getEvents(db.pool, workflowId);
    const state = foldEvents(events);
    expect(state.status).toBe('COMPLETED');
    expect(state.result).toEqual({ approved: true });
    expect(state.signals['approval']).toEqual([{ approved: true }]);
  });
});
