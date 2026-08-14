/**
 * Trivial first migration for M0 — proves the migration harness works in
 * both directions. The real schema (workflow_executions, workflow_events,
 * tasks) is written in M1's migration, not here.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE _health_check (
      id         SERIAL PRIMARY KEY,
      note       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE _health_check;`);
};
