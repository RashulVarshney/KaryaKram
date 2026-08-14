# Design note: deterministic replay

Status: **implemented** (M3 complete). The "Implementation note" at the
end was added during wrap-up, after a real bug surfaced testing the
crash-recovery demo's stability across repeated runs.

## The actual problem

A workflow is authored as an ordinary `async function`. Somewhere in the
middle of running it, the process might get `kill -9`'d — mid-`await`,
with the JS call stack simply gone. There is no way to serialize a
suspended JS call stack and resume it in a different process; V8 doesn't
expose that, and even if it did, "resume this exact stack on any worker"
would be a very different, much heavier system than what this project is
building.

So "resuming a workflow" cannot mean literally continuing a paused
function. It has to mean: **run the function again, from the very
beginning**, in a way that reaches exactly the same point it reached
before, without redoing any of the real work that already happened. The
event log is the only thing that survives a crash, so the function has to
be steered entirely by what's in the log.

## How `scheduleActivity` makes that deterministic

The workflow function's only way to "do something" is
`ctx.scheduleActivity(activityType, input)`. Each call is assigned an
index purely by call order — the first call made during this replay pass
is index 0, the second is index 1, and so on, regardless of what
activity type or input it uses. That index is matched against the _Nth_
`ActivityScheduled` event in the workflow's history, in order.

Four things can happen on a given call:

1. **History has a completion for this call.** Resolve the returned
   Promise immediately with the historical result. No real activity runs.
2. **History has a failure for this call.** Reject immediately with the
   historical error. Ordinary `try`/`catch` in the workflow function
   handles it exactly like a real failure would, because as far as the
   function can tell, it is one — it just already happened.
3. **History has this call scheduled but not yet resolved.** Return a
   Promise that never resolves during this pass. Nothing new needs to
   happen; the activity is already in flight, being worked on by the
   activity queue independently.
4. **History has nothing at this call index at all.** This is a genuinely
   new decision. Emit a `ScheduleActivity` command and return a Promise
   that never resolves this pass — the function's execution simply stops
   here, because there's nothing further it _can_ do until this new
   activity's result exists.

Case 4 is why a fresh replay pass, given a longer history than before,
naturally re-derives every earlier decision (via cases 1–3, all of which
resolve instantly) and stops at exactly the first point that's still
undecided. That's the entire mechanism — no snapshotting, no serialized
stack, just "run the deterministic function again and let history do the
steering."

## Why microtask-draining doesn't break the purity rule

`replay()` lives in `packages/core`, which is not allowed to touch IO,
the clock, or randomness. Draining pending microtasks with `await
Promise.resolve()` might look like it's using "the runtime" in a way
that violates that, so it's worth being precise about why it doesn't.

Promise resolution order in JavaScript is defined by the ECMAScript
specification, not by the OS, wall-clock time, or anything
environment-specific — the exact same sequence of microtask ticks happens
every time `replay()` runs with the same workflow function and the same
history, on any machine, any number of times. There is no hidden input:
`await Promise.resolve()` doesn't read a value, it just yields a turn to
already-queued continuations. That's what makes it fair game for a "pure"
function in this project's sense — the definition that matters here is
_"same inputs always produce the same outputs,"_ not _"the function body
contains no `await`."_ `Date.now()` and `Math.random()` are banned
because they make that guarantee false; `await Promise.resolve()` doesn't.

The draining loop is bounded (a fixed, generous number of ticks — see the
implementation for the exact figure) rather than run until some
"nothing's changing" condition is detected. Once a workflow function
hits case 4 above, it is _provably_ stuck for the rest of this replay
pass — nothing will ever resolve the Promise it's awaiting, so additional
ticks beyond that point are inert. The bound only needs to be large
enough to fully unwind however many already-resolved steps preceded the
new decision, which is proportional to history length; a fixed generous
constant is simpler to reason about than a dynamic fixed-point check and
costs nothing extra in practice (extra ticks past the stopping point are
cheap no-ops).

## What a command is, concretely

A command is the literal implementation of the root spec's definition:
_"something the workflow code is asking for, not yet real."_
`replay()` returns zero or more of:

- `ScheduleActivity { activityType, input }`
- `CompleteWorkflow { result }`
- `FailWorkflow { error }`

`replay()` itself never touches Postgres. The worker (impure,
`packages/worker-sdk`) is the thing that turns a command into an
`appendEvents` call — the same append→enqueue atomicity M1 and M2 already
established, unchanged. This is the payoff of building the event store
and its atomicity guarantees before building replay: nothing about how
events get appended durably had to change to support this milestone.

## `NonDeterminismError` is not a workflow failure

If history says call index 2 scheduled `"charge"`, but the currently
running code's call index 2 asks for `"ship"` instead, the deployed code
has diverged from this workflow's own history — most likely because the
workflow function's code changed (a branch was added/removed, calls were
reordered) in a way that's incompatible with workflows that are already
partway through the old version. This is fundamentally different from a
business-logic failure like "the card was declined": it's an operational
problem with the _deployment_, not an outcome the workflow's own error
handling should ever see or reason about.

`replay()` therefore does not fold this into `status: 'FAILED'` — it
propagates `NonDeterminismError` distinctly, out of `replay()` itself, so
the caller can tell "this workflow's business logic failed" apart from
"this workflow's code is no longer compatible with its own history."

**Scope, stated explicitly**: M3's worker responds to a
`NonDeterminismError` by logging loudly and letting the task fail via
M1's existing retry mechanics — which will dead-letter it after
`max_attempts`, since retrying doesn't fix a structural code mismatch.
That's a real limitation, not an oversight: freezing a workflow for
operator inspection, versioning workflow code so old and new versions can
coexist, or any kind of migration tooling is out of scope here and stays
out of scope for the whole project as currently planned.

## Why activities became a registry instead of a hardcoded switch

M2's demo hardcoded "reserve → charge → ship" directly in the activity
handler, because M2 had no decision engine — something had to decide
what came next, and a hardcoded switch was the honest placeholder for
that gap. M3 replaces the decision-making with real workflow code via
`scheduleActivity`, so the activity-execution side generalizes for free:
a worker processing `activity`-type tasks now looks up which function to
run by `activityType` from a registry (`defineActivity`), the same way
the workflow side looks up which function to replay by `workflowType`
(`defineWorkflow`). Neither handler is tied to one specific workflow
anymore — this is the actual point at which `packages/worker-sdk` becomes
something an application is written _against_, rather than a demo-specific
script.

## Implementation note: crash recovery for _workflow_ tasks needs the reaper too

The first version of the M3 demo and its crash-recovery test ran an
activity worker and a workflow-replay worker, `kill -9`'d one of them,
and started a fresh pair — but ran no reaper. It passed the first few
times, then hung completely on a later run: the workflow never got past
`reserve`, stuck at 3 events forever.

The cause: completing an activity immediately enqueues a new `workflow`
task (this is exactly the mechanism M2 built — "something appends events
→ that atomically enqueues a task"). In the demo/test's single process
running both worker types, that new `workflow` task can get leased and
started _immediately_, on the very same process about to be killed. If
the kill lands in that narrow window — after `reserve`'s completion is
durable, but while the _workflow_ task deciding to schedule `charge` is
itself leased-but-incomplete — that lease has nothing to reclaim it
without a reaper running. A fresh worker only ever dequeues `pending`
tasks; a `leased` task whose lease never gets reclaimed is invisible to
it forever, not just until the original TTL passes.

This isn't specific to replay — it's the exact scenario M1's reaper was
built for, on a task M3 introduces (`workflow`-type) that M1's own tests
never happened to lease-and-crash on mid-flight. Fixed by running a
reaper alongside both the demo and the crash-recovery test, with a short
lease TTL and fast reaper interval so recovery stays well within test
timeouts. Confirmed stable across repeated runs afterward (5/5 clean
passes, both for the automated test and the demo) — before the fix, it
was closer to 1-in-4 hanging. Worth remembering for M4 and beyond: any
process that runs a worker consuming `workflow`-type tasks needs a reaper
in its deployment topology, not just activity-consuming workers.
