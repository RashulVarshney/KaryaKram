/**
 * M6: `scheduler_leadership` is observability only — a single row that
 * whoever currently holds the leader advisory lock upserts, so "who's
 * leader right now" is a plain SELECT for a demo/operator. It is never
 * consulted by the election logic itself; the advisory lock alone
 * decides who's leader. See docs/06-scheduler.md.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE scheduler_leadership (
      id          INT PRIMARY KEY DEFAULT 1,
      leader_id   TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT scheduler_leadership_singleton CHECK (id = 1)
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE scheduler_leadership;`);
};
