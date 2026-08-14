import { createPoolFromEnv } from '@karyakram/db';
import { Reaper } from '../reaper';

const pool = createPoolFromEnv();
const reaper = new Reaper(pool, {
  intervalMs: process.env['REAPER_INTERVAL_MS']
    ? Number.parseInt(process.env['REAPER_INTERVAL_MS'], 10)
    : undefined,
});

function shutdown(): void {
  reaper.stop();
  void pool.end().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

reaper.start();
