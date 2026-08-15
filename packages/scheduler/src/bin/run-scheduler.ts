import { createPoolFromEnv } from '@karyakram/db';
import { createTaskMetrics, MetricsServer, startTracing } from '@karyakram/observability';
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

  const tracing = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    ? startTracing(`scheduler-${leaderId}`)
    : undefined;
  const metricsServer = process.env['METRICS_PORT'] ? new MetricsServer() : undefined;
  const metrics = metricsServer ? createTaskMetrics(metricsServer.registry) : undefined;
  if (metricsServer) metricsServer.start(Number(requireEnv('METRICS_PORT')));

  const scheduler = new Scheduler(
    pool,
    {
      connectionString,
      leaderId,
      electionPollMs: optionalNumber('ELECTION_POLL_MS'),
      reconnectDelayMs: optionalNumber('ELECTION_RECONNECT_MS'),
      reaper: { intervalMs: optionalNumber('REAPER_INTERVAL_MS') },
      queueDepthIntervalMs: optionalNumber('QUEUE_DEPTH_INTERVAL_MS'),
    },
    undefined,
    metrics,
  );

  const shutdown = (): void => {
    void scheduler
      .stop()
      .then(() => Promise.all([pool.end(), metricsServer?.stop(), tracing?.shutdown()]))
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  scheduler.start();
}

void main();
