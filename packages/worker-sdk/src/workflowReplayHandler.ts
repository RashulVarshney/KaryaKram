import type { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import {
  NonDeterminismError,
  replay,
  type WorkflowCommand,
  type WorkflowEventPayload,
} from '@karyakram/core';
import { appendEvents, getEvents, withTransaction, type Task } from '@karyakram/db';
import type { AnyWorkflowDefinition } from './authoring';
import type { TaskHandler } from './worker';

function commandToEvent(command: WorkflowCommand): WorkflowEventPayload {
  switch (command.type) {
    case 'ScheduleActivity':
      return {
        type: 'ActivityScheduled',
        activityType: command.activityType,
        input: command.input,
      };
    case 'CompleteWorkflow':
      return { type: 'WorkflowCompleted', result: command.result };
    case 'FailWorkflow':
      return { type: 'WorkflowFailed', error: command.error };
  }
}

/**
 * A `TaskHandler` for `workflow`-type tasks: load history, replay the
 * registered workflow function against it, and turn whatever commands
 * come out into an `appendEvents` call. `replay()` itself never touches
 * the database — this is the only place a decision becomes durable.
 */
export function createWorkflowReplayHandler(
  pool: Pool,
  workflows: AnyWorkflowDefinition[],
  logger: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }),
): TaskHandler {
  const registry = new Map(workflows.map((w) => [w.workflowType, w]));

  return async (task: Task) => {
    const history = await getEvents(pool, task.workflowId);

    const started = history.find((e) => e.event.type === 'WorkflowStarted');
    if (!started || started.event.type !== 'WorkflowStarted') {
      throw new Error(`workflow ${task.workflowId} has no WorkflowStarted event`);
    }
    const { workflowType, input } = started.event;

    const definition = registry.get(workflowType);
    if (!definition) {
      throw new Error(`no workflow registered for type "${workflowType}"`);
    }

    let result;
    try {
      result = await replay(definition.fn, input, history);
    } catch (err) {
      if (err instanceof NonDeterminismError) {
        // Deliberately not turned into a WorkflowFailed event — see
        // docs/03-replay.md. This propagates out of the handler, so M1's
        // existing fail()/retry/dead-letter path handles it; retries
        // won't fix a structural code mismatch, which is a known, scoped
        // limitation for M3, not a bug.
        logger.error(
          { err, workflowId: task.workflowId, workflowType },
          'non-deterministic workflow replay',
        );
      }
      throw err;
    }

    if (result.commands.length === 0) {
      return;
    }

    const events = result.commands.map(commandToEvent);
    await withTransaction(pool, (client) =>
      appendEvents(client, { workflowId: task.workflowId, events }),
    );
  };
}
