import { createPoolFromEnv } from '@karyakram/db';
import { Scheduler } from '../scheduler';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

function optionalNumber(name: string): number | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : Number(value);
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();
  const connectionString = requireEnv('DATABASE_URL');
  const leaderId = process.env['SCHEDULER_ID'] ?? `scheduler-${process.pid}`;

  const scheduler = new Scheduler(pool, {
    connectionString,
    leaderId,
    electionPollMs: optionalNumber('ELECTION_POLL_MS'),
    reconnectDelayMs: optionalNumber('ELECTION_RECONNECT_MS'),
    reaper: { intervalMs: optionalNumber('REAPER_INTERVAL_MS') },
  });

  const shutdown = (): void => {
    void scheduler
      .stop()
      .then(() => pool.end())
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  scheduler.start();
}

void main();
