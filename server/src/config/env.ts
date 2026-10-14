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
  /** Folder shared with the backup container (docker-compose). Unset → backups are not managed by the app. */
  BACKUP_DIR: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  CORS_ORIGIN: z.string().optional(),
  TZ: z.string().default('Asia/Amman'),
  WEB_DIST: z.string().optional(),
  /**
   * Which reverse proxy to trust for X-Forwarded-* headers: 0 = none, a hop count, or (safest) the proxy's own
   * address, e.g. the Caddy container's fixed IP — so a device calling the app directly cannot spoof them.
   */
  TRUST_PROXY: z.string().default('0').transform((v): number | string => (/^\d+$/.test(v.trim()) ? Number(v) : v.trim())),
  /**
   * HTTPS-only cookies + HSTS. "auto" (default) decides per request: on for HTTPS through the proxy (the domain),
   * off for plain http on the clinic network (IP address), so both ways of reaching the app keep working.
   */
  SECURE_COOKIES: z.enum(['true', 'false', 'auto']).default('auto'),
  DISABLE_JOBS: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),
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
/** Whether this request came over HTTPS (directly or via the trusted proxy), honouring the SECURE_COOKIES override. */
export const isSecureRequest = (req: { secure: boolean }) => (env.SECURE_COOKIES === 'auto' ? req.secure : env.SECURE_COOKIES === 'true');
