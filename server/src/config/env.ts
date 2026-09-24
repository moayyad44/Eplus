import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  CORS_ORIGIN: z.string().optional(),
  TZ: z.string().default('Asia/Amman'),
  WEB_DIST: z.string().optional(),
  TRUST_PROXY: z.coerce.number().default(0),
  DISABLE_JOBS: z.coerce.boolean().default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.startsWith('dev-only')) {
  console.error('Refusing to start in production with the development JWT_SECRET.');
  process.exit(1);
}

process.env.TZ = parsed.data.TZ;

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
