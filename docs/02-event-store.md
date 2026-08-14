# Design note: the event store + pure workflow state machine

Status: **implemented** (M2 complete). Originally written before the code
existed; the two "Implementation note" sections below were added during
M2's wrap-up, after two real composition bugs surfaced building the
reserve→charge→ship demo and its tests.

## The event/command distinction, precisely

An **event** is something that already happened: past tense, immutable,
appended to `workflow_events` and never touched again. A **command** is a
request a decision-maker is making — "schedule this activity," "complete
this workflow" — not yet real until it becomes an event.

M2 has no decision-maker. There is no code anywhere in this milestone that
looks at history and decides what should happen next in general; that
generic replay-and-decide engine is M3. What M2 has instead is a
hardcoded 3-step sequence living directly in the demo's activity handler
— when activity "reserve" completes, the handler itself (not a decision
engine) knows to schedule "charge" next. The event store doesn't care
either way: it stores whatever events it's given and reacts identically
regardless of whether a human, a hardcoded handler, or (in M3) a replaying
workflow function decided to produce them.

## Why the fold has to be pure and live in `packages/core`

The fold — `(state, event) => newState` — is the single place "what does
this history mean" is defined. Every future consumer of workflow state
needs to agree on the answer:

- M3's replay worker folds history to decide what a workflow has already
  done, so it doesn't re-run completed activities.
- M5's time-travel debugger folds history up to an arbitrary `seq` to
  show what the workflow looked like at that point.
- Tests fold a hand-built event list to assert behavior without touching
  a database at all.

If the fold could read the clock, hit the network, or depend on anything
beyond the events passed to it, these three callers could get three
different answers from the same history — which defeats the entire
purpose of storing history as the source of truth. Purity here isn't a
style preference, it's what makes "state is only ever derived from
events" a checkable claim instead of a hope. This is exactly why
`packages/core`'s ESLint IO-ban rule exists, and the fold is the first
real code to live there.

## Why `workflow_executions.status` doesn't contradict "derive from events"

`workflow_executions` has a `status` column. Writing to it looks, at
first glance, like exactly the kind of mutable-state-instead-of-events
approach this project exists to avoid. The reason it's fine:

1. It is **never** written independently of the event log — every write
   to it happens inside the same transaction as the `appendEvents` call
   that justifies it.
2. It is **never** hand-derived — the value written is always the literal
   output of `foldEvents(getEvents(workflowId)).status`, the same pure
   function every other consumer uses. There is no second, divergent
   definition of "what status is this workflow in."
3. Its only job is to make `SELECT * FROM workflow_executions WHERE
status = 'RUNNING'` a normal indexed query. Without it, answering "which
   workflows are still running" would mean folding every workflow's
   entire history on every such query — correct, but needlessly
   expensive for something the log already implies.

It's a cache, not a second source of truth — and it's provably
consistent with the log because it's computed _from_ the log, in the same
transaction, every time.

## Why append-and-enqueue must be one transaction

This is the same "one loop" argument as the M1 design note, applied one
level up: _something appends events to the log → that atomically enqueues
a task_. If appending an `ActivityScheduled` event and enqueueing its
`activity` task were two separate transactions, a crash between them
would leave a workflow with a scheduled activity in its history that no
task exists to ever execute — a permanently stuck workflow, silently. The
event and the task it causes have to become durable together or not at
all, which is mechanically why `workflow_events` and `tasks` living in
the same Postgres database (an M1 decision) pays off here too.

## Scope: M2 enqueues `workflow` tasks that nothing consumes yet

Every `appendEvents` call also tries to enqueue a `workflow`-type task
(swallowing the conflict per M1's partial-unique-index invariant when one
is already pending/leased). This is deliberate, not premature: it proves
the M1 queue machinery and the M2 event store compose without needing a
redesign later, and it means M3 can add the replay worker without
touching this code at all. But nothing in M2 ever dequeues a `workflow`
task — they will sit `pending` in the table for the lifetime of this
milestone. **This is expected.** A future reader diffing the `tasks`
table and seeing uncollected `workflow` rows after running the M2 demo
is not looking at a bug.

## What "driven directly, not through worker replay" means concretely

The demo's activity handler is a real M1 `Worker` (reused verbatim, not
reimplemented) processing real `activity`-type tasks off the real queue.
What's _not_ real yet is the decision logic: the handler doesn't replay
history to figure out what activity it's handling or what to do next —
it looks up the `ActivityScheduled` event via the task's
`scheduled_event_seq`, and the "what comes next" logic is a hardcoded
`switch` on activity name. M3 replaces that hardcoded switch with actual
replay of workflow _code_ (an async function), but the event store,
the fold, and the append/enqueue atomicity this note describes don't
change at all when that happens — that's the point of building this
layer first.

## Implementation note: composing M1's `enqueue` inside a transaction

`appendEvents` is M2's first caller of `enqueue` (from M1) that runs it
_inside_ a larger, explicit, multi-statement transaction rather than as
a single standalone call. That composition exposed a bug in `enqueue`
that M1's own tests never could have caught, because M1 never called it
that way: Postgres marks an **entire transaction** aborted after any
statement errors — including a unique-violation the application code
goes on to catch and handle. Catching the JS exception doesn't undo that
server-side state. So the second `enqueue` call inside a given
`appendEvents` invocation — the one enqueueing the `workflow` task, which
is _expected_ to conflict once one is already pending — was silently
poisoning every subsequent statement in the transaction (including
`appendEvents`'s own closing `getEvents`/`UPDATE`), surfacing as an
opaque `25P02: current transaction is aborted` several statements later,
nowhere near the actual cause.

Fixed in `enqueue` by wrapping its insert in a `SAVEPOINT` whenever it's
called with a `PoolClient` (i.e., potentially inside a caller's
transaction) — `ROLLBACK TO SAVEPOINT` on the expected conflict undoes
just that one statement, leaving the rest of the transaction usable. A
bare `Pool` still skips this entirely, since each of its calls is already
its own isolated implicit transaction with nothing else to protect.

The general lesson: a function designed to "swallow an expected error and
return null" is only safe to compose inside a larger transaction if it
actually contains the failure to itself at the database level, not just
at the application level. Worth remembering for M3+, where more functions
will start composing inside `appendEvents`-style transactions.

## Implementation note: a worker needs to filter by task type

The first version of the reserve→charge→ship demo's `Worker` picked up
_every_ pending task in its queue, `activity` and `workflow` alike — M1
never needed to filter because its dummy handler didn't care what a task
"meant." M2 introduced real `workflow`-type tasks that nothing consumes
yet (deliberately — see "Scope" above), and the worker duly dequeued one,
handed it to the activity handler, which had no idea what to do with a
task carrying no `scheduled_event_seq` and failed it.

Fixed by adding an optional `taskType` filter to `dequeue` (M1's code)
and threading it through `Worker`'s config. Omitted, it preserves M1's
original "dequeue anything" behavior; the M2 example worker now passes
`taskType: 'activity'` explicitly. This is exactly the kind of thing M3
will need to get right for real: a replay worker dequeuing `workflow`
tasks and an activity worker dequeuing `activity` tasks are two different
consumers of the same queue, and now there's a documented, tested way to
keep them apart.
