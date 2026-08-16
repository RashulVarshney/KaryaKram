/**
 * M8 exit-criteria demo: builds both Docker images, stands up a real
 * local `kind` cluster, deploys the full system via one `kubectl apply
 * -k`, then proves — by actually deleting real pods, not by assertion —
 * that the guarantees M3/M4/M6 already proved locally hold unchanged
 * under a real orchestrator. See docs/08-kubernetes.md.
 *
 * Requires `docker`, `kind`, and `kubectl` on PATH.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { foldEvents } from '@karyakram/core';
import { createPool, getCurrentLeader, getEvents } from '@karyakram/db';
import { getTimerWorkflowExecutionCount, timerWorkflow } from '../examples/timerWorkflow';
import { startWorkflow } from '../startWorkflow';

const WORKER_SDK_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(WORKER_SDK_DIR, '..', '..');
const K8S_DIR = path.join(REPO_ROOT, 'k8s');
const CLUSTER_NAME = 'karyakram-demo';
const DEMO_DATABASE_URL = 'postgres://karyakram:karyakram@localhost:15432/karyakram';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(
  cmd: string,
  args: string[],
  opts: { allowFailure?: boolean; quiet?: boolean } = {},
): string {
  console.log(`   $ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (!opts.quiet && result.stdout.trim()) console.log(result.stdout.trim());
  if (result.status !== 0 && !opts.allowFailure) {
    console.error(result.stderr);
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${String(result.status)}`);
  }
  return result.stdout;
}

function kubectl(args: string[], opts: { quiet?: boolean } = {}): string {
  return run('kubectl', ['--context', `kind-${CLUSTER_NAME}`, ...args], opts);
}

async function pollUntil(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs = 500 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: condition never became true in time');
    await sleep(intervalMs);
  }
}

async function main(): Promise<void> {
  console.log('== KaryaKram M8 demo ==\n');

  console.log('1. Building Docker images...');
  run('docker', ['build', '-t', 'karyakram-app:latest', '.']);
  run('docker', [
    'build',
    '-f',
    path.join(REPO_ROOT, 'packages', 'web', 'Dockerfile'),
    '-t',
    'karyakram-web:latest',
    '.',
  ]);

  console.log('\n2. Creating the kind cluster...');
  run('kind', [
    'create',
    'cluster',
    '--name',
    CLUSTER_NAME,
    '--config',
    path.join(K8S_DIR, 'kind-config.yaml'),
  ]);

  try {
    console.log('\n3. Loading images into the cluster...');
    run('kind', [
      'load',
      'docker-image',
      'karyakram-app:latest',
      'karyakram-web:latest',
      '--name',
      CLUSTER_NAME,
    ]);

    console.log('\n4. Deploying Postgres and waiting for it to be ready...');
    kubectl([
      'apply',
      '-f',
      path.join(K8S_DIR, 'configmap.yaml'),
      '-f',
      path.join(K8S_DIR, 'postgres.yaml'),
    ]);
    kubectl(['wait', '--for=condition=ready', 'pod', '-l', 'app=postgres', '--timeout=120s']);

    console.log('\n5. Running migrations...');
    kubectl(['delete', 'job', 'karyakram-migrate', '--ignore-not-found']);
    kubectl(['apply', '-f', path.join(K8S_DIR, 'migrate-job.yaml')]);
    kubectl(['wait', '--for=condition=complete', 'job/karyakram-migrate', '--timeout=60s']);

    console.log('\n6. Deploying the scheduler, worker, api, and web...');
    kubectl(['apply', '-k', K8S_DIR]);
    kubectl(['wait', '--for=condition=available', 'deployment', '--all', '--timeout=180s']);

    console.log('\n7. Chaos check 1: kill the worker pod mid-timer-workflow...');
    const pool = createPool({ connectionString: DEMO_DATABASE_URL });
    const workflowId = await startWorkflow(pool, timerWorkflow, { sleepMs: 8_000 });
    console.log(`   workflowId = ${workflowId}`);

    await pollUntil(
      async () => {
        const events = await getEvents(pool, workflowId);
        const state = foldEvents(events);
        return Object.values(state.activities).some(
          (a) => a.activityType === 'before-timer' && a.status === 'COMPLETED',
        );
      },
      { timeoutMs: 15_000 },
    );

    const workerPods = kubectl(['get', 'pods', '-l', 'app=worker', '-o', 'name'])
      .trim()
      .split('\n');
    const podToKill = workerPods[0];
    if (!podToKill) throw new Error('no worker pod found');
    console.log(`   deleting ${podToKill} with --grace-period=0...`);
    kubectl(['delete', podToKill, '--grace-period=0', '--force']);

    await pollUntil(
      async () => {
        const events = await getEvents(pool, workflowId);
        const state = foldEvents(events);
        return state.status === 'COMPLETED';
      },
      { timeoutMs: 60_000 },
    );

    const beforeCount = await getTimerWorkflowExecutionCount(pool, 'before-timer');
    const afterCount = await getTimerWorkflowExecutionCount(pool, 'after-timer');
    const chaos1Pass = beforeCount === 1 && afterCount === 1;
    console.log(
      `   before-timer executions: ${String(beforeCount)}, after-timer executions: ${String(afterCount)} — ${chaos1Pass ? 'PASS' : 'FAIL'}`,
    );

    console.log('\n8. Chaos check 2: kill the scheduler leader pod...');
    let leaderId: string | undefined;
    await pollUntil(
      async () => {
        const current = await getCurrentLeader(pool);
        leaderId = current?.leaderId;
        return leaderId !== undefined;
      },
      { timeoutMs: 15_000 },
    );
    console.log(`   current leader = ${String(leaderId)}`);

    const schedulerPods = kubectl(['get', 'pods', '-l', 'app=scheduler', '-o', 'json'], {
      quiet: true,
    });
    const parsed = JSON.parse(schedulerPods) as {
      items: { metadata: { name: string; labels?: Record<string, string> } }[];
    };
    // SCHEDULER_ID is set (via k8s/scheduler.yaml) to the pod's own name.
    const leaderPod = parsed.items.find((item) => item.metadata.name === leaderId);
    if (!leaderPod) throw new Error(`could not find pod for leader ${String(leaderId)}`);
    const killedAt = Date.now();
    console.log(`   deleting pod/${leaderPod.metadata.name} with --grace-period=0...`);
    kubectl(['delete', `pod/${leaderPod.metadata.name}`, '--grace-period=0', '--force']);

    let newLeaderId: string | undefined;
    await pollUntil(
      async () => {
        const current = await getCurrentLeader(pool);
        if (current && current.leaderId !== leaderId && current.acquiredAt.getTime() > killedAt) {
          newLeaderId = current.leaderId;
          return true;
        }
        return false;
      },
      { timeoutMs: 30_000 },
    );
    const failoverMs = Date.now() - killedAt;
    const chaos2Pass = newLeaderId !== undefined && newLeaderId !== leaderId;
    console.log(
      `   new leader = ${String(newLeaderId)}, failover took ${String(failoverMs)}ms — ${chaos2Pass ? 'PASS' : 'FAIL'}`,
    );

    await pool.end();

    console.log(
      `\n${chaos1Pass && chaos2Pass ? 'PASS' : 'FAIL'}: worker-pod and scheduler-leader chaos checks both hold under a real Kubernetes cluster.`,
    );
    process.exitCode = chaos1Pass && chaos2Pass ? 0 : 1;
  } finally {
    console.log('\n9. Tearing down the cluster...');
    run('kind', ['delete', 'cluster', '--name', CLUSTER_NAME], { allowFailure: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
