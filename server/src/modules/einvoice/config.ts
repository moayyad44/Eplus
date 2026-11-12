import { z } from 'zod';
import type { Db } from '../../lib/prisma';
import { prisma } from '../../lib/prisma';
import { env, isProd } from '../../config/env';
import { seal, unseal, type Sealed } from '../../lib/secrets';

/** Official endpoint (ISTD technical guide v1.5, section 8-A). */
export const OFFICIAL_URL = 'https://backend.jofotara.gov.jo/core/invoices/';
const KEY = 'jofotara';

const sealed = z.object({ v: z.literal(1), iv: z.string(), tag: z.string(), data: z.string() });
const stored = z.object({
  enabled: z.boolean().default(false),
  /** Seller tax number (الرقم الضريبي). */
  taxNumber: z.string().default(''),
  /** Seller name exactly as registered at the Income and Sales Tax Department. */
  sellerName: z.string().default(''),
  /** Income source sequence (تسلسل مصدر الدخل) chosen when linking the device. */
  incomeSourceSeq: z.string().default(''),
  /**
   * Invoice form required by the registration of this income source at the national system: INCOME (not registered
   * in general sales tax → «فاتورة دخل» 011/021) or SALES (registered → «فاتورة مبيعات عامة» 012/022). A mismatch is
   * refused with "This user is not authorized to submit this type of invoice" (guide p. 101).
   */
  scheme: z.enum(['INCOME', 'SALES']).default('SALES'),
  /** Category for 0% lines: Z = exempt (معفى), O = zero-rated (خاضع لنسبة الصفر). */
  zeroCategory: z.enum(['Z', 'O']).default('Z'),
  timeoutSec: z.number().int().min(5).max(120).default(30),
  clientIdEnc: sealed.nullable().default(null),
  secretKeyEnc: sealed.nullable().default(null),
  clientIdHint: z.string().default(''),
  credentialsUpdatedAt: z.string().nullable().default(null),
});
export type StoredConfig = z.infer<typeof stored>;

export async function loadStored(db: Db = prisma): Promise<StoredConfig> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const p = stored.safeParse(row?.value ?? {});
  return p.success ? p.data : stored.parse({});
}

export async function saveStored(db: Db, value: StoredConfig, userId: string | null) {
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value, updatedBy: userId }, update: { value, updatedBy: userId } });
}

/** Endpoint actually used: the official one only in production; elsewhere only an explicit (mock) override. */
export function endpoint(): string | null {
  if (env.JOFOTARA_API_URL) {
    const host = new URL(env.JOFOTARA_API_URL).hostname.toLowerCase();
    if (!isProd && (host === 'jofotara.gov.jo' || host.endsWith('.jofotara.gov.jo'))) return null;
    return env.JOFOTARA_API_URL;
  }
  return isProd ? OFFICIAL_URL : null;
}

/** What is missing before anything can be sent (empty = ready). */
export function missing(c: StoredConfig): string[] {
  const m: string[] = [];
  if (!/^\d{5,15}$/.test(c.taxNumber)) m.push('الرقم الضريبي للعيادة');
  if (!c.sellerName.trim()) m.push('اسم البائع كما هو مسجل في الضريبة');
  if (!/^\d{1,20}$/.test(c.incomeSourceSeq)) m.push('تسلسل مصدر الدخل');
  if (!c.clientIdEnc) m.push('رقم المستخدم (Client ID)');
  if (!c.secretKeyEnc) m.push('المفتاح السري (Secret Key)');
  return m;
}

export interface Credentials { clientId: string; secretKey: string }
/** Server-side only. Never logged, never returned by the API. */
export function credentials(c: StoredConfig): Credentials | null {
  const clientId = unseal(c.clientIdEnc as Sealed | null);
  const secretKey = unseal(c.secretKeyEnc as Sealed | null);
  return clientId && secretKey ? { clientId, secretKey } : null;
}

export const sealValue = seal;

/** Safe view for the settings screen: no credential is ever sent back, only whether one is stored. */
export function publicView(c: StoredConfig) {
  const creds = credentials(c);
  return {
    enabled: c.enabled, taxNumber: c.taxNumber, sellerName: c.sellerName, incomeSourceSeq: c.incomeSourceSeq,
    scheme: c.scheme, zeroCategory: c.zeroCategory, timeoutSec: c.timeoutSec,
    hasClientId: !!c.clientIdEnc, hasSecretKey: !!c.secretKeyEnc, clientIdHint: c.clientIdHint,
    credentialsReadable: !c.clientIdEnc || !c.secretKeyEnc || !!creds,
    credentialsUpdatedAt: c.credentialsUpdatedAt,
    endpoint: endpoint(), official: endpoint() === OFFICIAL_URL,
    missing: missing(c),
  };
}
