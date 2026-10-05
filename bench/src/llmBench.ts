/**
 * Benchmarks for durable LLM steps. Everything runs against a throwaway
 * database with the deterministic mock provider (no network, no key), so
 * what is measured is the ENGINE's cost, never a real model's latency.
 *
 *   A. live overhead: engine-run `llm_call` step vs a raw `provider.complete()`
 *   B. replay: re-running a workflow over K recorded LLM steps (no provider call)
 *   C. concurrent throughput of 1-step LLM workflows (single machine)
 *
 * Timing sources are stated next to each number in the output. Raw samples
 * are written to docs/results/ so nothing in docs/RESULTS.md is hand-typed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { replay, type LlmRequest, type StoredWorkflowEvent } from '@karyakram/core';
import { getEvents, type Task } from '@karyakram/db';
import { hashLlmRequest, MockProvider, sha256Hex } from '@karyakram/llm';
import {
  createLlmCallHandler,
  createWorkflowReplayHandler,
  defineWorkflow,
  loadLlmStepConfig,
  startWorkflow,
  Worker,
} from '@karyakram/worker-sdk';
import { createScratchDb } from './scratchDb';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Stats {
  n: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p: number): number =>
    s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? NaN;
  return {
    n: s.length,
    minMs: s[0] ?? NaN,
    p50Ms: pick(50),
    p95Ms: pick(95),
    p99Ms: pick(99),
    maxMs: s[s.length - 1] ?? NaN,
    meanMs: s.reduce((a, b) => a + b, 0) / (s.length || 1),
  };
}

const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
const line = (label: string, st: Stats): string =>
  `  ${label.padEnd(44)} n=${String(st.n).padEnd(4)} p50=${fmt(st.p50Ms).padStart(8)}ms  p95=${fmt(st.p95Ms).padStart(8)}ms  p99=${fmt(st.p99Ms).padStart(8)}ms  mean=${fmt(st.meanMs).padStart(8)}ms`;

const request: LlmRequest = {
  model: 'default',
  messages: [
    { role: 'system', content: 'You are a benchmark assistant.' },
    { role: 'user', content: 'Summarize the ticket in one sentence.' },
  ],
  params: { mockOutput: 'ok' },
};

const oneStep = defineWorkflow<{ n: number }, string>('bench-one-step', async (_i, ctx) => {
  return (await ctx.llmCall(request)).text;
});

function startWorkers(pool: Pool, dbUrl: string, provider: MockProvider): Worker[] {
  const common = {
    maxConcurrency: 25,
    leaseSeconds: 30,
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 5,
    maxPollIntervalMs: 5,
    notifyConnectionString: dbUrl,
  };
  const config = loadLlmStepConfig();
  const workers = [
    new Worker(
      pool,
      { ...common, workerId: 'bench-wf', taskType: 'workflow' },
      createWorkflowReplayHandler(pool, [oneStep], undefined, { llm: config }),
    ),
    new Worker(
      pool,
      { ...common, workerId: 'bench-llm', taskType: 'llm' },
      createLlmCallHandler(pool, { provider, workflows: [oneStep], config }),
    ),
  ];
  for (const w of workers) w.start();
  return workers;
}

async function waitDone(pool: Pool, id: string, pollMs = 1): Promise<void> {
  for (;;) {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id = $1',
      [id],
    );
    if (rows[0]?.status === 'COMPLETED') return;
    await sleep(pollMs);
  }
}

/** Per-workflow timings taken from the event log's own timestamps (transaction start times). */
async function timingsFromLog(pool: Pool): Promise<{ stepMs: number[]; e2eMs: number[] }> {
  const { rows } = await pool.query<{ step_ms: number | null; e2e_ms: number | null }>(
    `SELECT
       EXTRACT(EPOCH FROM (MAX(created_at) FILTER (WHERE event_type = 'LLM_COMPLETED')
                         - MIN(created_at) FILTER (WHERE event_type = 'LLM_REQUESTED'))) * 1000 AS step_ms,
       EXTRACT(EPOCH FROM (MAX(created_at) FILTER (WHERE event_type = 'WorkflowCompleted')
                         - MIN(created_at) FILTER (WHERE event_type = 'WorkflowStarted'))) * 1000 AS e2e_ms
     FROM workflow_events GROUP BY workflow_id`,
  );
  return {
    stepMs: rows.map((r) => Number(r.step_ms)).filter(Number.isFinite),
    e2eMs: rows.map((r) => Number(r.e2e_ms)).filter(Number.isFinite),
  };
}

async function sectionA(pool: Pool, dbUrl: string, n: number) {
  const out: Record<string, unknown> = {};
  for (const latencyMs of [0, 50]) {
    await pool.query(
      'TRUNCATE tasks, workflow_events, workflow_executions, provider_call_audit RESTART IDENTITY CASCADE',
    );
    const provider = new MockProvider({ latencyMs }); // no audit: isolate the engine, not the audit insert

    // raw: the provider call alone
    for (let i = 0; i < 20; i++) await provider.complete(request); // warmup
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await provider.complete(request);
      raw.push(performance.now() - t);
    }

    // engine: one workflow at a time through real workers over Postgres
    const workers = startWorkers(pool, dbUrl, provider);
    for (let i = 0; i < 20; i++) await waitDone(pool, await startWorkflow(pool, oneStep, { n: i })); // warmup
    await pool.query(
      'TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE',
    );
    for (let i = 0; i < n; i++) await waitDone(pool, await startWorkflow(pool, oneStep, { n: i }));
    await Promise.all(workers.map((w) => w.stop()));
    const t = await timingsFromLog(pool);

    out[`latency_${String(latencyMs)}ms`] = {
      simulatedProviderLatencyMs: latencyMs,
      rawProviderCall: stats(raw),
      engineStep_requestedToCompleted: stats(t.stepMs),
      engineEndToEnd_startedToCompleted: stats(t.e2eMs),
      overheadMedianMs: stats(t.stepMs).p50Ms - stats(raw).p50Ms,
      samples: { raw, stepMs: t.stepMs, e2eMs: t.e2eMs },
    };
    console.log(`\nA. live llm_call overhead (simulated provider latency ${String(latencyMs)}ms)`);
    console.log(line('raw provider.complete()', stats(raw)));
    console.log(line('engine step (LLM_REQUESTED -> LLM_COMPLETED)', stats(t.stepMs)));
    console.log(line('engine workflow (Started -> Completed)', stats(t.e2eMs)));
    console.log(
      `  engine step - raw call, median difference: ${fmt(stats(t.stepMs).p50Ms - stats(raw).p50Ms)} ms`,
    );
  }
  return out;
}

/** Builds a history of `k` completed LLM steps followed by one in-flight step, by driving replay itself. */
async function buildHistory(
  k: number,
): Promise<{ wf: ReturnType<typeof chain>; history: StoredWorkflowEvent[] }> {
  const wf = chain(k + 1);
  const history: StoredWorkflowEvent[] = [
    { seq: 1, event: { type: 'WorkflowStarted', workflowType: 'chain', input: {} } },
  ];
  for (let step = 0; step < k + 1; step++) {
    const r = await replay(wf, {}, history, { hash: sha256Hex });
    const cmd = r.commands[0];
    if (!cmd || cmd.type !== 'RequestLlmCall') throw new Error('expected a request command');
    const reqSeq = history.length + 1;
    history.push({
      seq: reqSeq,
      event: {
        type: 'LLM_REQUESTED',
        stepId: cmd.stepId,
        requestHash: cmd.requestHash,
        requestStorage: 'full',
        request: cmd.request,
        maxAttempts: 5,
      },
    });
    if (step < k) {
      history.push({
        seq: reqSeq + 1,
        event: {
          type: 'LLM_COMPLETED',
          stepId: cmd.stepId,
          scheduledEventSeq: reqSeq,
          requestHash: cmd.requestHash,
          text: `out-${String(step)}`,
          toolCalls: [],
          truncated: false,
          model: 'mock-1',
          tokensIn: 20,
          tokensOut: 5,
          latencyMs: 10,
          estimatedCostUsd: 0.00003,
          attempt: 1,
        },
      });
    }
  }
  return { wf, history };
}

function chain(steps: number) {
  return async (
    _input: unknown,
    ctx: { llmCall(r: LlmRequest): Promise<{ text: string }> },
  ): Promise<string> => {
    let text = 'start';
    for (let k = 0; k < steps; k++) {
      text = (
        await ctx.llmCall({
          model: 'default',
          messages: [{ role: 'user', content: `step ${String(k)} after ${text}` }],
        })
      ).text;
    }
    return text;
  };
}

async function sectionB(pool: Pool, iterations: number) {
  const out: Record<string, unknown> = {};
  console.log('\nB. replay of recorded LLM steps (zero provider calls)');
  {
    // global JIT warm-up over the largest history first, so K=1 isn't measured cold
    const warm = await buildHistory(50);
    for (let i = 0; i < 500; i++) await replay(warm.wf, {}, warm.history, { hash: sha256Hex });
  }
  for (const k of [1, 5, 20, 50]) {
    const { wf, history } = await buildHistory(k);
    for (let i = 0; i < 30; i++) await replay(wf, {}, history, { hash: sha256Hex });
    const pure: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      await replay(wf, {}, history, { hash: sha256Hex });
      pure.push(performance.now() - t);
    }

    // handler level: includes reading the history from Postgres
    await pool.query(
      'TRUNCATE tasks, workflow_events, workflow_executions RESTART IDENTITY CASCADE',
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workflow_executions (id, workflow_type, input, status) VALUES (gen_random_uuid(), 'chain', '{}'::jsonb, 'RUNNING') RETURNING id`,
    );
    const workflowId = rows[0]?.id ?? '';
    for (const e of history) {
      await pool.query(
        'INSERT INTO workflow_events (workflow_id, seq, event_type, payload) VALUES ($1, $2, $3, $4::jsonb)',
        [workflowId, e.seq, e.event.type, JSON.stringify(e.event)],
      );
    }
    const chainDef = defineWorkflow('chain', wf as never);
    const handler = createWorkflowReplayHandler(pool, [chainDef]);
    const task = {
      id: '1',
      workflowId,
      taskType: 'workflow',
      attempt: 1,
      maxAttempts: 3,
    } as unknown as Task;
    for (let i = 0; i < 10; i++) await handler(task);
    const withDb: number[] = [];
    for (let i = 0; i < Math.max(50, iterations / 4); i++) {
      const t = performance.now();
      await handler(task);
      withDb.push(performance.now() - t);
    }
    const loaded = (await getEvents(pool, workflowId)).length;

    out[`steps_${String(k)}`] = {
      recordedSteps: k,
      historyEvents: loaded,
      pureReplay: stats(pure),
      handlerWithPostgresRead: stats(withDb),
      pureReplayPerRecordedStepMs: stats(pure).p50Ms / k,
      samples: { pure, withDb },
    };
    console.log(line(`pure replay, ${String(k)} recorded steps`, stats(pure)));
    console.log(line(`handler incl. Postgres read, ${String(k)} steps`, stats(withDb)));
  }
  return out;
}

async function sectionC(adminPool: Pool, dbUrl: string, total: number, concurrency: number) {
  await adminPool.query(
    'TRUNCATE tasks, workflow_events, workflow_executions, provider_call_audit RESTART IDENTITY CASCADE',
  );
  // Separate, larger pools for the engine and for the load generator: with one shared
  // 5-connection pool the benchmark's own completion polling was the bottleneck.
  const enginePool = new Pool({ connectionString: dbUrl, max: 20 });
  const clientPool = new Pool({ connectionString: dbUrl, max: 20 });
  const provider = new MockProvider({ latencyMs: 0 });
  const workers = startWorkers(enginePool, dbUrl, provider);
  const t0 = performance.now();
  let started = 0;
  async function lane(): Promise<void> {
    while (started < total) {
      const i = started++;
      await waitDone(clientPool, await startWorkflow(clientPool, oneStep, { n: i }), 5);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  const seconds = (performance.now() - t0) / 1000;
  await Promise.all(workers.map((w) => w.stop()));
  await Promise.all([enginePool.end(), clientPool.end()]);
  const result = { workflows: total, concurrency, seconds, workflowsPerSecond: total / seconds };
  console.log(
    `\nC. concurrent throughput: ${String(total)} one-step workflows, ${String(concurrency)} in flight`,
  );
  console.log(`  ${fmt(result.workflowsPerSecond)} workflows/sec  (${fmt(seconds)}s wall)`);
  return result;
}

async function main(): Promise<void> {
  const baseUrl = process.env['DATABASE_URL'];
  if (!baseUrl) throw new Error('DATABASE_URL is not set');
  const n = Number(process.env['BENCH_N'] ?? '200');
  const db = await createScratchDb(baseUrl);
  const startedAt = new Date();
  try {
    const environment = {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCores: os.cpus().length,
      totalMemGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
      postgres: (await db.pool.query<{ v: string }>('SHOW server_version')).rows[0]?.v,
      postgresLocation: 'docker container on the same machine (localhost)',
      provider: 'MockProvider (deterministic, no network)',
      n,
    };
    console.log('environment:', JSON.stringify(environment));
    // keep hashing referenced so a dead-code pass can't drop the import used for sanity
    void hashLlmRequest(request);

    const a = await sectionA(db.pool, db.url, n);
    const b = await sectionB(db.pool, Math.max(200, n));
    const c = await sectionC(db.pool, db.url, 400, 20);

    const outDir = path.resolve(__dirname, '..', '..', 'docs', 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(
      outDir,
      `llm-bench-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          startedAt: startedAt.toISOString(),
          environment,
          A_liveOverhead: a,
          B_replay: b,
          C_throughput: c,
        },
        null,
        2,
      ),
    );
    console.log(`\nraw results: ${path.relative(process.cwd(), file)}`);
  } finally {
    await db.drop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
