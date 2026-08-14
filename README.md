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

## Status

Currently on **M0 — Foundation**. See
[`docs/plans/README.md`](./docs/plans/README.md) for the full milestone
index.
