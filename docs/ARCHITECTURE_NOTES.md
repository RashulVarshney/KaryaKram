# Architecture notes (baseline, before `feat/llm-steps`)

How the engine works today, as read from the code — not from the design docs.

**Events are the source of truth.** `workflow_events(workflow_id, seq, event_type, payload jsonb)`
is append-only, `PRIMARY KEY (workflow_id, seq)`. `foldEvents` (`packages/core/src/workflow.ts`)
is a pure reducer over `StoredWorkflowEvent[]`; `workflow_executions.status` is just a cache of
that fold. `packages/core` has no IO/clock/randomness (ESLint-enforced) and is also bundled into
the browser debugger, so it can't import `node:crypto`.

**Replay is the only way workflow code runs.** `replay(fn, input, history)` (`core/replay.ts`)
re-executes the workflow function from the top against history. `ctx.scheduleActivity` is matched
to the Nth `ActivityScheduled` event _by call position_ (no ids): completed -> resolve with the
recorded result, failed -> reject, scheduled-but-open -> never resolves, absent -> emit a
`ScheduleActivity` **command** and hang. Commands are not events: the impure
`workflowReplayHandler` turns them into events and calls `appendEvents`. A type mismatch at a
position throws `NonDeterminismError`, which propagates out of the handler (task retry/DLQ), it
does **not** write `WorkflowFailed`.

**`appendEvents` is the atomic unit** (`db/eventStore.ts`): inside one transaction it
`SELECT ... FOR UPDATE`s the `workflow_executions` row, inserts events with `seq = MAX+1`,
enqueues the implied tasks (`ActivityScheduled` -> `activity` task with
`scheduled_event_seq`; `TimerScheduled` -> `timer` task with future `run_after`; always a
`workflow` task, deduped by the partial unique index `one_workflow_task_per_wf`), and refreshes
the status cache. W3C trace context is stored on each task row.

**Leasing.** `tasks` rows: `pending -> leased -> completed | dead`. `dequeue` is a
`FOR UPDATE SKIP LOCKED` CTE that sets `leased_by`, `lease_expires_at`, `attempt = attempt + 1`.
`Worker` heartbeats every in-flight task (`UPDATE ... WHERE leased_by = me`) every
`heartbeatIntervalMs`; `complete`/`fail` are guarded by `leased_by` so a worker that lost its
lease cannot finish the task. `fail` re-queues with full-jitter exponential backoff, and marks
the task `dead` (the DLQ is just `status='dead'`) once `attempt >= max_attempts`. The `Reaper`
(run by the advisory-lock leader) puts expired leases back to `pending`. Delivery to a handler is
**at-least-once**; handlers must be idempotent (`activityHandler` checks for an existing outcome
event first, and passes `workflowId:seq` as an idempotency key).

**Task types** are a bare `TEXT` column (`workflow | activity | timer`); workers filter by
`taskType`. **Observability:** `Worker.dispatch` wraps each handler in an OTel span whose parent is
the `traceparent` stored on the task. **UI:** `WorkflowDetail` folds `events.slice(0, n)` in the
browser (`foldEvents`), `DagView` renders one node per `ActivityScheduled`/`TimerScheduled`.

**Test baseline (this branch's starting point):** unit 7 files / 43 tests, integration
19 files / 39 tests, all green (`docs/results/baseline-tests.txt`).
