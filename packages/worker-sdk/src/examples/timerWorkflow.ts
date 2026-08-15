/**
 * M4's durable-timer example: an activity, a sleep, then another
 * activity. `sleepMs` is part of the workflow's own input rather than a
 * hardcoded constant so tests/demos can use a short duration without
 * pretending to test a literal 5 real minutes — see docs/04-durability.md.
 */
import type { Pool } from 'pg';
import type { WorkflowContext } from '@karyakram/core';
import { defineActivity, defineWorkflow, type AnyActivityDefinition } from '../authoring';

export interface TimerWorkflowInput {
  sleepMs: number;
}

export const timerWorkflow = defineWorkflow<TimerWorkflowInput, { done: true }>(
  'timer-workflow',
  async (input, ctx: WorkflowContext) => {
    await ctx.scheduleActivity('before-timer', input);
    await ctx.sleep(input.sleepMs);
    await ctx.scheduleActivity('after-timer', input);
    return { done: true };
  },
);

/** Same execution-counter idea as reserveChargeShip's — proves an activity ran exactly once, independent of event-log shape. */
export async function ensureTimerWorkflowExecutionsTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS timer_workflow_executions (
       activity_type TEXT NOT NULL,
       executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

export async function getTimerWorkflowExecutionCount(
  pool: Pool,
  activityType: string,
): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*) FROM timer_workflow_executions WHERE activity_type = $1',
    [activityType],
  );
  return Number(rows[0]?.count ?? 0);
}

function trackedActivity(pool: Pool, activityType: string): AnyActivityDefinition {
  return defineActivity(activityType, async (input: unknown) => {
    await pool.query('INSERT INTO timer_workflow_executions (activity_type) VALUES ($1)', [
      activityType,
    ]);
    return { activityType, input };
  });
}

export function createTimerWorkflowActivities(pool: Pool): AnyActivityDefinition[] {
  return [trackedActivity(pool, 'before-timer'), trackedActivity(pool, 'after-timer')];
}
