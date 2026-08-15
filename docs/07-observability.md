# Design note: tracing, metrics, and the first real numbers

Status: **implemented** (M7 complete). The "Implementation notes" section
near the end was added during wrap-up.

## What M7 actually is

Every milestone before this one earned the right to say "this works."
None of them earned the right to say "this is fast," because nothing was
ever measured — every performance-flavored claim in this repo has been
labeled `TARGET (unmeasured)`. M7 doesn't add engine features; it adds
eyes onto the engine that already exists, then uses those eyes to answer
one concrete, previously-deferred question: does M6's `LISTEN/NOTIFY`
actually reduce queueing latency and idle DB load, or was it exactly the
kind of premature optimization `docs/01-task-queue.md` was worried about
when it deferred measuring it? That question gets a real, run-and-recorded
answer in this milestone's wrap-up, not a guess.

## Tracing: context has to survive a process boundary it's never crossed before

Every trace this project could add up through M6 would have stayed
inside one process — a `Worker`'s poll loop calling `dequeue` then
`complete` is one call stack. But the thing actually worth tracing is a
task's _whole_ lifecycle: `appendEvents` (one process, e.g. a workflow
worker deciding to schedule an activity) enqueues a task that a
_different_ process — possibly on a different machine — later dequeues
and executes. There's no shared memory, no shared call stack, nothing an
in-process tracer normally rides on to connect those two spans into one
trace.

The fix is the standard one for exactly this shape of problem — the same
pattern message queues and job schedulers use — but it has to be built by
hand here since there's no message-queue client library doing it for us:
a new `trace_context` column on `tasks` (nullable `TEXT`), populated at
`enqueue()` time by serializing the _currently active_ span's context
(W3C `traceparent` format, via OpenTelemetry's `propagation.inject`) into
that column, in the same statement as the rest of the row. When a worker
successfully `dequeue`s a task, it reads that column back and
`propagation.extract`s it, then starts its execution span as a child of
the original trace instead of a disconnected new one. The database _is_
the transport for trace context here, in exactly the same way it's
already the transport for the task itself — no new infrastructure, no
message headers, just one more column next to the ones already carrying
everything else a task needs to be picked up and run.

This makes a single trace span the full "append → enqueue → lease →
execute" chain the milestone's goal describes, across however many
processes actually handled it, exactly the shape that's been invisible
until now.

**Backend: Jaeger, not Grafana Tempo.** Both would work. Tempo would let
one Grafana pane show traces and metrics together, which is nicer to
look at, but it also means learning and operating Tempo's own storage
model (object-storage-backed blocks, its own query language nuances)
purely for a portfolio project's demo. Jaeger's all-in-one image runs as
one container, accepts OTLP directly, and has its own trace-search UI
out of the box — simpler to run, simpler to reason about, and the
tradeoff (a second UI instead of one unified one) costs nothing this
milestone actually needs. Metrics get their own pane (Grafana, reading
Prometheus) for the same reason: one tool per job, not one tool doing two
jobs adequately.

## Metrics: split ownership so nothing scrapes the same query N times

Two different kinds of metric live in this system, and they don't belong
on the same process for the same reason `docs/06-scheduler.md` didn't let
every scheduler replica run the reaper: some metrics are naturally
_per-process_ (this worker's dequeue count, this worker's task-wait-time
distribution), and some are naturally _global_ (how many tasks are
currently `pending`, `leased`, `dead`, total, right now, regardless of
which process is asking). Exposing the same global-state query from every
worker's `/metrics` endpoint would mean Prometheus's scrape interval
times however many workers are running, all hitting the same `SELECT
status, COUNT(*) FROM tasks GROUP BY status`, for a number that doesn't
change per-worker at all.

So: every `Worker` and the `Scheduler` process expose their own
`/metrics` (task counters — dequeued, completed, failed by outcome; a
task-wait-time histogram measured client-side as `now() - task.createdAt`
the moment `dequeue` hands a task back, which is the metric that
directly answers the `LISTEN/NOTIFY` question). Queue-depth gauges (the
global counts) are exposed **only by whichever replica currently holds
leadership** — the same single-writer guarantee M6 built for the reaper,
reused here for exactly the same reason: one owner, not N redundant
pollers of the same global state.

## The bench harness isn't k6, and that's a deliberate change from the stub

The M7 stub (written before any of this was investigated) called for
k6. k6's whole design center is HTTP/gRPC/WebSocket load generation —
its open-source build has no Postgres protocol support at all; getting
one requires building a custom `xk6-sql` binary via Go, a second
toolchain and build step this project has never needed and that doesn't
fit its "no exotic infrastructure per milestone" pattern (the same
instinct that kept M6's advisory lock as a plain SQL call instead of
reaching for a coordination service). And the thing this milestone
actually needs to load-test — Postgres task-queue throughput and
queueing latency — was never an HTTP surface to begin with; `startWorkflow`
and the worker poll loop talk to Postgres directly, not through
`packages/api`. Pointing k6 at `packages/api` would benchmark the wrong
thing: a convenience endpoint that exists for M5's demo, not the queue.

What actually gets built: `bench/` becomes a real workspace package with
a plain TypeScript harness (`tsx`, exactly like every other `bin/` script
in this repo), reusing the same shape M1's demo already proved — seed N
tasks, spawn K real worker processes, wait for the queue to drain — but
now timed and recorded instead of just asserted pass/fail. It runs twice
per invocation: once with workers configured without
`notifyConnectionString` (M1's original polling-only behavior) and once
with it set (M6's `LISTEN/NOTIFY` path), and prints a before/after table
of throughput and queueing-latency percentiles. That's the actual
question this milestone owes an answer to, measured with the tool this
project already uses everywhere else for orchestrating multi-process
demos, not a load-testing framework bolted on for a shape it wasn't built
for.

## What's still `TARGET (unmeasured)` after this milestone

Everything not actually run and recorded during this milestone's wrap-up
stays labeled that way. This design note doesn't predict throughput
numbers — the wrap-up section will report whatever the bench harness
actually measured, including if `LISTEN/NOTIFY` turns out to matter less
than expected. That would still be a real answer to the question M1
deferred, and a more honest one than a projected number substituting for
one that was actually run.

## Exit demo, restated precisely

`docker compose -f docker/docker-compose.yml --profile observability up`
brings up Prometheus, Grafana (pre-provisioned with a dashboard covering
queue depth, task-outcome rates, and task-wait-time percentiles), and
Jaeger. `pnpm demo:m7` runs the worker cluster with tracing/metrics wired
in, generates some real traffic, and prints where to look
(`localhost:3000` for Grafana, `localhost:16686` for Jaeger). Separately,
`pnpm bench` runs the polling-vs-notify throughput comparison and prints
a before/after table — the first genuinely measured performance numbers
in this repository.

## Implementation notes

**A real bug: `pg_notify` never actually fired, from the moment M6 wrote
it.** `enqueue()`'s original SQL wrapped the notification in its own
`WITH` clause — `WITH inserted AS (INSERT ... RETURNING *), notified AS
(SELECT pg_notify('tasks_available', queue) FROM inserted) SELECT * FROM
inserted` — reasoning, at the time, that bundling it into the same
statement as the insert would make delivery transactional. It does, but
only if the CTE actually runs, and it never did: Postgres only
_guarantees_ execution for **data-modifying** CTEs (`INSERT`/`UPDATE`/
`DELETE`) regardless of whether the outer query reads their output —
that guarantee doesn't extend to a plain `SELECT` CTE, even one calling a
volatile function like `pg_notify`, when nothing ever references it. The
planner is free to (and evidently did) treat it as dead code and skip it
entirely.

This went unnoticed through the entire M6 milestone: M6's own exit
criteria (leader election, reaper failover) never depends on
`LISTEN/NOTIFY` at all, and the `notifyWakeup.integration.test.ts` test
written back then only proved a notify-configured worker _could_ pick up
work quickly under a short backoff ceiling — it never actually pitted
notify against a _saturated_ backoff in the same run, so the missing
notification never showed up as a failure. It was caught here, in M7,
because this milestone's whole point is measuring the polling-vs-notify
difference head-to-head — and the first honest measurement came back
showing no difference at all, which was the tell. Confirmed with a
minimal repro (a bare `LISTEN`ing client counting notifications across 5
enqueues: zero received) before touching any code, then fixed by
splitting the notify into its own statement, issued on the same
client/session right after the insert (still transactional — same
session means Postgres still only delivers it once that session's
transaction actually commits), then reconfirmed with the same repro (5
enqueues, 5 notifications, ~10ms each). See `enqueue()` in
`packages/db/src/queue.ts` for the fixed version and the comment
recording this.

**The bench harness needed two more real fixes before it was measuring
anything meaningful, beyond the bug above:**

1. Its first version inserted latency-phase tasks with raw SQL directly
   against the `tasks` table instead of through `enqueue()` — which
   meant `notify: true` was _already_ a no-op for a second, independent
   reason (nothing called `pg_notify` at all in that path) before the
   bug above was even found. Fixed by routing every latency-phase
   insert through `enqueue()`, same as production code always does.
2. The first working version used a _fixed_ delay before every sample.
   Since `PollBackoff` is a deterministic function of elapsed idle time,
   a fixed delay makes every sample land at the exact same phase of the
   worker's repeating backoff cycle — 15 samples measuring one point,
   not a distribution. Fixed by randomizing each sample's wait across
   more than one full backoff cycle, so the phase at insertion time is
   effectively uniform across `[0, maxPollIntervalMs)` — a real spread
   instead of 15 copies of the same number. The latency phase also
   dropped from 4 workers to 1: with several independently-phased
   pollers, _someone's_ next poll is always due soon regardless of any
   single worker's backoff state, which would have kept diluting the
   exact signal this phase exists to isolate.

**Measured numbers**, `pnpm bench`, 2,000-task/4-worker throughput phase
and a 15-sample/1-worker queueing-latency phase (raw samples logged by
the harness, not just percentiles, given the small sample size):

```
Throughput (higher is better):
  polling only:     379.7 tasks/sec (5.27s for 2000 tasks)
  LISTEN/NOTIFY:    379.3 tasks/sec (5.27s for 2000 tasks)

Queueing latency, enqueue -> lease (lower is better):
  polling only:     p50=1052ms  p95=1907ms  p99=1907ms
  LISTEN/NOTIFY:    p50=12ms  p95=42ms  p99=42ms
```

Throughput is statistically identical either way — expected, and stated
plainly in the design note before this ever ran: every task in that
phase is already `pending` before any worker starts polling, so there's
nothing for a notification to shorten. Queueing latency is where
`LISTEN/NOTIFY` actually matters: **p50 drops from 1052ms to 12ms (~85x),
p95 from 1907ms to 42ms (~45x)** — consistent with what the mechanism
should do (skip the remainder of a backed-off poll wait, which averages
out to roughly half of `maxPollIntervalMs` under polling alone at 2000ms
here) once it's actually wired correctly. `docs/01-task-queue.md`
deferred this exact measurement to M7 rather than guess at it up front;
this is the answer.
