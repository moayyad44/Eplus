import type { Ctx } from '../auth/context';
import type { Db } from './prisma';
import { prisma } from './prisma';

const SECRET_KEYS = new Set(['passwordHash', 'password', 'refreshTokenHash']);

const clean = (v: unknown): unknown => {
  if (v === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(v, (k, val) => (SECRET_KEYS.has(k) ? '[redacted]' : val)),
  );
};

/** Keeps only the fields that actually changed, so the log shows a readable diff. */
const diff = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updatedAt') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { b, a };
};

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

export async function audit(db: Db, ctx: Pick<Ctx, 'userId' | 'userName' | 'ip' | 'userAgent'> | null, entry: AuditEntry) {
  let before = clean(entry.before);
  let after = clean(entry.after);
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before)) {
    const d = diff(before as Record<string, unknown>, after as Record<string, unknown>);
    before = d.b;
    after = d.a;
  }
  await (db ?? prisma).auditLog.create({
    data: {
      userId: ctx?.userId,
      userName: ctx?.userName ?? 'النظام',
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary,
      before: before as never,
      after: after as never,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
    },
  });
}
