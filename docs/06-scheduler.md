# Design note: leader election, LISTEN/NOTIFY, and what M6 is not

Status: **implemented** (M6 complete). The "Implementation notes" section
near the end was added during wrap-up.

## What M6 actually resolves, in one sentence

The reaper currently runs as a lone, unsupervised process with no
failover — this milestone gives it (and any future leader-only work) a
Postgres-native single-writer guarantee that survives a `kill -9` of
whichever replica currently holds it, in under 5 seconds, with zero
duplicate side effects.

## Leader election: a session-scoped advisory lock, not a lease table

M1's task leases (`lease_expires_at` + a reaper reclaiming expired ones)
are a fine model for _tasks_, but a bad model for _leadership_: a
lease-based leader still needs someone to notice the lease expired and
race to re-acquire it, which reintroduces exactly the kind of polling
latency this milestone is trying to cut out from the _other_ side
(dequeue) and don't want to duplicate on the election side too.

Postgres advisory locks solve this more directly. `pg_try_advisory_lock(key)`
is **session-scoped**: it's held for as long as the specific TCP
connection that acquired it stays open, and Postgres releases it
automatically — no client code, no timeout, no possibility of forgetting
— the instant that connection closes for _any_ reason, including a
`kill -9` of the process holding it. That maps onto "who's the leader"
exactly: hold a dedicated, long-lived `pg.Client` (never a pooled
connection — pooling would let the lock silently migrate to whichever
physical connection the pool hands out next, which is the opposite of
what a leader lock needs); whoever's connection is holding the lock _is_
the leader, full stop, with no separate "is my lease still valid" check
ever needed because there's nothing to check — the lock's existence and
the connection's existence are the same fact.

Every scheduler replica runs the same loop: if not currently holding the
lock, try `pg_try_advisory_lock` once per `electionPollMs` (default
1000ms); the moment it succeeds, that replica is leader and starts the
leader-only work. If the dedicated connection ever errors or closes,
the replica immediately treats itself as stepped-down (even before
Postgres has necessarily released the lock server-side — being
conservative here costs nothing) and goes back to polling for the lock
on a fresh connection. This bounds failover time to roughly
`electionPollMs` plus however long a fresh replica takes to notice the
old connection is gone (near-instant on a `kill -9`, since that's a TCP
reset) — comfortably under the 5-second exit-criteria bound with the
default poll interval.

**Observability table, not source of truth.** `scheduler_leadership` (one
row, written by whoever currently holds the lock, with its instance ID
and acquisition time) exists purely so a demo or an operator can ask
"who's leader right now" with a plain `SELECT` instead of needing to
attempt the advisory lock themselves. It is not consulted by the election
logic in either direction — the lock alone decides who's leader. Treating
the table as authoritative would reintroduce exactly the staleness
problem advisory locks were chosen to avoid.

## The reaper moves behind leadership, M1's standalone process doesn't move

`packages/worker-sdk/src/reaper.ts` has carried a `TODO(M6)` since M1: running
it from every replica concurrently was always _safe_ (`reclaimExpired` is
`SKIP LOCKED`-safe) but wasteful — every replica hitting the same query on
the same interval doesn't reclaim anything faster than one replica doing
it alone. `packages/scheduler` now owns the authoritative version: it
starts the existing `Reaper` class (unchanged, reused verbatim from
`worker-sdk`) the instant it becomes leader, and stops it the instant it
steps down.

M1 through M4's own demos (`demo.ts`, `demo-m3.ts`, `demo-m4.ts`) still spawn
`run-reaper.ts` as a standalone process, exactly as they always have.
Those demos are proof artifacts for milestones that are already tagged;
rewriting them to depend on M6's scheduler would be rewriting history, not
finishing M6. Standalone reaping remains correct (never wrong, just
redundant if more than one ran) — this milestone adds the leader-gated
version as the path forward, it doesn't retrofit the past.

## LISTEN/NOTIFY: a latency shortcut layered on top of polling, not a replacement for it

`docs/01-task-queue.md` already staked out this project's position:
`LISTEN/NOTIFY` is deferred to M6, polling remains the **permanent**
backstop regardless of what M6 adds, because notify delivery is
at-most-once (a notification sent while nobody happens to be listening —
mid-deploy, say — is simply gone) and because it needs a dedicated
connection per listener, a real resource cost. Nothing in this milestone
reverses that stance.

What M6 adds: `enqueue()` now issues `pg_notify('tasks_available', queue)`
in the same statement as the `INSERT`, so the notification is
transactional — Postgres only delivers it after the enqueueing
transaction actually commits, so a listener never gets woken for a task
that then rolls back. Any `Worker` that opts in gets one dedicated
`pg.Client` running `LISTEN tasks_available` alongside its existing
pooled connection for actual work; on notification, it resets its poll
backoff to the minimum and polls immediately instead of waiting out
whatever backoff delay it had eased up to. If that listen connection
drops, the worker doesn't stop working — it just stops getting the
early wake-up and falls back to polling alone at its normal cadence,
exactly as if `LISTEN/NOTIFY` had never been layered in. The queue is
never _only_ reachable through notify; it's always reachable through
polling, notify just usually makes the wait shorter.

## Explicitly deferred out of M6, and why

**Batched-dequeue tuning.** `dequeue()` already accepts a `limit` — the
open question was never "can we fetch more than one task per round-trip"
(mechanically already possible) but "how should a batch be sized across a
fleet of workers with uneven speeds," and answering that requires the
same real latency/throughput numbers M1's design note deferred it for in
the first place. Those numbers don't exist yet — M7 is where this project
measures anything before optimizing it. Building a batching heuristic now
would be tuning against a guess.

**Fat-worker → gRPC extraction.** The M6 plan stub mentioned this as
in-scope; it's being explicitly descoped here instead, and the reasoning
is worth stating plainly rather than quietly dropping it. This milestone's
exit criteria (kill the leader, prove failover, prove no duplicate
side effects) is entirely about _leadership_, not about the _transport_
between a worker and the database — nothing in leader election requires
workers to stop holding a direct `pg.Pool` connection. Extracting workers
onto a gRPC boundary is a real, defensible architectural direction (it
would let workers run somewhere that can't reach Postgres directly, e.g.
behind a stricter network boundary), but it's a change to how _every_
worker talks to the system, independent of and orthogonal to who's
currently leader — bundling it into this milestone would make M6's exit
demo prove two unrelated things at once, and a failure in the gRPC
extraction would be indistinguishable from a failure in leader election
when the demo goes red. It's left as a candidate for a later milestone,
to be taken up on its own with its own exit criteria, rather than
implemented halfway here to satisfy a stub written before any of this
was investigated.

## Exit demo, restated precisely

`pnpm demo:m6` starts three scheduler replicas against the same database,
confirms exactly one acquires leadership (via `scheduler_leadership`),
`kill -9`'s that replica, and confirms one of the two survivors becomes
the new leader within 5 seconds. It also proves the failover wasn't
cosmetic: a task is seeded with an already-expired lease before the kill,
and the demo confirms it only gets reclaimed once — by the new leader,
after takeover — never twice, and never by two replicas racing each
other.

## Implementation notes

**Failover was faster than the exit criteria in every run.** Six back-to-
back runs of `pnpm demo:m6` measured failover — the gap between `SIGKILL`
and a survivor's advisory-lock acquisition — at 32ms, 142ms, 165ms,
167ms, 193ms, and 223ms, all against the default `electionPollMs: 200`
used by the demo. That's expected, not a coincidence to be suspicious of:
a `kill -9` closes the TCP connection immediately, Postgres notices and
releases the lock right away, and the two surviving replicas are already
mid-poll at up to 200ms intervals — worst case is one poll interval plus
negligible network/scheduling overhead, which is exactly what was
measured. The 5-second exit-criteria bound has a lot of headroom at this
poll interval; it exists to tolerate much coarser polling in a real
deployment; not because this design is close to it.

**`getCurrentLeader` ended up typed as `Queryable` (`Pool | PoolClient`),
not `Client`, unlike the rest of `leadership.ts`.** `tryAcquireLeaderLock`,
`releaseLeaderLock`, and `recordLeadership` all require a dedicated,
session-scoped `Client` — they're meaningless on a pooled connection.
`getCurrentLeader` is a plain read with no session-scoping requirement at
all, and the demo calls it from a `Pool` (it isn't the process holding
the lock, it's just checking who is) — typing it narrower than it needs
to be would have forced the demo to open a throwaway dedicated connection
just to satisfy the type checker for a `SELECT`.

**The reaper's own `TODO(M6)` comment (in place since M1) was updated in
place rather than deleted**, to record that it's resolved and how — see
`packages/worker-sdk/src/reaper.ts`. M1 through M4's demos still spawn it
standalone, unmodified; only `packages/scheduler`'s new demo runs it
behind leader election.

**The plan stub's mention of gRPC extraction as in-scope was superseded**
by the "Explicitly deferred" section above, written after investigating
the codebase rather than before. `docs/plans/m6-scheduler.md` and
`docs/plans/README.md` were both updated to reflect the descoped scope
before any code was written, not after the fact.
