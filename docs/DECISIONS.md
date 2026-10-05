# Decisions (feat/llm-steps)

Open choices made without asking, recorded as they come up. Newest at the bottom.

1. **Git push.** The brief says both "push to github after every phase" and "never push". I did
   not push: it is the outward-facing, harder-to-undo reading, and it is the more conservative
   one. Every phase is committed locally on `feat/llm-steps`; pushing is one command for you.
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
