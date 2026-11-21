import { z } from 'zod';
import type { Tx } from '../../lib/prisma';
import type { Ctx } from '../../auth/context';
import { nullableStr } from '../../lib/http';
import { audit } from '../../lib/audit';
import { badRequest } from '../../lib/errors';
import { NATURE_OF } from './chart';

export const accountBody = z.object({
  code: z.string().trim().min(1, 'رقم الحساب مطلوب').max(20).regex(/^[0-9A-Za-z.-]+$/, 'رقم الحساب: أرقام وأحرف إنجليزية فقط'),
  name: z.string().trim().min(2, 'اسم الحساب مطلوب').max(150),
  parentId: z.string().uuid().nullable().optional(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']).optional(),
  nature: z.enum(['DEBIT', 'CREDIT']).optional(),
  isGroup: z.boolean().optional(),
  description: nullableStr(500),
});

/** New account in the tree (screen and Excel import). A leaf that gets a child becomes a group, unless it already has entries. */
export async function createAccount(tx: Tx, ctx: Ctx, b: z.infer<typeof accountBody>) {
  if (await tx.account.findUnique({ where: { code: b.code } })) throw badRequest(`رقم الحساب ${b.code} مستخدم`);
  const parent = b.parentId ? await tx.account.findUnique({ where: { id: b.parentId } }) : null;
  if (b.parentId && !parent) throw badRequest('الحساب الأب غير موجود');
  if (parent && !parent.isGroup) {
    // A leaf becoming a parent must not already carry entries (they would be hidden under a total).
    if (await tx.journalLine.count({ where: { accountId: parent.id } })) throw badRequest(`«${parent.name}» عليه قيود؛ لا يمكن جعله حساباً رئيسياً`);
    await tx.account.update({ where: { id: parent.id }, data: { isGroup: true } });
  }
  const type = parent?.type ?? b.type;
  if (!type) throw badRequest('اختر نوع الحساب');
  if (parent && b.type && b.type !== parent.type) throw badRequest('نوع الحساب الفرعي يتبع نوع الحساب الأب');
  const created = await tx.account.create({ data: { code: b.code, name: b.name, type, nature: b.nature ?? (parent?.type === type && parent.nature !== NATURE_OF[type] ? parent.nature : NATURE_OF[type]), parentId: parent?.id ?? null, isGroup: !!b.isGroup, description: b.description } });
  await audit(tx, ctx, { action: 'account.create', entityType: 'account', entityId: created.id, summary: `${created.code} ${created.name}`, after: created });
  return created;
}
