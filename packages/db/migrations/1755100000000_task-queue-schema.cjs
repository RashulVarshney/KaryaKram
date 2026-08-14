/**
 * M1 schema: workflow_executions, workflow_events, tasks — the Postgres
 * task queue. See docs/01-task-queue.md for the reasoning behind the
 * lease model and the partial unique index below.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE workflow_executions (
      id            UUID PRIMARY KEY,
      workflow_type TEXT NOT NULL,
      input         JSONB NOT NULL,
      status        TEXT NOT NULL,   -- RUNNING|COMPLETED|FAILED|CANCELED|TIMED_OUT
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE workflow_events (
      workflow_id UUID NOT NULL REFERENCES workflow_executions(id),
      seq         BIGINT NOT NULL,           -- monotonic per workflow, starts at 1
      event_type  TEXT NOT NULL,
      payload     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workflow_id, seq)
    );
  `);

  pgm.sql(`
    CREATE TABLE tasks (
      id                  BIGSERIAL PRIMARY KEY,
      task_type           TEXT NOT NULL,     -- 'workflow' | 'activity'
      workflow_id         UUID NOT NULL REFERENCES workflow_executions(id),
      queue               TEXT NOT NULL DEFAULT 'default',
      scheduled_event_seq BIGINT,            -- links activity task -> its ActivityScheduled event
      status              TEXT NOT NULL,     -- pending|leased|completed|dead
      run_after           TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempt             INT NOT NULL DEFAULT 0,
      max_attempts        INT NOT NULL DEFAULT 3,
      last_error          TEXT,
      leased_by           TEXT,
      lease_expires_at    TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE INDEX tasks_dispatch_idx
      ON tasks (queue, run_after, id) WHERE status = 'pending';
  `);

  pgm.sql(`
    CREATE INDEX tasks_lease_idx
      ON tasks (lease_expires_at) WHERE status = 'leased';
  `);

  // THE invariant: at most one live workflow task per workflow.
  // See docs/01-task-queue.md "Why the one-workflow-task invariant lives
  // in the schema, not application code."
  pgm.sql(`
    CREATE UNIQUE INDEX one_workflow_task_per_wf
      ON tasks (workflow_id)
      WHERE task_type = 'workflow' AND status IN ('pending','leased');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE tasks;`);
  pgm.sql(`DROP TABLE workflow_events;`);
  pgm.sql(`DROP TABLE workflow_executions;`);
};
