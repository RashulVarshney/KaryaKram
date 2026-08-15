import { createPoolFromEnv } from '@karyakram/db';
import { buildServer } from '../server';

async function main(): Promise<void> {
  const pool = createPoolFromEnv();
  const app = buildServer({ pool });

  const port = process.env['PORT'] ? Number(process.env['PORT']) : 3001;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API listening on http://localhost:${port}`);

  const shutdown = (): void => {
    void app
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
