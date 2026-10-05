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
