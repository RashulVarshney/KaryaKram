# KaryaKram

A from-scratch durable workflow execution engine — a reimplementation of
core Temporal/Cadence concepts on plain Postgres. Users define multi-step
workflows as ordinary async TypeScript functions; the engine guarantees
each workflow runs to completion, surviving worker crashes, process
restarts, and deploys, without re-executing already-completed side
effects.

This is a portfolio project built in public milestones. See
[`docs/plans/`](./docs/plans/) for the full roadmap and per-milestone
plans, and [`docs/`](./docs/) for design notes written before each
milestone's code.

## The honest guarantee

This system never claims **"exactly once."** What it actually provides:

- **At-least-once activity execution** — a side-effecting step (e.g. "call
  Stripe") may run more than once under crash/retry, but never
  concurrently for the same task.
- **Exactly-once workflow completion semantics** — a workflow's decision
  logic (replay) is deterministic and idempotent, so the _workflow itself_
  reaches one final outcome even if individual steps are retried.
- **Idempotency keys push activities toward effective-once-ness at the
  edge** — the system gives you the tools (leases, retries, idempotency
  keys) to make side effects safe under retry; it does not pretend the
  distributed-systems problem goes away.

No performance numbers are claimed anywhere in this repo until they've
been measured (milestone M7). Anything stated before then is labeled
`TARGET (unmeasured)`.

## Running it

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
pnpm install
pnpm db:migrate
pnpm test
```

## M1 proof: a Postgres task queue with zero double-execution

`pnpm demo:m1` seeds 10,000 tasks, spawns 8 real worker processes,
`kill -9`'s two of them mid-run, and waits for the survivors to finish
the job using nothing but lease expiry + a reaper — no coordinator, no
external queue. Design reasoning (why `FOR UPDATE SKIP LOCKED`, why
leases over delete-on-dequeue, the honest at-least-once boundary) is in
[`docs/01-task-queue.md`](./docs/01-task-queue.md).

```
== KaryaKram M1 demo ==

1. Resetting DB...
2. Seeding 10000 tasks...
3. Spawning 8 workers + 1 reaper...
4. Killing 2 workers with SIGKILL mid-run...
   killing worker-0 (pid 94879)
   killing worker-1 (pid 94880)
5. Waiting for the survivors to drain the queue...
6. Shutting down survivors + reaper...

== Summary ==
Total tasks seeded:        10000
Total results recorded:    10000
Distinct tasks completed:  10000
Duplicate result rows:     0 (must be 0 — a unique constraint on task_id would have thrown otherwise)
Tasks reclaimed & retried: 50 (attempt > 1 — expected, from the 2 killed workers)

Per-worker completions:
  worker-2: 1661
  worker-3: 1675
  worker-4: 1657
  worker-5: 1650
  worker-6: 1675
  worker-7: 1682

Final task status breakdown:
  completed: 10000

PASS: 10000 tasks, zero double-execution, survived 2 killed workers.
```

The 50 reclaimed tasks are exact, not approximate: 2 killed workers ×
25 in-flight tasks each (`maxConcurrency`) = exactly what each had leased
and not yet completed at the moment of the kill.

## M2 proof: workflow state derived purely from events

M2 proved that workflow state can always be reconstructed purely by
folding `workflow_events` from `seq` 1 — never stored or mutated
directly — using a hardcoded reserve → charge → ship sequence (no
decision engine existed yet). Design reasoning (why the fold has to be
pure, why `workflow_executions.status` is a cache and not a second source
of truth, why append-and-enqueue is one transaction) is in
[`docs/02-event-store.md`](./docs/02-event-store.md).

**Superseded by M3**: the hardcoded sequence this milestone's demo relied
on no longer exists in the codebase — M3 replaced it with real workflow
code and a genuine replay engine (same event store and fold underneath,
unchanged). `pnpm demo:m2` isn't runnable anymore for that reason; M3's
demo below proves the same event-sourcing guarantee and more.

## M3 proof: deterministic replay survives a mid-workflow crash

Workflows are authored as ordinary `async function`s
(`defineWorkflow`/`defineActivity`). `pnpm demo:m3` starts a reserve →
charge → ship workflow, `kill -9`'s the worker process right after
`reserve` completes and before `charge` starts, starts a completely fresh
process, and proves the workflow still reaches `COMPLETED` — with
`reserve`'s activity function _provably_ executed exactly once (via an
independent execution counter, not just event-log shape). Design
reasoning (why replay means re-running the function from scratch every
time, how `scheduleActivity` makes that deterministic, why microtask
draining is a legitimate purity boundary and not a loophole, why
`NonDeterminismError` is a distinct outcome from a workflow failure) is
in [`docs/03-replay.md`](./docs/03-replay.md).

```
== KaryaKram M3 demo ==

1. Resetting DB...
2. Starting workflow (reserve -> charge -> ship)...
   workflowId = 06cd38f6-9414-4ddb-86f9-b8688dac8aae
3. Starting the reaper and worker process #1...
4. Waiting for 'reserve' to complete...
5. Killing worker process #1 (pid 172453) with SIGKILL...
6. Starting a fresh worker process #2...
7. Waiting for the workflow to complete via the fresh worker...

8. Event log (workflow_events, seq order):
   1. WorkflowStarted
   2. ActivityScheduled (reserve)
   3. ActivityCompleted
   4. ActivityScheduled (charge)
   5. ActivityCompleted
   6. ActivityScheduled (ship)
   7. ActivityCompleted
   8. WorkflowCompleted

9. Activity execution counts (proves reserve never re-ran):
   reserve: 1
   charge:  1
   ship:    1

PASS: workflow completed after a mid-workflow kill -9, 'reserve' executed exactly once despite the crash.
```

## M4 proof: a durable timer survives a full cluster restart

Six sub-features: real exponential+jitter backoff, a queryable/actionable
DLQ, durable timers (`ctx.sleep`), idempotency keys, signals
(`ctx.waitForSignal` / `sendSignal`), and hard cancellation
(`cancelWorkflow`). `pnpm demo:m4` starts a workflow with a short durable
timer, `kill -9`'s **every** worker and the reaper mid-wait (a full
cluster restart, not just one process), starts everything fresh, and
proves the timer still fires and the workflow still completes — with
neither activity's function body having run twice. Design reasoning (why
a durable timer is just a task with a future `run_after`, why signals
never need a command, why cancellation here is hard/engine-level and not
cooperative, why idempotency is two smaller honest mechanisms rather than
a framework) is in [`docs/04-durability.md`](./docs/04-durability.md).

```
== KaryaKram M4 demo ==

1. Resetting DB...
2. Starting workflow (activity -> 3s durable timer -> activity)...
   workflowId = 05317a07-c3d9-4995-858a-f07b4d6f77f3
3. Starting the cluster (reaper + app: activity/workflow/timer workers)...
4. Waiting for the first activity to complete...
5. Killing the ENTIRE cluster with SIGKILL (every worker + the reaper)...
6. Starting a completely fresh cluster...
7. Waiting for the durable timer to fire and the workflow to complete...

8. Event log (workflow_events, seq order):
   1. WorkflowStarted
   2. ActivityScheduled (before-timer)
   3. ActivityCompleted
   4. TimerScheduled
   5. TimerFired
   6. ActivityScheduled (after-timer)
   7. ActivityCompleted
   8. WorkflowCompleted

9. Activity execution counts (proves neither ran twice):
   before-timer: 1
   after-timer:  1

PASS: durable timer fired and workflow completed after a full cluster restart.
```

The 3-second timer stands in for "5 minutes" — see the design note for
why using a real 5-minute wait wouldn't make the demo any more
convincing, just slower to run.

## M5 proof: a browser-side time-travel debugger

The first HTTP surface (`packages/api`, Fastify) and the first React
frontend (`packages/web`, Vite). `pnpm demo:m5` starts a worker cluster,
the API, and the Vite dev server; opening the UI lists workflows, and
picking one loads its full event history once, then a scrubber
re-derives the workflow's state at any point purely by re-running
`foldEvents` — the exact same, unmodified function from M2 — client-side,
in the browser, with zero network requests per scrub. New events append
live via a polling SSE endpoint. Design reasoning (why the scrubber runs
in the browser rather than the server, why live updates are polling-based
SSE rather than `LISTEN/NOTIFY`, why the DAG view is honest about only
having ever rendered sequential chains) is in
[`docs/05-control-plane.md`](./docs/05-control-plane.md).

**Found by actually opening it in a browser**: the first real load was a
blank page — `@karyakram/core` compiles to CommonJS, and Vite doesn't
run its usual CJS→ESM pre-bundling step for pnpm workspace symlinks (it
assumes linked packages are source you're editing, not a dependency to
bundle), so the browser choked trying to load the compiled `dist/index.js`
as native ESM. Fixed with `optimizeDeps: { include: ['@karyakram/core'] }`
in `vite.config.ts`. This is exactly the gap that build success, `tsc
--noEmit`, and even a working `curl` round-trip through the API can't
catch — see the design note's "Implementation notes" for the full account.

```
$ curl -s http://localhost:3001/workflows | python3 -m json.tool
{
    "workflows": [
        {
            "id": "49c4a48b-2738-4a13-a364-59470aaff733",
            "workflowType": "reserve-charge-ship",
            "status": "COMPLETED",
            "createdAt": "2026-08-15T01:12:01.227Z",
            "updatedAt": "2026-08-15T01:12:06.831Z"
        }
    ]
}
```

## Status

M0 through M5 complete. See
[`docs/plans/README.md`](./docs/plans/README.md) for the full milestone
index.
