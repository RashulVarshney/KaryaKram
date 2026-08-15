import { Client } from 'pg';
import pino, { type Logger } from 'pino';
import { recordLeadership, tryAcquireLeaderLock } from '@karyakram/db';

export interface LeaderElectionConfig {
  connectionString: string;
  leaderId: string;
  /** How often a non-leader replica retries the advisory lock. */
  electionPollMs?: number;
  /** How long to wait before reconnecting after the election connection drops. */
  reconnectDelayMs?: number;
}

/**
 * Holds a session-scoped Postgres advisory lock on a dedicated
 * connection: whoever holds it is leader, full stop. No heartbeat, no
 * lease TTL, no separate validity check — the lock and the connection's
 * lifetime are the same fact, so Postgres itself releases it the instant
 * the connection closes for any reason, including a `kill -9` of this
 * process. See docs/06-scheduler.md.
 */
export class LeaderElection {
  private readonly electionPollMs: number;
  private readonly reconnectDelayMs: number;
  private readonly logger: Logger;
  private client: Client | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private leader = false;

  constructor(
    private readonly config: LeaderElectionConfig,
    private readonly onAcquire: () => void,
    private readonly onLose: () => void,
    logger: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }),
  ) {
    this.electionPollMs = config.electionPollMs ?? 1_000;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 500;
    this.logger = logger.child({ component: 'leader-election', leaderId: config.leaderId });
  }

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    this.logger.info('leader election starting');
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.config.connectionString });
    client.on('error', (err) => {
      this.logger.warn({ err }, 'election connection error');
      this.handleDisconnect(client);
    });
    client.on('end', () => {
      this.handleDisconnect(client);
    });

    try {
      await client.connect();
    } catch (err) {
      this.logger.warn({ err }, 'election connection failed, retrying');
      this.scheduleReconnect();
      return;
    }

    if (this.stopped) {
      void client.end();
      return;
    }
    this.client = client;
    void this.attemptAcquire();
  }

  private async attemptAcquire(): Promise<void> {
    if (this.stopped || !this.client) return;

    let acquired = false;
    try {
      acquired = await tryAcquireLeaderLock(this.client);
    } catch (err) {
      this.logger.warn({ err }, 'advisory lock attempt failed');
    }

    if (this.stopped) return;

    if (acquired) {
      this.logger.info('acquired leadership');
      try {
        await recordLeadership(this.client, this.config.leaderId);
      } catch (err) {
        // The lock itself is what matters; the leadership row is only
        // for observability (see docs/06-scheduler.md), so a failure
        // here doesn't affect who's actually leader.
        this.logger.warn({ err }, 'failed to record leadership row (lock still held)');
      }
      if (this.stopped) return;
      // Flipped only after the observability write is attempted, so any
      // caller that sees `isLeader` become true can trust
      // `scheduler_leadership` already reflects it (or at least that
      // writing it was already tried) — without this ordering there's a
      // real window where the lock is held but the row isn't there yet.
      this.leader = true;
      this.onAcquire();
      // No further polling needed while the lock is held — this
      // connection keeps it until it closes or is explicitly released.
      return;
    }

    this.pollTimer = setTimeout(() => {
      void this.attemptAcquire();
    }, this.electionPollMs);
  }

  private handleDisconnect(client: Client): void {
    if (this.client !== client) return; // stale event from a superseded connection
    this.client = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.leader) {
      this.leader = false;
      this.logger.warn('election connection lost — stepping down');
      this.onLose();
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, this.reconnectDelayMs);
  }

  /** Steps down (if leader) and closes the election connection, releasing the lock. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const client = this.client;
    this.client = null;
    const wasLeader = this.leader;
    this.leader = false;

    if (client) {
      try {
        await client.end();
      } catch {
        // already closing/closed — the lock is released either way.
      }
    }
    if (wasLeader) this.onLose();
    this.logger.info('leader election stopped');
  }
}
