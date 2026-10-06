import { defineConfig } from 'vitest/config';


export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    env: { NODE_ENV: 'test', DISABLE_JOBS: 'true', UPLOAD_DIR: './tests/.uploads', BACKUP_DIR: './tests/.backups', ADMIN_PASSWORD: 'Admin@12345' },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
