/**
 * M3's reserve -> charge -> ship example: real workflow code, replayed —
 * replacing M2's hardcoded-switch version. The three activities are
 * genuinely registered functions (`defineActivity`), and the sequencing
 * lives entirely in the workflow function's own `await` calls.
 */
import type { Pool } from 'pg';
import type { WorkflowContext } from '@karyakram/core';
import {
  defineActivity,
  defineWorkflow,
  type ActivityDefinition,
  type AnyActivityDefinition,
} from '../authoring';

export interface OrderInput {
  orderId: string;
}

export interface OrderResult {
  orderId: string;
  status: 'done';
  shipped: unknown;
}

export const reserveChargeShip = defineWorkflow<OrderInput, OrderResult>(
  'reserve-charge-ship',
  async (input, ctx: WorkflowContext) => {
    const reserved = await ctx.scheduleActivity('reserve', input);
    const charged = await ctx.scheduleActivity('charge', reserved);
    const shipped = await ctx.scheduleActivity('ship', charged);
    return { orderId: input.orderId, status: 'done', shipped };
  },
);

/**
 * A side channel purely for proving the M3 crash-recovery guarantee: the
 * event log alone can't observably distinguish "this activity's function
 * ran exactly once" from "replay is broken and it silently ran twice" —
 * a duplicate `ActivityScheduled`/`ActivityCompleted` pair would still
 * fold into a sensible-looking state. This table is incremented inside
 * the activity function's own body, so it's a direct measure of real
 * execution count, independent of the event log.
 */
export async function ensureActivityExecutionsTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS activity_executions (
       activity_type TEXT NOT NULL,
       executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

export async function getActivityExecutionCount(pool: Pool, activityType: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*) FROM activity_executions WHERE activity_type = $1',
    [activityType],
  );
  return Number(rows[0]?.count ?? 0);
}

function trackedActivity<Input, Result>(
  pool: Pool,
  activityType: string,
  run: (input: Input) => Promise<Result>,
): ActivityDefinition<Input, Result> {
  return defineActivity<Input, Result>(activityType, async (input) => {
    await pool.query('INSERT INTO activity_executions (activity_type) VALUES ($1)', [activityType]);
    return run(input);
  });
}

/** Fake/no-op activities, per the M2/M3 plans — the point is the plumbing around them. */
export function createReserveChargeShipActivities(pool: Pool): AnyActivityDefinition[] {
  return [
    trackedActivity(pool, 'reserve', async (input: OrderInput) => ({
      reserved: true,
      orderId: input.orderId,
    })),
    trackedActivity(pool, 'charge', async (input: unknown) => ({
      charged: true,
      of: input,
    })),
    trackedActivity(pool, 'ship', async (input: unknown) => ({
      shipped: true,
      of: input,
    })),
  ];
}
