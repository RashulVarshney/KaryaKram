/**
 * Phase 1 of the durable-LLM-steps work: an audit log of every call that
 * reaches a provider (the mock one, in tests and benchmarks). It lives
 * outside `workflow_events` on purpose — the whole point is to count
 * duplicate provider calls independently of the engine's own
 * bookkeeping, so the engine can never "forget" a call it made.
 * See docs/DECISIONS.md.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE provider_call_audit (
      id           BIGSERIAL PRIMARY KEY,
      workflow_id  TEXT NOT NULL,
      step_id      TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      attempt      INT,
      called_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(
    `CREATE INDEX provider_call_audit_step_idx ON provider_call_audit (workflow_id, step_id);`,
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE provider_call_audit;`);
};
