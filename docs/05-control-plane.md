# Design note: the control plane — DAG, live updates, time travel

Status: **implemented** (M5 complete). The "Implementation notes" section
near the end was added during wrap-up.

## The scrubber is a browser calling `foldEvents`, not a server endpoint

Every previous milestone folded events on the server, inside a worker
process, because that's where the decision-making needed to happen.
Time travel doesn't need a decision — it needs a _display_. The
`WorkflowState` at `seq` N is simply `foldEvents(events.slice(0, N))`,
and `foldEvents` has been pure — no IO, no clock, no randomness — since
M2. Purity means it doesn't matter _where_ it runs: the same function,
same source file, same `@karyakram/core` package, imported into a Vite
bundle and executed in a browser tab produces byte-identical output to
running it in a Node worker process.

The practical shape this gives the control plane: the API ships the raw
event array for a workflow **once**. Every subsequent scrub position —
dragging through hundreds of possible values as fast as the user's mouse
moves — is a synchronous, client-side array slice plus a pure reduce.
Zero network requests per scrub frame, zero server load from scrubbing,
and the debugger works identically whether the workflow has 3 events or
3,000. This is the concrete return on having enforced `packages/core`'s
IO ban since the very first milestone that touched it.

## Live updates: polling-based SSE, deliberately not `LISTEN/NOTIFY`

`docs/01-task-queue.md` already staked out the project's position on
`LISTEN/NOTIFY`: deferred to M6, with polling as the permanent backstop
regardless of what M6 adds, because `LISTEN/NOTIFY` has at-most-once
delivery and needs a dedicated connection per listener. M5's SSE endpoint
follows that same position instead of quietly reversing it under a
different name: it polls `workflow_events` for rows with `seq` greater
than the client's watermark, on an interval, and forwards whatever it
finds as SSE frames. "Live" here means "polls fast enough that a human
watching a browser tab perceives it as live," not "the server is notified
the instant a row is written." That distinction matters less for a
debugging UI than it would for the task queue itself — a few hundred
milliseconds of latency on a control-plane view is invisible to a human,
where it would be a real cost on the hot path M1 built.

## `packages/api` is read-mostly on purpose

The only mutation this milestone's API exposes is starting a new
workflow, and that exists purely so the demo has something to look at
without a separate script. Every actual state change — starting a
workflow, appending an event, anything at all — still goes through
`appendEvents`/`startWorkflow`, reused verbatim from `packages/worker-sdk`
and `packages/db`. `packages/api` doesn't gain a single new way to
mutate a workflow that didn't already exist; it's a thin HTTP skin over
reads, plus one already-existing write path exposed for convenience.

## What the DAG view honestly shows

Every workflow that exists in this codebase so far — reserve→charge→ship,
the timer-workflow example, the two-step cancellation test workflow — is
a strictly sequential chain of `await`s. `replay()`'s mechanism (M3)
already supports concurrent scheduling (multiple `scheduleActivity` calls
via `Promise.all`, each getting its own independent call-index slot), but
nothing in this codebase has ever exercised that path. The DAG view
renders nodes for each `ActivityScheduled`/`TimerScheduled` event with
edges in scheduling order — which, for every workflow that exists today,
draws a straight line, not a branching graph. It will render a genuine
DAG correctly if a future workflow schedules concurrently, but this
milestone does not add a workflow that does, so that specific rendering
path is unexercised. Stated plainly so a screenshot of a straight line
isn't mistaken for evidence of more than what's actually been tested.

## Implementation notes

**`packages/web` deliberately sits outside the `tsc -b` project reference
graph.** Every other package is a Node library, built and type-checked
together by one `tsc -b` at the repo root, with `composite`/`declaration`
output other packages import. `packages/web` is a browser bundle built by
Vite (esbuild/rollup), not `tsc` — it needs `lib: ["DOM", ...]`,
`moduleResolution: "Bundler"`, `jsx: "react-jsx"`, and `noEmit: true`,
none of which fit the shared Node-oriented `tsconfig.base.json`. Rather
than force a mismatched config to fit, `packages/web` got its own
standalone `tsconfig.json` and was removed from the root `tsconfig.json`'s
`references` array; the root `build`/`typecheck` scripts instead chain
into `packages/web`'s own `tsc --noEmit`/`vite build` explicitly. It
still gets `@karyakram/core` as a real workspace dependency —
`foldEvents` is imported into the browser bundle exactly like any other
consumer, unmodified, which is the entire point (see above).

**Honest limitation: no real browser was available to visually confirm
rendering.** This environment has no browser automation/screenshot tool.
What was actually verified: `vite build` succeeds; `tsc --noEmit` passes
for the whole frontend; the full stack was started for real (Postgres,
the reaper, a worker cluster, the API server, the Vite dev server) and a
workflow was run through it end-to-end via the real HTTP API, producing
the exact expected 8-event reserve→charge→ship history; every source
file the UI depends on (`App.tsx`, `WorkflowDetail.tsx`, `DagView.tsx`,
and `@xyflow/react`'s bundled dependency) was fetched from the running
Vite dev server and confirmed to transform and serve without error. What
was _not_ verified: that the DAG actually lays out visually correctly,
that the scrubber's drag interaction behaves as intended, or that nothing
throws a client-side React error only visible in an actual DOM/console.
The code was written and reviewed carefully, and every layer beneath the
final render was checked directly — but "the UI looks and behaves
correctly" is a claim this note does not make, because it wasn't checked.
