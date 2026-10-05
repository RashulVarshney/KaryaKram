# Results

Every number here comes from a real run; raw output is in [`docs/results/`](./results/).
Nothing is estimated, extrapolated or hand-typed: the tables below were generated from the saved
JSON. Where a number can mislead, the caveat sits next to it.

## Environment (all runs)

- 13th Gen Intel(R) Core(TM) i5-13420H, 12 logical cores, 15.3 GiB RAM, linux 7.0.0-34-generic, Node v22.22.2
- PostgreSQL in a Docker container **on the same machine** (localhost), each benchmark in a throwaway database
- Provider: the deterministic `MockProvider` — **no network, no real model**. Nothing below says anything
  about how fast a real LLM is; it measures what _the engine adds_.
- One developer machine. This is not a cloud benchmark and not a scale test.

## 1. Crash safety: 50 real `kill -9` runs

`pnpm chaos:llm` (50 runs, seed 20260105; `chaos-2026-10-05T16-30-40-652Z.json`; ran 2026-10-05T16:30:40.652Z → 2026-10-05T16:33:38.165Z).
Each run starts a support-ticket triage workflow (2 LLM steps + 2 side-effecting tool steps), spawns a
**real worker process** armed to `SIGKILL` itself at a named point, spawns a replacement, and waits for
completion. The reaper and replacement worker then keep running until the queue is completely quiet, so
redeliveries of the dead worker's tasks are included in the counts.

|                                                    | result  |
| -------------------------------------------------- | ------- |
| runs where the worker was killed by SIGKILL        | 50 / 50 |
| workflows that completed                           | 50 / 50 |
| final output identical to a no-crash reference run | 50 / 50 |
| every side effect applied exactly once             | 50 / 50 |
| invariant violations                               | 0       |

| fault point                     | runs | killed by SIGKILL |
| ------------------------------- | ---- | ----------------- |
| `after_provider_before_persist` | 13   | 13                |
| `after_persist`                 | 13   | 13                |
| `before_tool_commit`            | 12   | 12                |
| `random_delay`                  | 12   | 12                |

Provider calls per LLM step, **counted by the provider itself** (`provider_call_audit`, outside the event store),
split by where the kill fell relative to that step:

| window (per LLM step)        | steps | provider calls per step (histogram) | max |
| ---------------------------- | ----- | ----------------------------------- | --- |
| persisted before the crash   | 52    | {"1": 52}                           | 1   |
| in the unavoidable window    | 16    | {"2": 16}                           | 2   |
| first called after the crash | 32    | {"1": 32}                           | 1   |

Reading this honestly:

- A step whose result was committed before the kill was called **exactly once**; a step first called after the kill
  was called **exactly once**.
- A step killed _between the provider returning and the result being committed_ was called **twice, every time**
  (16 of 16). That is the one window the design cannot close: the provider call cannot be made
  atomic with a database commit. The engine guarantees at most one re-call there, not zero. If the provider call has
  a real-world cost or side effect, that re-call is real.
- Side effects (tool steps) were exactly-once in every run, including the 12 killed _after the side effect, before the
  commit_ (`before_tool_commit`). That is a property of doing the effect, its record and the event in one transaction;
  it holds for effects done through the transaction's connection, **not** for effects on an external system.
- 5 of the 50 `random_delay` kills landed after the workflow had already finished; those are counted as crashes but
  not as recoveries.

Recovery time (kill → workflow terminal), the 45 runs that were still in flight when killed:
min 916 ms, p50 2292 ms, p95 3571 ms, max 3589 ms.
**This is dominated by configuration, not by the engine:** the harness uses a 2 s lease (so a dead worker's task is
reclaimed ~1–2 s after the kill) plus starting a fresh Node process. With production-length leases it would be longer.

## 2. Live `llm_call` overhead (event logging vs. a raw provider call)

`pnpm bench:llm`, section A. One workflow at a time (latency, not throughput), 200 samples per configuration after a
20-run warm-up, three independent runs. "Engine step" is `LLM_REQUESTED` → `LLM_COMPLETED` from the event log's
own timestamps (transaction start times); it contains the queue wake-up, history read, request hashing, the provider
call and the persist transaction. "Workflow" is `WorkflowStarted` → `WorkflowCompleted` for a one-step workflow
(it also includes two workflow-task replays).

| simulated provider latency | run | raw call p50 | engine step p50 | step p95 | step p99 | step − raw (median) | workflow p50 | workflow p95 |
| -------------------------- | --- | ------------ | --------------- | -------- | -------- | ------------------- | ------------ | ------------ |
| 0 ms                       | 1   | 0.02         | 11.21           | 13.17    | 15.22    | 11.19               | 31.50        | 36.99        |
| 0 ms                       | 2   | 0.02         | 10.80           | 13.05    | 14.45    | 10.78               | 30.28        | 35.92        |
| 0 ms                       | 3   | 0.02         | 11.06           | 12.63    | 13.70    | 11.03               | 31.01        | 35.19        |
| 50 ms                      | 1   | 50.51        | 61.59           | 64.54    | 65.68    | 11.09               | 84.84        | 89.12        |
| 50 ms                      | 2   | 50.52        | 61.76           | 64.17    | 66.11    | 11.25               | 85.08        | 93.65        |
| 50 ms                      | 3   | 50.53        | 61.56           | 64.26    | 67.19    | 11.03               | 83.17        | 94.06        |

- The extra cost of running a provider call as a durable step was **10.8–11.2 ms at the median** across all six
  (latency × run) cells, and it did **not** change with provider latency (0 ms vs 50 ms) — a useful sanity check that
  it is a fixed engine cost. Against a real LLM call (hundreds of ms to seconds) that is a small fraction;
  against a no-op it is the whole cost.
- I did not break that ~11 ms down into its parts, so I won't attribute it to "event logging" specifically: it is
  the sum of everything listed above.

## 3. Replay vs. live

Section B. Re-running a workflow over K already-recorded LLM steps plus one in-flight step (no provider call is
made; an integration test asserts zero new provider calls across repeated replays). Ranges are min–max of the
per-run medians over three runs; ms.

| recorded LLM steps | pure replay p50 (ms) | pure replay p99 | handler incl. Postgres read p50 | handler p95 |
| ------------------ | -------------------- | --------------- | ------------------------------- | ----------- |
| 1                  | 0.06 – 0.06          | 0.29 – 0.30     | 1.05 – 1.12                     | 1.17 – 1.44 |
| 5                  | 0.09 – 0.11          | 0.43 – 0.77     | 1.17 – 1.25                     | 1.33 – 1.38 |
| 20                 | 0.16 – 0.18          | 1.06 – 1.39     | 1.35 – 1.49                     | 1.48 – 1.75 |
| 50                 | 0.22 – 0.25          | 0.91 – 1.11     | 1.81 – 1.94                     | 2.34 – 2.37 |

- Replaying a recorded history is cheap: the pure `replay()` takes ≈ 0.06 ms for 1 recorded step and ≈ 0.2–0.25 ms for 50
  (roughly 3–4 µs per additional step, derived from those medians), versus ≈ 11 ms to execute a step live. Reading the
  history from Postgres dominates the handler number (≈ 1.1 ms with one step), not the replay itself.
- Cost grows with history length (replay is re-run from the top on every decision), which is the usual
  event-sourcing trade-off; 50 steps is still well under 2 ms end to end here.

## 4. Throughput (harness-limited — not a capacity claim)

Section C: 400 one-step workflows, 20 in flight, mock provider with 0 ms latency, workers in-process.

| run | workflows | in flight | wall (s) | workflows/sec |
| --- | --------- | --------- | -------- | ------------- |
| 1   | 400       | 20        | 3.47     | 115.2         |
| 2   | 400       | 20        | 3.70     | 108.1         |
| 3   | 400       | 20        | 3.88     | 103.2         |

**103–115 workflows/sec** on this machine. Treat it as "what this laptop-class box did with this harness",
not as the engine's ceiling: completion is detected by polling every 5 ms and the load generator shares the machine
with Postgres and the workers. (An earlier version of this benchmark reported ~47 workflows/sec; that was the
harness's own 5-connection pool saturating, fixed before these runs and described in `docs/DECISIONS.md`.)

## What was _not_ measured

- Any real provider (Anthropic) — no key was used; latency and cost figures with a real model are unknown.
- Multi-machine, cloud, or sustained-load behaviour; contention across many concurrent workers.
- The cost of very large prompts/responses (only the size-cap _behaviour_ is tested, not its performance).
- The React debugger's rendering performance.
