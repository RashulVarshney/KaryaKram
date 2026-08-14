/**
 * The application-facing API: pair a name with a function. No magic
 * beyond that — `defineWorkflow`'s function is replayed by
 * `createWorkflowReplayHandler`, `defineActivity`'s is executed for real
 * by `createActivityHandler`.
 */
import type { WorkflowFn } from '@karyakram/core';

export interface WorkflowDefinition<Input = unknown, Result = unknown> {
  workflowType: string;
  fn: WorkflowFn<Input, Result>;
}

export function defineWorkflow<Input = unknown, Result = unknown>(
  workflowType: string,
  fn: WorkflowFn<Input, Result>,
): WorkflowDefinition<Input, Result> {
  return { workflowType, fn };
}

/**
 * A registry (`createWorkflowReplayHandler`'s `workflows` param) holds
 * definitions with different, unrelated Input/Result types side by side.
 * `Input` appears in a contravariant (function-parameter) position, so
 * `WorkflowDefinition<OrderInput, X>` isn't assignable to
 * `WorkflowDefinition<unknown, unknown>` under strict variance — this
 * alias is the deliberate type-erasure boundary for that, matching how
 * the handler actually uses it: it looks a definition up by name at
 * runtime and calls it with whatever `input` the event log holds, which
 * is `unknown` until then regardless of how it's typed at authoring time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
export type AnyWorkflowDefinition = WorkflowDefinition<any, any>;

export type ActivityFn<Input = unknown, Result = unknown> = (input: Input) => Promise<Result>;

export interface ActivityDefinition<Input = unknown, Result = unknown> {
  activityType: string;
  fn: ActivityFn<Input, Result>;
}

export function defineActivity<Input = unknown, Result = unknown>(
  activityType: string,
  fn: ActivityFn<Input, Result>,
): ActivityDefinition<Input, Result> {
  return { activityType, fn };
}

/** Same type-erasure reasoning as `AnyWorkflowDefinition`, for `createActivityHandler`'s registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see AnyWorkflowDefinition's comment
export type AnyActivityDefinition = ActivityDefinition<any, any>;
