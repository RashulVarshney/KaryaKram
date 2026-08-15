/**
 * M5 demo: starts the reaper, a reserve->charge->ship worker cluster, the
 * API server (in this same process), and the Vite dev server for
 * packages/web — then prints the URL and stays running. Unlike M1-M4,
 * the actual proof here is visual (drag the scrubber, watch the DAG and
 * state panel update); this script sets the stage rather than asserting
 * PASS/FAIL itself. See docs/plans/m5-control-plane.md §6.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createPoolFromEnv } from '@karyakram/db';
import { buildServer } from '../server';

const API_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(API_DIR, '..', '..');
const WORKER_SDK_DIR = path.join(REPO_ROOT, 'packages', 'worker-sdk');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function spawnLogged(
  name: string,
  cwd: string,
  command: string,
  args: string[],
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { cwd, env: process.env });
  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      console.log(`  [${name}] ${line}`);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      console.error(`  [${name}] ${line}`);
    }
  });
  return child;
}

async function main(): Promise<void> {
  const pool = createPoolFromEnv();

  console.log('== KaryaKram M5 demo ==\n');
  console.log('1. Starting reaper + reserve->charge->ship worker cluster...');
  const reaper = spawnLogged('reaper', WORKER_SDK_DIR, process.execPath, [
    '--import',
    TSX_LOADER,
    'src/bin/run-reaper.ts',
  ]);
  const app = spawnLogged('cluster', WORKER_SDK_DIR, process.execPath, [
    '--import',
    TSX_LOADER,
    'src/bin/reserve-charge-ship-app.ts',
  ]);

  console.log('2. Starting the API server...');
  const server = buildServer({ pool });
  const apiPort = process.env['PORT'] ? Number(process.env['PORT']) : 3001;
  const apiAddress = await server.listen({ port: apiPort, host: '0.0.0.0' });
  console.log(`   API listening on ${apiAddress}`);

  console.log('3. Starting the Vite dev server for packages/web...');
  const web = spawnLogged('web', REPO_ROOT, 'pnpm', ['--filter', '@karyakram/web', 'run', 'dev']);

  console.log('\n4. Ready. Open http://localhost:5173 in a browser.');
  console.log(
    '   Click "Start a new reserve -> charge -> ship workflow", select it, drag the scrubber.',
  );
  console.log('   Press Ctrl+C to stop everything.\n');

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    reaper.kill('SIGTERM');
    app.kill('SIGTERM');
    web.kill('SIGTERM');
    void server
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
