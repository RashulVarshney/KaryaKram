/**
 * Durable tool calls. `tool_executions` is the idempotency ledger: the
 * PRIMARY KEY (workflow_id, step_id) means a step can be executed to
 * completion at most once, no matter how many workers or retries touch
 * it. `side_effects` is the demo tool's target; it deliberately has NO
 * unique constraint, so a duplicated side effect would show up as a
 * duplicate row instead of being silently rejected.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE tool_executions (
      workflow_id  UUID NOT NULL,
      step_id      TEXT NOT NULL,
      tool         TEXT NOT NULL,
      args_hash    TEXT NOT NULL,
      result       JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (workflow_id, step_id)
    );
  `);
  pgm.sql(`
    CREATE TABLE side_effects (
      id          BIGSERIAL PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      step_id     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      payload     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE side_effects;`);
  pgm.sql(`DROP TABLE tool_executions;`);
};
