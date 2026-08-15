import { getCurrentLeader } from '@karyakram/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { LeaderElection } from '../src/leaderElection';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  check: () => boolean,
  { timeoutMs, intervalMs = 10 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: condition never became true in time');
    await sleep(intervalMs);
  }
}

describe('LeaderElection', () => {
  let db: TestDatabase;
  const elections: LeaderElection[] = [];

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterEach(async () => {
    await Promise.all(elections.map((e) => e.stop()));
    elections.length = 0;
  });

  function makeElection(leaderId: string): {
    election: LeaderElection;
    acquiredCount: () => number;
    lostCount: () => number;
  } {
    let acquired = 0;
    let lost = 0;
    const election = new LeaderElection(
      { connectionString: db.connectionString, leaderId, electionPollMs: 50, reconnectDelayMs: 50 },
      () => {
        acquired++;
      },
      () => {
        lost++;
      },
    );
    elections.push(election);
    return { election, acquiredCount: () => acquired, lostCount: () => lost };
  }

  it('exactly one of two replicas becomes leader', async () => {
    const a = makeElection('replica-a');
    const b = makeElection('replica-b');

    a.election.start();
    b.election.start();

    await pollUntil(() => a.election.isLeader || b.election.isLeader, { timeoutMs: 5_000 });
    await sleep(200); // let the loser settle — it must never also claim leadership

    expect(a.election.isLeader !== b.election.isLeader).toBe(true);
    expect(a.acquiredCount() + b.acquiredCount()).toBe(1);
  });

  it('records the current leader for observability', async () => {
    const a = makeElection('replica-a');
    a.election.start();

    await pollUntil(() => a.election.isLeader, { timeoutMs: 5_000 });

    const current = await getCurrentLeader(db.pool);
    expect(current?.leaderId).toBe('replica-a');
  });

  it('a survivor takes over within a few election-poll intervals after the leader stops', async () => {
    const a = makeElection('replica-a');
    const b = makeElection('replica-b');

    a.election.start();
    b.election.start();
    await pollUntil(() => a.election.isLeader || b.election.isLeader, { timeoutMs: 5_000 });

    const [leader, survivor] = a.election.isLeader ? [a, b] : [b, a];
    await leader.election.stop();

    await pollUntil(() => survivor.election.isLeader, { timeoutMs: 5_000 });
    expect(survivor.acquiredCount()).toBe(1);

    const current = await getCurrentLeader(db.pool);
    expect(current?.leaderId).toBeDefined();
  });
});
