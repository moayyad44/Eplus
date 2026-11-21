import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { D, r3 } from '../../lib/money';
import { dateOnlyStr } from '../../lib/dates';
import { dayOf, ensureOpenPeriod } from './journal';
import { postDoc } from './link';
import { docNumber } from './common';

/** Fixed assets: purchase, monthly depreciation (straight line or declining balance), disposal or sale with gain / loss. */
export const assetsRouter = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Depreciation of one asset for one month, given what is already depreciated. */
export function monthlyDepreciation(a: { cost: unknown; salvage: unknown; usefulLifeMonths: number; method: string; rate: unknown }, done: number) {
  const base = D(a.cost as never).sub(a.salvage as never);
  const left = base.sub(done);
  if (left.lte(0)) return D(0);
  const v = a.method === 'DECLINING' ? D(a.cost as never).sub(done).mul(D((a.rate as never) ?? 0).div(100)).div(12) : base.div(a.usefulLifeMonths);
  return r3(v.gt(left) ? left : v);
}

async function view(id: string) {
  const a = await prisma.fixedAsset.findUnique({ where: { id }, include: { depreciations: { orderBy: { month: 'asc' } } } });
  if (!a) throw notFound('الأصل غير موجود');
  const acc = a.depreciations.reduce((t, d) => t.add(d.amount), D(0));
  return { ...a, purchaseDate: dateOnlyStr(a.purchaseDate), disposedAt: a.disposedAt && dateOnlyStr(a.disposedAt), accumulated: acc.toNumber(), bookValue: D(a.cost).sub(acc).toNumber() };
}

assetsRouter.get('/assets', requireAnyPerm('accounting.assets.manage', 'accounting.reports.view'), ah(async (_req, res) => {
  const rows = await prisma.fixedAsset.findMany({ orderBy: { code: 'asc' }, include: { depreciations: { select: { amount: true } } } });
  const accounts = await prisma.account.findMany({ where: { id: { in: rows.map((r) => r.accountId) } }, select: { id: true, name: true } });
  res.json(rows.map((a) => { const acc = a.depreciations.reduce((t, d) => t.add(d.amount), D(0)); return { ...a, depreciations: undefined, purchaseDate: dateOnlyStr(a.purchaseDate), disposedAt: a.disposedAt && dateOnlyStr(a.disposedAt), category: accounts.find((x) => x.id === a.accountId)?.name, accumulated: acc.toNumber(), bookValue: D(a.cost).sub(acc).toNumber() }; }));
}));
assetsRouter.get('/assets/:id', requireAnyPerm('accounting.assets.manage', 'accounting.reports.view'), ah(async (req, res) => res.json(await view(req.params.id))));

const assetBody = z.object({
  name: z.string().trim().min(2).max(150), accountId: z.string().uuid('اختر فئة الأصل (حسابه)'), purchaseDate: day, cost: z.coerce.number().positive(), salvage: z.coerce.number().min(0).default(0),
  usefulLifeMonths: z.coerce.number().int().min(1).max(600), method: z.enum(['STRAIGHT_LINE', 'DECLINING']).default('STRAIGHT_LINE'), rate: z.coerce.number().min(0).max(100).nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(), fundingAccountId: z.string().uuid('اختر الحساب الممول (صندوق، بنك أو الموردون)'), location: nullableStr(150), notes: nullableStr(500),
});

assetsRouter.post('/assets', requirePerm('accounting.assets.manage'), ah(async (req, res) => {
  const b = parse(assetBody, req.body);
  if (b.salvage >= b.cost) throw badRequest('القيمة المتبقية يجب أن تكون أقل من التكلفة');
  if (b.method === 'DECLINING' && !b.rate) throw badRequest('حدّد نسبة الإهلاك للقسط المتناقص');
  const a = await prisma.$transaction(async (tx) => {
    const acc = await tx.account.findUnique({ where: { id: b.accountId }, include: { parent: true } });
    if (!acc || acc.isGroup || acc.type !== 'ASSET') throw badRequest('فئة الأصل يجب أن تكون حساب أصول فرعياً');
    const created = await tx.fixedAsset.create({ data: { ...b, code: await docNumber(tx, 'FA', 4), purchaseDate: dayOf(b.purchaseDate), cost: r3(b.cost), salvage: r3(b.salvage), createdById: req.ctx.userId } });
    await postDoc(tx, 'asset', created.id);
    await audit(tx, req.ctx, { action: 'asset.create', entityType: 'fixed_asset', entityId: created.id, summary: `${created.code} ${created.name}: ${b.cost}` });
    return created;
  });
  res.status(201).json(await view(a.id));
}));

assetsRouter.put('/assets/:id', requirePerm('accounting.assets.manage'), ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(150), location: nullableStr(150), notes: nullableStr(500), usefulLifeMonths: z.coerce.number().int().min(1).max(600), salvage: z.coerce.number().min(0), rate: z.coerce.number().min(0).max(100).nullable() }).partial(), req.body);
  const before = await prisma.fixedAsset.findUnique({ where: { id: req.params.id } });
  if (!before) throw notFound();
  if (b.salvage !== undefined && b.salvage >= D(before.cost).toNumber()) throw badRequest('القيمة المتبقية يجب أن تكون أقل من التكلفة');
  const a = await prisma.fixedAsset.update({ where: { id: before.id }, data: b });
  await audit(prisma, req.ctx, { action: 'asset.update', entityType: 'fixed_asset', entityId: a.id, summary: `${a.code} ${a.name}`, before, after: a });
  res.json(await view(a.id));
}));

/** Depreciation for a month: one line per active asset bought before the month ends, one entry for the month. Re-running a month recalculates it. */
assetsRouter.post('/assets/depreciation', requirePerm('accounting.assets.manage'), ah(async (req, res) => {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0));
  const r = await prisma.$transaction(async (tx) => {
    await ensureOpenPeriod(tx, end);
    const assets = await tx.fixedAsset.findMany({ where: { purchaseDate: { lte: end }, OR: [{ status: 'ACTIVE' }, { disposedAt: { gt: end } }] }, include: { depreciations: true } });
    await tx.assetDepreciation.deleteMany({ where: { month } });
    let n = 0, total = D(0);
    for (const a of assets) {
      const done = a.depreciations.filter((d) => d.month < month).reduce((t, d) => t.add(d.amount), D(0)).toNumber();
      const v = monthlyDepreciation(a, done);
      if (v.gt(0)) { await tx.assetDepreciation.create({ data: { assetId: a.id, month, amount: v } }); n++; total = total.add(v); }
    }
    await postDoc(tx, 'depreciation', month);
    await audit(tx, req.ctx, { action: 'asset.depreciation', entityType: 'fixed_asset', entityId: month, summary: `إهلاك ${month}: ${n} أصل بقيمة ${total.toFixed(3)}` });
    return { month, assets: n, total: total.toNumber() };
  });
  res.json(r);
}));

assetsRouter.post('/assets/:id/dispose', requirePerm('accounting.assets.manage'), ah(async (req, res) => {
  const b = parse(z.object({ date: day, sold: z.boolean(), proceeds: z.coerce.number().min(0).default(0), proceedsAccountId: z.string().uuid().nullable().optional(), notes: nullableStr(300) }), req.body);
  if (b.sold && (!b.proceeds || !b.proceedsAccountId)) throw badRequest('أدخل مبلغ البيع والحساب الذي قُبض فيه');
  await prisma.$transaction(async (tx) => {
    const a = await tx.fixedAsset.findUnique({ where: { id: req.params.id } });
    if (!a || a.status !== 'ACTIVE') throw badRequest('الأصل غير موجود أو مستبعد');
    const month = b.date.slice(0, 7);
    if (await tx.assetDepreciation.findFirst({ where: { assetId: a.id, month: { gt: month } } })) throw badRequest('للأصل إهلاك مسجل بعد تاريخ الاستبعاد');
    await tx.fixedAsset.update({ where: { id: a.id }, data: { status: b.sold ? 'SOLD' : 'DISPOSED', disposedAt: dayOf(b.date), proceeds: b.sold ? r3(b.proceeds) : 0, proceedsAccountId: b.sold ? b.proceedsAccountId : null, notes: b.notes ?? a.notes } });
    await postDoc(tx, 'asset-disposal', a.id);
    await audit(tx, req.ctx, { action: 'asset.dispose', entityType: 'fixed_asset', entityId: a.id, summary: `${a.code}: ${b.sold ? `بيع بـ ${b.proceeds}` : 'استبعاد'}` });
  });
  res.json(await view(req.params.id));
}));
