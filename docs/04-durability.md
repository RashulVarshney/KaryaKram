# Design note: durability — timers, signals, cancellation, idempotency, DLQ, backoff

Status: **implemented** (M4 complete). The "Implementation note" near the
end was added during wrap-up, after a flaky test exposed a race in the
test's own design (not in the cancellation mechanism itself).

## A durable timer is a task with a future `run_after` — nothing new

M1's dequeue query has always filtered on `run_after <= now()`. A
"durable timer" sounds like it needs new infrastructure — some kind of
scheduler that wakes up at the right moment — but it doesn't: it's just a
task row whose `run_after` is set far in the future. It becomes eligible
to dequeue the instant that time passes, using the exact same mechanism
that already makes `fail()`'s retry backoff work. No new queue primitive,
no new column. The only new thing is a third task type,
`'timer'` — which needs no migration, because `tasks.task_type` was
always a bare `TEXT NOT NULL`, never constrained to an enum of two
values. A timer "handler" is almost embarrassingly simple: it
unconditionally appends `TimerFired` the moment it's dequeued, because
being dequeued at all already proves `fireAt` has passed.

This is the payoff of M1's design holding up under a use case it wasn't
explicitly built for — the queue doesn't know or care whether a task
represents "do real work" or "wait until a clock reads a certain value";
both are just rows with a `run_after`.

## Timers replay the same way activities do, in a parallel lane

M3 established the mechanism: a `scheduleActivity` call's position in
call order (not any explicit ID) is matched against the Nth
`ActivityScheduled` event in history. `ctx.sleep()` reuses this exact
idea, with its own independent counter and its own filtered view of
history (`TimerScheduled` events only). A workflow that interleaves
`sleep()` and `scheduleActivity()` calls—

```ts
await ctx.scheduleActivity('reserve', input);
await ctx.sleep(5 * 60_000);
await ctx.scheduleActivity('charge', reserved);
```

—produces `ActivityScheduled, TimerScheduled, ActivityScheduled` in
history. Replay matches the first and third against
`scheduledEvents[0]` and `scheduledEvents[1]` (the activity-only view,
counter 0 then 1) and the timer against `timerEvents[0]` (the timer-only
view, its own counter starting fresh at 0). Each type's relative order is
preserved within its own lane regardless of what sits between calls of a
different type in the interleaved history. No cross-type coordination is
needed because each lane's counter only ever advances on calls of that
same type.

## Signals don't need a command, because there's nothing to schedule

M3's `scheduleActivity` has four cases on a given call: resolve from a
completion, reject from a failure, hang on an in-flight schedule, or
**emit a command and hang** on a brand-new one. Signals only have three
of these. A signal isn't something the _workflow_ is asking the engine to
go create — it's pushed in from outside, independently, whenever an
external caller decides to send one. So `ctx.waitForSignal(name)` never
has a "genuinely new decision" case: it either finds the Nth
`SignalReceived` event with that name already in history and resolves
with its payload, or it doesn't yet, and hangs — with nothing to record
as a command, because there's nothing the engine needs to go do. The
external `sendSignal()` call is what actually creates the event, via the
same `appendEvents` that everything else in this system durably
originates from.

## Cancellation here is hard (engine-level), not cooperative — a stated cut

There are two honest ways to build cancellation. **Cooperative**:
`scheduleActivity`/`sleep` start rejecting once a cancellation has been
requested, and workflow code gets to `catch` that and run its own
cleanup (release a lock, send a compensating action) before actually
ending. **Hard**: the engine just ends the workflow, unilaterally, the
moment it sees a cancellation request — no chance for the workflow's own
code to react.

M4 builds only the hard version: `createWorkflowReplayHandler` checks
history for a `CancellationRequested` event before it ever calls
`replay()`, and if one exists (and the workflow isn't already terminal),
appends `WorkflowCanceled` directly — `replay()` and the workflow
function's own code never run at all for that decision. This is a real,
useful feature (a cancel request durably ends the workflow, survives
crashes, is properly event-sourced — not a `kill -9`), but it is
explicitly _not_ the more sophisticated cooperative version. Building
cooperative cancellation correctly — deciding what a rejected
`scheduleActivity` looks like mid-flight, whether in-flight activities
get told to stop, what "cleanup, then still end" means for state — is a
real feature in its own right, scoped out here the same way M3 scoped out
non-determinism recovery tooling.

## Idempotency: two smaller, honest things, not a framework

"Idempotency" here is not one mechanism, it's two:

1. **An internal guard.** Before running an activity function, the
   handler checks whether history already has a completion or failure
   recorded for this `scheduledEventSeq`. If so, it skips execution
   entirely. M1's per-task lease exclusivity already makes concurrent
   double-execution structurally rare, but "rare" isn't "impossible" —
   this is a second, independent line of defense specifically against a
   redelivered task re-running an activity whose result is already
   durable.
2. **A stable, exposed key.** `${workflowId}:${scheduledEventSeq}` is
   deterministic and unique per activity invocation slot — passed into
   the activity function so a _real_ integration (a real Stripe call, not
   this project's fake ones) can hand it to Stripe's own idempotency-key
   parameter, pushing the guarantee out to the edge where the actual
   external system can enforce true dedup.

Neither of these makes the system "exactly once" — restated plainly, the
same as the README's honest guarantee: at-least-once activity execution
is still the baseline; these two mechanisms push what "at-least-once"
costs you further toward "effective-once," they don't remove the boundary.

## Backoff + jitter: full jitter, and why

M1 shipped a fixed 30-second retry delay with an explicit `TODO(M4)`.
Plain exponential backoff (`base * 2^attempt`) has a real failure mode:
if many tasks fail at once (a shared dependency outage), they all retry
on the _same_ schedule, hammering the recovering system in synchronized
waves. **Full jitter** — `random() * min(maxDelay, base * 2^attempt)` —
spreads retries across the entire window instead of clustering them,
which is the standard fix (this is the same algorithm AWS's architecture
blog popularized for exactly this reason). The calculation takes an
injectable `random` function (defaulting to `Math.random`) purely so it's
unit-testable without asserting on actual random output — pass a fake
that returns fixed values and assert the formula, not the randomness.

## DLQ: surfaced, not moved

There's no separate dead-letter table or queue in this system — "DLQ" is
just `tasks` rows with `status = 'dead'`, which M1 already produces.
"Surfacing" the DLQ in M4 means exactly two functions:
`listDeadTasks` (so they're queryable instead of only visible via a raw
SQL query) and `requeueDeadTask` (so a human — standing in, in this
milestone's demo, for a real operator — can put one back to `pending`
after fixing whatever caused it to exhaust its retries). No UI (that's
M5), no automatic recovery policy (out of scope entirely — an
automatically-requeued task that fails the exact same way every time is
just a slower way to loop forever).

## Implementation note: testing cancellation against a live worker is its own race

The first version of the cancellation integration test started a real,
continuously-polling workflow `Worker`, waited (by polling the event log)
for `step1` to complete, then called `cancelWorkflow`. It failed
intermittently: `step2` sometimes got scheduled anyway.

This isn't a bug in the short-circuit check — it's a race in the test's
own design. The instant `step1`'s `ActivityCompleted` event lands, a new
`workflow` task is enqueued (M2's mechanism, unchanged), and the _same
already-running_ worker can dequeue and process it — deciding to schedule
`step2` — before this test's own `cancelWorkflow` call finishes its round
trip to Postgres. Both the test and the worker are independently polling
the same database; nothing orders one before the other.

Fixed by not using a live polling worker for this test at all: drive the
workflow-replay handler and the activity handler directly, one call at a
time, so the sequence is: schedule `step1` → run `step1` for real → call
`cancelWorkflow` → _then_ invoke the workflow handler again — with
nothing else touching the database in between. This is fully
deterministic (5/5 stable, and faster, immediately) rather than
best-effort. Contrast with M3's crash-recovery test, which _embraces_ a
similar race deliberately (kill timing relative to a live worker) because
proving resilience _through_ real concurrent processes was the actual
point there; here, the timing was incidental to what the test was trying
to prove, so removing it was the right fix rather than papering over the
race with retries or wider timeouts.
