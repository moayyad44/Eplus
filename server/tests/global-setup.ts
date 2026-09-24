import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Each test run gets its own throw-away database (never the dev/prod one):
 * created here, migrated with `migrate deploy`, bootstrapped + demo-seeded, and dropped on teardown.
 */
const BASE = process.env.TEST_DATABASE_BASE_URL ?? 'postgresql://eplus:eplus@localhost:5432';
const NAME = `eplus_test_${process.pid}_${Date.now()}`;

export default async function setup() {
  const admin = new PrismaClient({ datasourceUrl: `${BASE}/postgres` });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${NAME}"`);
  await admin.$disconnect();

  const url = `${BASE}/${NAME}?schema=public`;
  process.env.DATABASE_URL = url; // inherited by the test workers
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, ADMIN_PASSWORD: 'Admin@12345' };
  const run = (cmd: string) => execSync(cmd, { env, stdio: 'pipe', cwd: `${__dirname}/..` });
  run('npx prisma migrate deploy');
  run('npx tsx prisma/bootstrap.ts');
  run('npx tsx prisma/seed-dev.ts');

  return async () => {
    const c = new PrismaClient({ datasourceUrl: `${BASE}/postgres` });
    await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NAME}" WITH (FORCE)`);
    await c.$disconnect();
  };
}
