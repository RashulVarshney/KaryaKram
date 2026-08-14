import { generateWorkerId } from './workerId';

export interface WorkerConfig {
  workerId: string;
  queue: string;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  maxConcurrency: number;
  drainTimeoutMs: number;
}

export interface WorkerConfigInput {
  workerId?: string;
  queue?: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  maxConcurrency: number;
  drainTimeoutMs?: number;
}

/**
 * Fills in defaults and validates invariants that would otherwise fail
 * silently or confusingly at runtime — most importantly, that heartbeats
 * fire often enough to renew a lease before it expires.
 */
export function resolveWorkerConfig(input: WorkerConfigInput): WorkerConfig {
  if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency <= 0) {
    throw new Error(`maxConcurrency must be a positive integer, got ${input.maxConcurrency}`);
  }

  const leaseSeconds = input.leaseSeconds ?? 30;
  if (leaseSeconds <= 0) {
    throw new Error(`leaseSeconds must be > 0, got ${leaseSeconds}`);
  }

  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 10_000;
  if (heartbeatIntervalMs <= 0) {
    throw new Error(`heartbeatIntervalMs must be > 0, got ${heartbeatIntervalMs}`);
  }
  if (heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new Error(
      `heartbeatIntervalMs (${heartbeatIntervalMs}ms) must be less than leaseSeconds * 1000 ` +
        `(${leaseSeconds * 1000}ms), otherwise leases can expire between heartbeats`,
    );
  }

  const pollIntervalMs = input.pollIntervalMs ?? 100;
  const maxPollIntervalMs = input.maxPollIntervalMs ?? 2_000;
  if (maxPollIntervalMs < pollIntervalMs) {
    throw new Error(
      `maxPollIntervalMs (${maxPollIntervalMs}) must be >= pollIntervalMs (${pollIntervalMs})`,
    );
  }

  return {
    workerId: input.workerId ?? generateWorkerId(),
    queue: input.queue ?? 'default',
    pollIntervalMs,
    maxPollIntervalMs,
    leaseSeconds,
    heartbeatIntervalMs,
    maxConcurrency: input.maxConcurrency,
    drainTimeoutMs: input.drainTimeoutMs ?? 30_000,
  };
}
