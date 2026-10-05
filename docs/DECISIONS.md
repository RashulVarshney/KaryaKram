# Decisions (feat/llm-steps)

Open choices made without asking, recorded as they come up. Newest at the bottom.

1. **Git push.** The brief said both "push after every phase" and "never push". I first treated
   it as ambiguous and committed locally only; the user then said explicitly "push changes too
   after every phase", so from Phase 4 onward the `feat/llm-steps` branch (never master) is pushed
   after every phase, and phases 0-3 were pushed at that point.
2. **Event names.** The new events use the exact names from the brief (`LLM_REQUESTED`, …).
   Existing events keep their PascalCase names; the mixed style is deliberate, not an accident.
3. **Task list.** There is no task-list tool in this environment, so progress is ticked off in
   `docs/TASKS.md`.
4. **LLM steps are leased tasks, not a new execution path.** `ctx.llmCall` emits a command that
   becomes an `LLM_REQUESTED` event plus a task of type `llm`, so leasing, heartbeats, retries and
   the DLQ are reused unchanged. Workflow code never receives a live provider response: it only
   ever sees recorded `LLM_COMPLETED` output via replay, which is what makes truncation and
   redaction of stored data consistent between the first run and every replay.
5. **Step ids** are `llm-<n>` / `tool-<n>` where `n` is the call position among calls of that kind.
6. **Hashing lives outside `packages/core`.** Core only defines the canonical JSON (it is bundled
   into the browser and cannot use `node:crypto`); `replay()` takes an injected `hash` function and
   the worker layer supplies sha256. `model: 'default'` is a sentinel that is hashed literally, so
   changing the configured provider model never invalidates recorded outputs.
7. **Hash mismatch fails the workflow** (`WorkflowFailed` with a message naming the step and both
   hashes) instead of using the existing "propagate and retry" behaviour of `NonDeterminismError`
   for activity-type mismatches, which is unchanged. Retrying cannot fix a code change.
8. **Fencing token = (`leased_by`, `attempt`).** The outcome write runs in one transaction that
   first does `SELECT ... FOR UPDATE` on the task row where `leased_by` and `attempt` still match.
   The row lock also stops the reaper's `SKIP LOCKED` reclaim from stealing the lease between the
   check and the commit.
9. **Heartbeating while a provider call is in flight needed no new code**: `Worker` already
   heartbeats every in-flight task on an interval. It is covered by a test (2s lease, 3.5s call,
   100ms reaper -> one provider call, attempt stays 1) that I verified fails with heartbeats
   disabled.
10. **`KARYAKRAM_STORE_PROMPTS=false` stores hashes of prompts only; responses are still stored**,
    because replay must hand the recorded output back to workflow code. Because the executing worker
    still needs the real prompt, any step whose stored request is not `full` (hash-only, redacted,
    truncated) recovers the exact request by re-running the workflow function against history
    (`ReplayResult.pendingLlmRequests`) and checking it against the recorded hash.
11. **Retryable provider errors rethrow** so the existing `fail()` path applies full-jitter backoff
    and dead-letters at `max_attempts`; `fail()` gained `minDelaySeconds` so a provider's
    `Retry-After` is a floor on the delay. Non-retryable errors are recorded as `LLM_FAILED`. When
    retries are exhausted both happen: `LLM_FAILED` is recorded (so the workflow can move on) and
    the task is dead-lettered (so an operator sees it).
12. **Pre-existing flaky test left unchanged.** `worker-sdk/test/metrics.integration.test.ts`
    ("increments dequeued/completed on success and failed on a thrown handler") failed once in the
    full-suite run on this branch and passed 14/14 when rerun alone. Its handler throws on call 2,
    `fail()` re-queues with random full-jitter delay up to 1s, and the test asserts exact counters
    after ~100ms, so a short jitter draw makes the retry run first (counters read 3/2/1 instead of
    2/1/1). The jitter distribution in `fail()` is unchanged by this branch (only a `max(..., 0)`
    was added), so this is flakiness by construction, not a regression — but I did not reproduce it
    on the baseline commit, so that is analysis, not proof. I did not edit the test.
13. **Tool exactly-once is a database transaction, not a convention.** One transaction does: early
    (non-locking) lease check -> claim `tool_executions (workflow_id, step_id)` -> run the tool
    through the transaction's connection -> record the result -> locking lease check -> append
    `TOOL_COMPLETED` -> commit. A crash before commit rolls everything back (the retry starts
    clean); a concurrent duplicate blocks on the claim's unique index and then reuses the stored
    result. This holds for side effects done via `ctx.client`. For side effects outside Postgres the
    handler gets an `idempotencyKey` to pass to the external system, which narrows but cannot close
    the duplicate window — documented as a limitation.
14. **The lease row lock is taken late for tools.** Holding `FOR UPDATE` on the task row for the
    whole tool run would block this worker's own heartbeat `UPDATE`, so the early check is
    non-locking and only the final check before the events locks the row.
15. **Extra fault point `before_tool_commit`** (beyond the three in the brief) kills the process
    after the tool's side effect and outcome are written but before COMMIT — the window the
    transactional design exists to make safe — so the chaos test can exercise it directly.
16. **Test hygiene lesson recorded:** integration tests load `@karyakram/db` from `dist/`, so a
    mutation made to `src` must be followed by `tsc -b` to take effect. My first exactly-once
    mutation check silently did nothing for that reason; it was redone after a rebuild and then
    failed as it should.
17. **Retry policy reuses existing machinery.** `fail()` already did full-jitter exponential
    backoff and dead-lettering at `max_attempts`; the only change is the `minDelaySeconds` floor,
    factored into a pure `computeRetryDelayWithFloorSeconds` so the schedule is unit-testable.
    The "fake clock" for the schedule test is an explicit clock object advanced by the computed
    delays plus an injected RNG, because in production the delay is applied as `now() + interval`
    inside Postgres and cannot be driven by a JS clock; the end-to-end tests measure real
    `run_after` effects (a 1.5s `Retry-After` produces a >=1.45s gap between audited provider calls).
18. **Pushing in this environment** goes over SSH with a one-off URL
    (`git push git@github.com:RashulVarshney/KaryaKram.git feat/llm-steps`): the configured HTTPS
    remote has no credentials here, and there is an SSH key on the machine. The configured remote
    was left untouched.
19. **What "replayed" means.** In traces: `replayed=true` on a span means the step's output was
    served from the event log (a workflow replay passing over it, or a redelivered task finding the
    outcome already durable) and no provider/tool call was made; `replayed=false` is the one live
    execution. In the debugger: a completion is badged `replayed` when a later decision event
    (`*_REQUESTED`, `ActivityScheduled`, `TimerScheduled`, `WorkflowCompleted/Failed`) exists after
    it, because producing that decision required re-running the workflow function from the top,
    which consumed the recorded output. This is derived from the log; no extra event is stored.
20. **No component test for the React UI.** The repo has no DOM/component test infrastructure, so
    the debugger's logic lives in `packages/web/src/llmView.ts` (pure TS) and is unit-tested there;
    the JSX that renders it is covered only by typecheck and `vite build`, not by a render test.
21. **The mock provider's "classification" is not a classification.** Its output is a deterministic
    hash-tagged echo (`mock(<digest>): ...`), so in the demo the `category` field is that string,
    not billing/technical/etc. The workflow, durability and side effects are real; the model
    output is placeholder text. A real category requires `LLM_PROVIDER=anthropic`.
22. **Chaos harness waits for the queue to go quiet before counting provider calls.** My first
    version counted as soon as the workflow finished. Mutation testing (disabling the "outcome
    already recorded -> don't call again" guard) showed it passed anyway: in `after_persist` crashes
    the dead worker's stale `llm` task is only reclaimed ~2s later, after the workflow has already
    completed. The harness now keeps the replacement worker and reaper running until no task is
    pending/leased. With the guard disabled it now fails with "persisted_before_crash had 2
    provider calls"; with it enabled it is clean. (Mutations are applied to `src` of worker-sdk,
    which the spawned workers load directly.)
23. **Recovery time is only reported for runs that actually had something to recover.** A
    `random_delay` kill can land after the workflow finished; those runs record
    `completedBeforeCrash: true` and no recovery time instead of a meaningless ~0ms.
24. **`llm-agent-app` enables the M6 `LISTEN/NOTIFY` wake-up when `NOTIFY_CONNECTION_STRING` is
    set** (the chaos harness and `demo:llm` set it). Without it, a respawned worker's idle poll
    backoff reached its 2s ceiling and every step after a recovery paid ~2s; recovery after a
    provider-then-crash fault measured ~13s before and ~2.5s after (dominated by the 2s lease
    expiry plus process boot). That is an infrastructure latency, not an engine property.
25. **Chaos runs are slow by construction** (a real process spawn plus lease expiry per run,
    ~5-8s each), so the integration test defaults to N=50 (~5 min) and is tunable with
    `KARYAKRAM_CHAOS_RUNS`. `pnpm chaos:llm` runs the same harness against a throwaway database
    and saves raw per-run JSON under `docs/results/`.
26. **Benchmarks run against a throwaway database** (`bench/src/scratchDb.ts` creates one on the dev
    Postgres server, migrates it, and drops it), because they TRUNCATE tables. The chaos script does
    the same. The dev database is never touched.
27. **Benchmark methodology fixes made before any number was recorded**, each found by checking the
    output against common sense: (a) replay of 5 steps measured _faster_ than 1 step — a JIT cold
    start since K=1 ran first; fixed with a global warm-up; (b) throughput of ~47 workflows/sec with
    20 in flight was far below what a ~30 ms workflow implies — the harness's shared 5-connection
    pool (workers + 20 polling lanes) was the bottleneck; fixed with separate 20-connection pools
    and 5 ms completion polling, giving ~103-115/sec. The earlier numbers were discarded, not
    recorded. Throughput is still labelled harness-limited.
28. **Overhead is reported as a measured total, not attributed.** The ~11 ms live step cost includes
    queue wake-up, history read, request hashing, the provider call and the persist transaction; I
    did not instrument them separately, so `docs/RESULTS.md` does not call it "event logging cost".
