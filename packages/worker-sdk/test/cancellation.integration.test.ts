import { foldEvents } from '@karyakram/core';
import { getEvents, type Task } from '@karyakram/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { createActivityHandler } from '../src/activityHandler';
import { defineActivity, defineWorkflow } from '../src/authoring';
import { cancelWorkflow } from '../src/cancelWorkflow';
import { startWorkflow } from '../src/startWorkflow';
import { createWorkflowReplayHandler } from '../src/workflowReplayHandler';

const twoStepWorkflow = defineWorkflow<{ x: number }, { done: true }>(
  'two-step-cancelable',
  async (input, ctx) => {
    await ctx.scheduleActivity('step1', input);
    await ctx.scheduleActivity('step2', input);
    return { done: true };
  },
);

const step1 = defineActivity('step1', async () => ({ ok: true }));
const step2 = defineActivity('step2', async () => ({ ok: true }));

// Both handlers only read `workflowId` (workflow handler) or
// `workflowId`/`scheduledEventSeq` (activity handler) off the task —
// everything else here is a placeholder. Driving handlers directly
// (rather than through a live polling Worker) makes this test
// deterministic: a live worker racing its own poll loop against this
// test's own calls could process the post-step1 decision before
// `cancelWorkflow` lands, depending on timing — not a bug in the
// mechanism, just not what this test is trying to prove.
function fakeWorkflowTask(workflowId: string): Task {
  return {
    id: 'fake-workflow-task',
    taskType: 'workflow',
    workflowId,
    queue: 'default',
    scheduledEventSeq: null,
    status: 'leased',
    runAfter: new Date(),
    attempt: 1,
    maxAttempts: 3,
    lastError: null,
    leasedBy: 'test-driver',
    leaseExpiresAt: new Date(Date.now() + 30_000),
    createdAt: new Date(),
  };
}

function fakeActivityTask(workflowId: string, scheduledEventSeq: number): Task {
  return {
    id: 'fake-activity-task',
    taskType: 'activity',
    workflowId,
    queue: 'default',
    scheduledEventSeq: String(scheduledEventSeq),
    status: 'leased',
    runAfter: new Date(),
    attempt: 1,
    maxAttempts: 3,
    lastError: null,
    leasedBy: 'test-driver',
    leaseExpiresAt: new Date(Date.now() + 30_000),
    createdAt: new Date(),
  };
}

describe('cancellation: hard, engine-level, checked before replay', () => {
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

  it('ends a running workflow at CANCELED without ever scheduling the remaining activity', async () => {
    const workflowId = await startWorkflow(db.pool, twoStepWorkflow, { x: 1 });
    const workflowHandler = createWorkflowReplayHandler(db.pool, [twoStepWorkflow]);
    const activityHandler = createActivityHandler(db.pool, [step1, step2]);

    // Drive step1 to completion one decision at a time — deterministic,
    // no live worker racing against this test's own calls.
    await workflowHandler(fakeWorkflowTask(workflowId)); // decides: schedule step1
    const afterStep1Scheduled = await getEvents(db.pool, workflowId);
    const scheduled1 = afterStep1Scheduled.find((e) => e.event.type === 'ActivityScheduled');
    if (!scheduled1) throw new Error('unreachable');
    await activityHandler(fakeActivityTask(workflowId, scheduled1.seq)); // runs step1 for real

    // Cancel *before* anything ever gets a chance to decide on step2.
    await cancelWorkflow(db.pool, workflowId, 'test cancel');

    // The next (and only remaining) decision must see the cancellation
    // and end the workflow, never scheduling step2.
    await workflowHandler(fakeWorkflowTask(workflowId));

    const events = await getEvents(db.pool, workflowId);
    const state = foldEvents(events);
    expect(state.status).toBe('CANCELED');
    expect(state.error).toBe('test cancel');

    const scheduledActivityTypes = Object.values(state.activities).map((a) => a.activityType);
    expect(scheduledActivityTypes).toEqual(['step1']);

    const { rows: tasks } = await db.pool.query<{ task_type: string; count: string }>(
      "SELECT task_type, count(*) FROM tasks WHERE workflow_id = $1 AND task_type = 'activity' GROUP BY task_type",
      [workflowId],
    );
    // Only step1's activity task should ever have been created.
    expect(tasks).toHaveLength(1);
  });
});
