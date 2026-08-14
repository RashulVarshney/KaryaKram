# Design note: the Postgres task queue

Status: **implemented** (M1 complete). Originally written before the
schema/code existed, per the project rule that design notes come first;
the `EXPLAIN ANALYZE` section and "Implementation notes" below were added
during M1's wrap-up, after the schema, queue functions, worker run loop,
and tests were built and proven against real Postgres.

## What this queue has to guarantee

Many workers, running as separate OS processes with separate DB
connections, need to pull work off a shared `tasks` table such that:

1. No two workers ever get handed the _same pending task_ at the same time.
2. A worker that dies mid-task doesn't take the task down with it — some
   other worker eventually gets a chance to finish it.
3. None of this requires a lock service, a leader, or anything outside
   Postgres itself.

Everything below is in service of those three guarantees.

## Why `FOR UPDATE SKIP LOCKED` prevents double-dispatch — without killing concurrency

The dequeue query, in shape, is:

```sql
WITH candidate AS (
  SELECT id FROM tasks
  WHERE status = 'pending' ...
  ORDER BY run_after, id
  LIMIT $n
  FOR UPDATE SKIP LOCKED
)
UPDATE tasks SET status = 'leased', ... FROM candidate ...
RETURNING ...;
```

`FOR UPDATE` alone (no `SKIP LOCKED`) would already prevent two workers
from claiming the same row: it takes a row-level lock on every row the
`SELECT` touches, and that lock is held until the transaction commits.
That's correct — but it's _not enough on its own_, because of what happens
to the _second_ worker's identical query: it doesn't fail, it **blocks**,
sitting there waiting for worker A's transaction to release the lock. Only
once A commits does B's query wake up — and it wakes up to find those
specific rows already flipped to `leased`, so it has to fall through to
the _next_ available rows. The correctness holds, but every worker is now
queued behind whichever worker happens to be running whichever
transaction — throughput collapses toward one effective worker at a time,
exactly the "single-threaded process" problem we were trying to avoid by
running N processes.

`SKIP LOCKED` changes what the second worker's query does when it meets a
locked row: instead of blocking on it, it treats the row as if it weren't
there and moves on to the next unlocked candidate. So worker A locks rows
1–10, and worker B's `SELECT ... FOR UPDATE SKIP LOCKED` — running at the
same instant — simply never sees rows 1–10 as candidates at all; it locks
11–20 instead. Neither worker waits on the other. That's what makes N
worker processes actually run at N-way concurrency instead of serializing
through the queue.

The reason there's no window where a row is _visible-and-unclaimed_ to a
second reader — i.e., no window where B could still see a row as `pending`
after A has already decided to take it — is that the row-lock and the
`status = 'leased'` write happen inside **one statement, one transaction**
(the `WITH ... UPDATE ... RETURNING` is atomic). There's no gap between
"I've decided to take this row" and "this row is now marked taken" for a
concurrent query to slip into.

## Leases vs. delete-on-dequeue

The simplest possible "claim a task" design deletes the row the moment a
worker picks it up — no more row, no other worker can pick it up. This is
wrong for this system for one reason: **it deletes the state that lets a
crashed worker's work be discovered.**

If worker A dequeues (and deletes) a task, then gets `kill -9`'d before
finishing it, there is now no record anywhere that the task ever existed,
much less that it needs to be retried. The task is just gone — silently,
permanently, with no signal to anything that a task disappeared. That's
the exact failure mode this whole project exists to prevent.

A **lease** keeps the row, and instead of "claimed" being permanent, it's
time-bounded: `status = 'leased'`, `leased_by = <worker>`,
`lease_expires_at = now() + ttl`. The task still physically exists in the
table the whole time a worker is working on it. If the worker finishes,
it marks the row `completed` (or `pending`/`dead` on failure). If the
worker dies, it does nothing — the row just sits there with a
`lease_expires_at` that will pass, at which point the **reaper** (below)
notices and puts it back into circulation. Nothing about a crash requires
any process to have _detected_ the crash for the system to recover; it
only requires that nobody renews the lease.

## Why liveness is heartbeat-based, not a separate health-check service

An alternative design would run a health-check service that pings each
worker process (or has workers register with a coordinator) and
explicitly marks a worker's tasks for reclaim when a health check fails.
That requires: a second system, a definition of "unreachable" distinct
from "slow," and a way to avoid that system itself becoming a single
point of failure.

The heartbeat approach sidesteps all of that by inverting who is
responsible for proving liveness. A worker holding a lease is required to
periodically run `UPDATE tasks SET lease_expires_at = now() + ttl WHERE
id = ANY($taskIds) AND leased_by = $workerId AND status = 'leased'`. If it
stops running that update — for _any_ reason: crashed, network-partitioned,
stuck in an infinite loop, `kill -9`'d, the machine lost power — the
lease simply expires on its own, on a clock that already lives in the
same table the task lives in. Nothing has to actively notice the worker
is gone. The absence of a heartbeat _is_ the failure signal, and it's
read by whichever process runs the reaper query next, whenever that is.
This means liveness detection needs zero additional infrastructure and
has no separate failure mode of its own to reason about.

## Why the one-workflow-task invariant lives in the schema, not application code

The invariant is: **at most one in-flight `workflow` task per
`workflow_id`, at any time.** If this were enforced by application code —
e.g., "before enqueueing a workflow task, `SELECT` to check whether one
already exists" — it would be a textbook TOCTOU (time-of-check to
time-of-use) race: two concurrent enqueue calls could both run that
`SELECT`, both see "none exists," and both `INSERT`, because the check and
the insert aren't atomic with respect to each other across connections.

A partial unique index —

```sql
CREATE UNIQUE INDEX one_workflow_task_per_wf
  ON tasks (workflow_id)
  WHERE task_type = 'workflow' AND status IN ('pending','leased');
```

— makes Postgres itself refuse the second `INSERT`, atomically, as part of
the insert statement. There is no gap for a race to live in, because the
uniqueness check and the write are the same operation from Postgres's
point of view. `enqueue()` just needs to catch the resulting `23505`
unique-violation on _this specific constraint_ and treat it as "a
workflow task already exists — that's fine, that's the correct state,"
rather than as an error.

## Deferred: polling vs. `LISTEN/NOTIFY`

M1 workers discover new tasks by polling — repeatedly running the dequeue
query on an interval. This has two costs: latency is bounded by the poll
interval (a task can sit `pending` for up to that long before anyone looks
for it), and there's constant DB load even when the queue is empty.

`LISTEN/NOTIFY` would let Postgres push a notification to listening
workers the instant a task is enqueued — near-zero latency, no idle
polling load. It's deferred to M6 anyway, for two reasons: it needs a
dedicated, long-lived connection per listener (a real resource cost at
scale that interacts with connection pooling), and its delivery is
**at-most-once** — a notification sent while no one is listening (e.g.
during a deploy) is simply lost, so polling has to remain as a backstop
regardless. Given that polling can't be removed even after adding
`LISTEN/NOTIFY`, and the actual latency/load numbers aren't known yet,
building it now would be optimizing before measuring. M7 benchmarks the
before/after once M6 adds it.

## Deferred: single-row vs. batched dequeue

`dequeue` already takes a `limit`, so batching more than one task per
round-trip is mechanically already possible — the deferred question is
_how_ to size and use that batch across a fleet of workers with uneven
speeds. Batching amortizes the cost of a round-trip to Postgres over more
tasks, which matters at high throughput. But a worker that grabs a large
batch and then runs slowly (or gets stuck) is now hoarding leases on
tasks that a faster, idle worker could otherwise be finishing —
under-utilizing the fleet in exactly the way `SKIP LOCKED` concurrency was
supposed to prevent. Tuning this trade-off sensibly needs real throughput
numbers, which don't exist until M7. Deferred to M6.

## The honest boundary: this queue is at-least-once, and that's inherent

Leases have a finite TTL, and a worker that's merely _slow_ — not dead —
can still have its lease expire before it finishes, at which point the
reaper puts the task back into circulation and a second worker may pick
it up and run it too. **This cannot be fixed inside the queue layer.**
The queue has no way to distinguish "this worker is dead" from "this
worker is alive but running long" — both look identical from the outside
(no heartbeat arriving in time). Any TTL short enough to catch dead
workers quickly will, under load or a slow task, also occasionally expire
a live worker's lease.

The only correct response to this is to not fight it at the queue layer:
guarantee **at-least-once** delivery of a task to a handler, and push the
"don't double-charge the customer" problem to where it can actually be
solved — idempotency at the activity level (M4) and, for workflow
decision logic specifically, deterministic replay (M3) that makes
re-running the _decision_ safe even when the underlying task ran more
than once. See the M1 test plan's "at-least-once boundary, tested rather
than assumed" case — this isn't a hoped-for property, it's something the
test suite has to actively demonstrate (never-concurrent, possibly
more-than-once) rather than merely not contradict.

## `EXPLAIN ANALYZE` on the dequeue query

Run against `tasks` seeded with 500 workflows × 20 pending activity tasks
each (10,000 rows), leasing a batch of 10:

```
 Update on tasks t  (cost=8.60..16.65 rows=1 width=114) (actual time=0.180..0.287 rows=10 loops=1)
   CTE candidate
     ->  Limit  (cost=0.29..8.32 rows=1 width=22) (actual time=0.029..0.039 rows=10 loops=1)
           ->  LockRows  (cost=0.29..8.32 rows=1 width=22) (actual time=0.028..0.037 rows=10 loops=1)
                 ->  Index Scan using tasks_dispatch_idx on tasks  (cost=0.29..8.31 rows=1 width=22) (actual time=0.022..0.026 rows=10 loops=1)
                       Index Cond: ((queue = 'default'::text) AND (run_after <= now()))
                       Filter: (status = 'pending'::text)
   ->  Nested Loop  (cost=0.28..8.33 rows=1 width=114) (actual time=0.054..0.091 rows=10 loops=1)
         ->  CTE Scan on candidate c  (cost=0.00..0.02 rows=1 width=40) (actual time=0.047..0.062 rows=10 loops=1)
         ->  Index Scan using tasks_pkey on tasks t  (cost=0.28..8.30 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=10)
               Index Cond: (id = c.id)
 Planning Time: 0.371 ms
 Execution Time: 0.472 ms
```

Confirms the dequeue query hits `tasks_dispatch_idx` via an `Index Scan`
(not a sequential scan) to find candidates, `LockRows` is where
`FOR UPDATE SKIP LOCKED` actually happens, and the subsequent update
touches each locked row directly by primary key (`tasks_pkey`). Sub-
millisecond execution time at 10k rows — no surprise, since the whole
point of the partial index is that Postgres never has to look at rows
that aren't `pending`.

## Implementation notes (added during M1 wrap-up)

**A testing pitfall that nearly invalidated the crash-recovery proof.**
The integration tests and the `demo:m1` script need to spawn _real_ OS
processes for workers (per the M1 test plan — async loops in one process
wouldn't exercise real concurrent DB connections) and then `kill -9` some
of them to simulate a crash. The first version of the spawn helper ran
workers via `node_modules/.bin/tsx <script>`. That binary is a shell shim
that `exec`s into `tsx`'s CLI (`cli.mjs`) — but `cli.mjs` itself then
spawns a _second, separate_ Node process to actually run the target
script under its loader hooks (confirmed with `ps --ppid`: two distinct
PIDs, parent and child). `child.kill('SIGKILL')` from the spawning test
only reached the outer CLI orchestrator's PID, not the inner process
actually running the worker — so a "killed" worker kept dequeuing and
completing tasks in the background, invisibly. This didn't crash
anything; it silently produced misleading results (a "killed" worker
showing _more_ completions than any survivor). Fixed by spawning
`node --import <tsx's loader.mjs> <script>` directly instead of going
through the CLI shim, which runs everything in the one process actually
returned by `spawn()`, so `kill()` reaches what it's supposed to. Worth
recording here because the same pitfall will resurface for any future
milestone that spawns worker processes and needs to kill them for real
(M8's chaos testing, in particular).

**The demo's numbers came out exact, not just "roughly right."** With 8
workers, 2 killed (`maxConcurrency: 25` each) partway through a 10,000-task
run: `attempt > 1` count came out to exactly 50 — precisely
2 workers × 25 in-flight tasks each, i.e. exactly what each killed worker
had leased and not yet completed at the moment of the kill, no more and
no less. Combined with zero duplicate rows in a `UNIQUE(task_id)` results
table and all 10,000 tasks reaching `completed`, this is the concrete
proof behind the guarantees stated in this doc: no double-dispatch under
normal concurrency, and full recovery (via lease expiry + reaper) when
workers actually die.
