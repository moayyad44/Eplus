import { env } from './config/env';
import { createApp } from './app';
import { prisma } from './lib/prisma';
import { startJobs } from './jobs/scanner';

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = app.listen(env.PORT, () => console.log(`EmergencyPlus API listening on :${env.PORT} (${env.NODE_ENV}, TZ=${env.TZ})`));
  const timer = env.DISABLE_JOBS ? null : startJobs();
  const shutdown = async () => {
    if (timer) clearInterval(timer);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
