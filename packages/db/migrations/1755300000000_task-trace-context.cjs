/**
 * M7: carries a task's W3C `traceparent` string across the process
 * boundary between `enqueue()` (wherever the decision to schedule it was
 * made) and `dequeue()` (whichever worker later picks it up) — there's
 * no shared call stack between those two processes, so trace context has
 * to ride along in the same row as everything else the task needs. Null
 * for tasks enqueued outside any active span (e.g. from a script) — a
 * legitimate, expected state, not an error. See docs/07-observability.md.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE tasks ADD COLUMN trace_context TEXT;`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tasks DROP COLUMN trace_context;`);
};
