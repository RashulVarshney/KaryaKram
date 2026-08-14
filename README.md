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

`pnpm demo:m2` runs a 3-activity workflow (reserve → charge → ship) to
completion through a real M1 `Worker`, then reconstructs its final state
by folding `workflow_events` from `seq` 1 — the state was never read from
anywhere else. Design reasoning (why the fold has to be pure, why
`workflow_executions.status` is a cache and not a second source of truth,
why append-and-enqueue is one transaction) is in
[`docs/02-event-store.md`](./docs/02-event-store.md).

```
== KaryaKram M2 demo ==

1. Resetting DB...
2. Starting workflow (reserve -> charge -> ship)...
   workflowId = 47bb7230-7a1e-46ae-a603-a1122701b6d5
3. Running a worker until the workflow completes...

4. Event log (workflow_events, seq order):
   1. WorkflowStarted
   2. ActivityScheduled (reserve)
   3. ActivityCompleted
   4. ActivityScheduled (charge)
   5. ActivityCompleted
   6. ActivityScheduled (ship)
   7. ActivityCompleted
   8. WorkflowCompleted

5. State reconstructed purely by folding the log above:
   status: COMPLETED
   activity[2] reserve: COMPLETED
   activity[4] charge: COMPLETED
   activity[6] ship: COMPLETED

PASS: workflow completed end to end, state derived purely from events.
```

## Status

M0, M1, and M2 complete. See
[`docs/plans/README.md`](./docs/plans/README.md) for the full milestone
index.
