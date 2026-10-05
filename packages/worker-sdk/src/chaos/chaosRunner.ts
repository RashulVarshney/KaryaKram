/**
 * Chaos harness for durable LLM/tool steps. For each run it starts a
 * support-ticket triage workflow, spawns a REAL worker process armed to
 * SIGKILL itself at a chosen point (`KARYAKRAM_FAULT`), waits for it to
 * die, spawns a clean replacement, and waits for the workflow to finish.
 *
 * It then checks, against evidence that does not come from the engine:
 *   - the workflow completed with output identical to a no-crash reference run;
 *   - every side effect was applied exactly once (the `side_effects` table
 *     has no unique constraint, so a duplicate would show up as a row);
 *   - provider calls per step, counted from `provider_call_audit` (written by
 *     the provider itself), split by where the crash fell relative to that step:
 *       persisted_before_crash -> its outcome was committed before the kill: EXACTLY 1 call
 *       in_window              -> provider called before the kill, outcome not yet
 *                                 committed: the unavoidable re-call, at most 2
 *       after_crash            -> first called after the kill: EXACTLY 1 call
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Pool } from 'pg';
import { foldEvents } from '@karyakram/core';
import { getEvents, listProviderCalls } from '@karyakram/db';
import { Reaper } from '../reaper';
import { startWorkflow } from '../startWorkflow';
import { sampleTicket, supportTicketTriage } from '../examples/supportTriage';

const WORKER_SDK_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

export type ChaosFault =
  'after_provider_before_persist' | 'after_persist' | 'before_tool_commit' | 'random_delay';

export const CHAOS_FAULTS: ChaosFault[] = [
  'after_provider_before_persist',
  'after_persist',
  'before_tool_commit',
  'random_delay',
];

export type StepWindow = 'persisted_before_crash' | 'in_window' | 'after_crash';

export interface StepAudit {
  stepId: string;
  providerCalls: number;
  window: StepWindow;
}

export interface ChaosRunResult {
  run: number;
  fault: ChaosFault;
  ticket: number;
  crashed: boolean;
  /** The workflow had already finished when the kill landed (random_delay can do this): nothing to recover. */
  completedBeforeCrash: boolean;
  workflowStatus: string;
  /** ms from the kill to the workflow reaching a terminal status. */
  recoveryMs: number | null;
  outputMatchesReference: boolean;
  sideEffectCounts: Record<string, number>;
  sideEffectsExactlyOnce: boolean;
  steps: StepAudit[];
  violations: string[];
}

export interface ChaosOptions {
  /** Connection string of a database that is safe to TRUNCATE (tests use a throwaway one). */
  databaseUrl: string;
  runs: number;
  seed?: number;
  /** Simulated provider latency per call, to give kills something to land inside. */
  providerLatencyMs?: number;
  leaseSeconds?: number;
  onRun?: (result: ChaosRunResult) => void;
  /** Directory-free hook for debugging worker stderr. */
  verbose?: boolean;
}

export interface ChaosSummary {
  runs: number;
  seed: number;
  violations: number;
  results: ChaosRunResult[];
  byFault: Record<string, { runs: number; crashed: number }>;
  windows: Record<
    StepWindow,
    { steps: number; callHistogram: Record<string, number>; maxCalls: number }
  >;
  /** Runs where the workflow was still in flight when killed (i.e. real recoveries). */
  recoveredRuns: number;
  sideEffectsExactlyOnceRuns: number;
  outputsMatchedReferenceRuns: number;
  recoveryMs: { count: number; min: number; p50: number; p95: number; max: number } | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** mulberry32 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spawned {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: string[];
}

function spawnAgent(env: NodeJS.ProcessEnv): Spawned {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, 'src/bin/llm-agent-app.ts'], {
    cwd: WORKER_SDK_DIR,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, stderr };
}

async function resetDb(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE tasks, workflow_events, workflow_executions, provider_call_audit,
              tool_executions, side_effects RESTART IDENTITY CASCADE`,
  );
}

async function workflowOutcome(
  pool: Pool,
  id: string,
): Promise<{ status: string; result: unknown }> {
  const state = foldEvents(await getEvents(pool, id));
  return { status: state.status, result: state.result };
}

async function waitTerminal(pool: Pool, id: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status } = await workflowOutcome(pool, id);
    if (status !== 'RUNNING') return status;
    if (Date.now() > deadline) return 'TIMEOUT';
    await sleep(40);
  }
}

/**
 * Waits until no task is pending or leased. A crashed worker's task is only
 * reclaimed once its lease expires, which can be AFTER the workflow itself
 * has finished (the next step may already have been scheduled by the
 * persisted outcome). Counting provider calls before that redelivery has
 * happened would miss exactly the duplicate this harness exists to catch.
 */
async function waitQuiescent(pool: Pool, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending', 'leased')`,
    );
    if (Number(rows[0]?.n ?? 0) === 0) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

async function dbNow(pool: Pool): Promise<Date> {
  const { rows } = await pool.query<{ t: Date }>('SELECT clock_timestamp() AS t');
  return rows[0]?.t ?? new Date();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? NaN;
}

const REFERENCE_TICKETS = 8;

export async function runChaos(options: ChaosOptions): Promise<ChaosSummary> {
  const seed = options.seed ?? 1;
  const rand = seeded(seed);
  const pool = new Pool({ connectionString: options.databaseUrl, max: 5 });
  const reaper = new Reaper(pool, { intervalMs: 100 });
  reaper.start();

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: options.databaseUrl,
    NOTIFY_CONNECTION_STRING: options.databaseUrl,
    LLM_PROVIDER: 'mock',
    MOCK_LLM_LATENCY_MS: String(options.providerLatencyMs ?? 40),
    LEASE_SECONDS: String(options.leaseSeconds ?? 2),
    HEARTBEAT_INTERVAL_MS: '400',
    POLL_INTERVAL_MS: '20',
    LOG_LEVEL: 'error',
  };
  delete baseEnv['KARYAKRAM_FAULT'];

  try {
    // ---- reference: the same tickets with no crash, one clean process ----
    await resetDb(pool);
    const reference = new Map<number, unknown>();
    const refIds: { ticket: number; id: string }[] = [];
    for (let t = 0; t < REFERENCE_TICKETS; t++) {
      refIds.push({
        ticket: t,
        id: await startWorkflow(pool, supportTicketTriage, sampleTicket(t)),
      });
    }
    const refWorker = spawnAgent({ ...baseEnv, WORKER_ID: 'ref' });
    for (const { ticket, id } of refIds) {
      const status = await waitTerminal(pool, id, 60_000);
      const out = await workflowOutcome(pool, id);
      if (status !== 'COMPLETED')
        throw new Error(`reference run for ticket ${String(ticket)} ended ${status}`);
      reference.set(ticket, out.result);
    }
    refWorker.child.kill('SIGKILL');
    await refWorker.exited;

    // ---- chaos runs ----
    const results: ChaosRunResult[] = [];
    for (let run = 0; run < options.runs; run++) {
      const fault = CHAOS_FAULTS[run % CHAOS_FAULTS.length] ?? 'after_persist';
      const ticket = run % REFERENCE_TICKETS;
      await resetDb(pool);

      const violations: string[] = [];
      const id = await startWorkflow(pool, supportTicketTriage, sampleTicket(ticket));

      const faultEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        WORKER_ID: `chaos-${String(run)}-a`,
        KARYAKRAM_FAULT: fault,
        // fire on the 1st or 2nd hit, so both LLM/tool steps get crashed on across runs
        KARYAKRAM_FAULT_AFTER: String(1 + Math.floor(rand() * 2)),
        KARYAKRAM_FAULT_SEED: String(Math.floor(rand() * 1e9)),
        KARYAKRAM_FAULT_MAX_MS: '600',
      };
      const crashing = spawnAgent(faultEnv);
      const exit = await Promise.race([
        crashing.exited,
        sleep(20_000).then(() => 'alive' as const),
      ]);
      let crashed = false;
      if (exit === 'alive') {
        crashing.child.kill('SIGKILL'); // external kill -9 as a fallback if the fault never fired
        await crashing.exited;
        violations.push('fault point never fired within 20s (killed externally instead)');
        crashed = true;
      } else {
        crashed = exit.signal === 'SIGKILL';
        if (!crashed) {
          violations.push(
            `worker exited without SIGKILL (code=${String(exit.code)}): ${crashing.stderr.join('').slice(0, 300)}`,
          );
        }
      }
      const killedAt = await dbNow(pool);
      const completedBeforeCrash = (await workflowOutcome(pool, id)).status !== 'RUNNING';

      const recovery = spawnAgent({ ...baseEnv, WORKER_ID: `chaos-${String(run)}-b` });
      const status = await waitTerminal(pool, id, 40_000);
      const recoveryMs = Date.now() - killedAt.getTime();
      // keep the replacement worker and reaper running until every task, including
      // the dead worker's reclaimed ones, has been redelivered and settled
      if (!(await waitQuiescent(pool, 15_000))) {
        violations.push('tasks still pending/leased 15s after the workflow finished');
      }
      recovery.child.kill('SIGKILL');
      await recovery.exited;

      const outcome = await workflowOutcome(pool, id);
      if (status !== 'COMPLETED') violations.push(`workflow ended ${status}`);
      const outputMatchesReference =
        JSON.stringify(outcome.result) === JSON.stringify(reference.get(ticket));
      if (!outputMatchesReference)
        violations.push('final output differs from the no-crash reference');

      // side effects: exactly once each
      const { rows: effectRows } = await pool.query<{ step_id: string; kind: string; n: string }>(
        `SELECT step_id, kind, COUNT(*) AS n FROM side_effects WHERE workflow_id = $1 GROUP BY step_id, kind`,
        [id],
      );
      const sideEffectCounts = Object.fromEntries(
        effectRows.map((r) => [`${r.step_id}:${r.kind}`, Number(r.n)]),
      );
      const expectedEffects = ['tool-0:customer_lookup', 'tool-1:reply_sent'];
      const sideEffectsExactlyOnce =
        Object.keys(sideEffectCounts).length === expectedEffects.length &&
        expectedEffects.every((k) => sideEffectCounts[k] === 1);
      if (!sideEffectsExactlyOnce)
        violations.push(`side effects not exactly-once: ${JSON.stringify(sideEffectCounts)}`);

      // provider calls per step, split by crash window
      const calls = await listProviderCalls(pool, id);
      const { rows: completedRows } = await pool.query<{ step_id: string; created_at: Date }>(
        `SELECT payload->>'stepId' AS step_id, created_at FROM workflow_events
          WHERE workflow_id = $1 AND event_type = 'LLM_COMPLETED'`,
        [id],
      );
      const steps: StepAudit[] = [];
      for (const stepId of ['llm-0', 'llm-1']) {
        const stepCalls = calls.filter((c) => c.stepId === stepId);
        const firstCall = stepCalls[0]?.calledAt;
        const completedAt = completedRows.find((r) => r.step_id === stepId)?.created_at;
        let window: StepWindow;
        if (completedAt && completedAt <= killedAt) window = 'persisted_before_crash';
        else if (firstCall && firstCall <= killedAt) window = 'in_window';
        else window = 'after_crash';

        const n = stepCalls.length;
        if (window === 'in_window' ? n < 1 || n > 2 : n !== 1) {
          violations.push(`${stepId} (${window}) had ${String(n)} provider calls`);
        }
        steps.push({ stepId, providerCalls: n, window });
      }

      const result: ChaosRunResult = {
        run,
        fault,
        ticket,
        crashed,
        workflowStatus: status,
        completedBeforeCrash,
        recoveryMs: status === 'COMPLETED' && !completedBeforeCrash ? recoveryMs : null,
        outputMatchesReference,
        sideEffectCounts,
        sideEffectsExactlyOnce,
        steps,
        violations,
      };
      results.push(result);
      options.onRun?.(result);
    }

    return summarize(results, seed);
  } finally {
    reaper.stop();
    await pool.end();
  }
}

export function summarize(results: ChaosRunResult[], seed: number): ChaosSummary {
  const byFault: ChaosSummary['byFault'] = {};
  const windows: ChaosSummary['windows'] = {
    persisted_before_crash: { steps: 0, callHistogram: {}, maxCalls: 0 },
    in_window: { steps: 0, callHistogram: {}, maxCalls: 0 },
    after_crash: { steps: 0, callHistogram: {}, maxCalls: 0 },
  };
  for (const r of results) {
    const f = (byFault[r.fault] ??= { runs: 0, crashed: 0 });
    f.runs++;
    if (r.crashed) f.crashed++;
    for (const s of r.steps) {
      const w = windows[s.window];
      w.steps++;
      const key = String(s.providerCalls);
      w.callHistogram[key] = (w.callHistogram[key] ?? 0) + 1;
      w.maxCalls = Math.max(w.maxCalls, s.providerCalls);
    }
  }
  const rec = results
    .map((r) => r.recoveryMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return {
    runs: results.length,
    seed,
    violations: results.reduce((n, r) => n + r.violations.length, 0),
    results,
    byFault,
    windows,
    recoveredRuns: results.filter((r) => !r.completedBeforeCrash).length,
    sideEffectsExactlyOnceRuns: results.filter((r) => r.sideEffectsExactlyOnce).length,
    outputsMatchedReferenceRuns: results.filter((r) => r.outputMatchesReference).length,
    recoveryMs:
      rec.length === 0
        ? null
        : {
            count: rec.length,
            min: rec[0] ?? NaN,
            p50: percentile(rec, 50),
            p95: percentile(rec, 95),
            max: rec[rec.length - 1] ?? NaN,
          },
  };
}
