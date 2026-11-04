import { Router } from 'express';
import { z } from 'zod';
import { Prisma, VoucherKind, VoucherMethod } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { can } from '../../auth/context';
import { getSetting } from '../../lib/settings';
import { D, r3 } from '../../lib/money';
import { dateOnlyStr } from '../../lib/dates';
import { dayOf } from './journal';
import { postDoc } from './link';
import { amountInWords, diffFields, docNumber, docRevision } from './common';
import { accountStatement } from './ledger';
import { createChequeForVoucher } from './cheques';
import { trackVisa } from './visa';

/** Cash boxes, bank accounts, receipt/payment vouchers, transfers between them, cash counts. */
export const treasuryRouter = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');

/** Ledger balance of an account up to a day (natural side). */
export async function balanceOf(db: Tx | typeof prisma, accountId: string, asOf?: Date) {
  const r = await db.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT SUM(l.debit - l.credit) v FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId"
    WHERE e.status = 'POSTED' AND l."accountId" = ${accountId} ${asOf ? Prisma.sql`AND e.date <= ${asOf}` : Prisma.empty}`;
  return D(r[0]?.v);
}

// ───────────── Treasuries ─────────────

treasuryRouter.get('/treasuries', requireAnyPerm('accounting.treasury.view', 'accounting.vouchers.view', 'accounting.vouchers.create', 'accounting.treasury.manage'), ah(async (_req, res) => {
  const rows = await prisma.treasury.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
  const accounts = await prisma.account.findMany({ where: { id: { in: rows.map((r) => r.accountId) } }, select: { id: true, code: true, name: true } });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.custodianId).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
  const out = await Promise.all(rows.map(async (t) => ({ ...t, account: accounts.find((a) => a.id === t.accountId), custodian: users.find((u) => u.id === t.custodianId)?.fullName ?? null, balance: (await balanceOf(prisma, t.accountId)).toNumber() })));
  res.json(out);
}));

const treasuryBody = z.object({
  kind: z.enum(['CASH', 'BANK']), name: z.string().trim().min(2, 'الاسم مطلوب').max(100), accountId: z.string().uuid().nullable().optional(),
  custodianId: z.string().uuid().nullable().optional(), bankName: nullableStr(100), branch: nullableStr(100), accountNumber: nullableStr(60), iban: nullableStr(40), holderName: nullableStr(150),
  currency: z.string().trim().max(3).default('JOD'), notes: nullableStr(500),
});

/** New box / bank: uses the chosen leaf account, or creates one under «cash in boxes» / «bank accounts». */
treasuryRouter.post('/treasuries', requirePerm('accounting.treasury.manage'), ah(async (req, res) => {
  const b = parse(treasuryBody, req.body);
  const t = await prisma.$transaction(async (tx) => {
    let accountId = b.accountId ?? null;
    if (accountId) {
      const a = await tx.account.findUnique({ where: { id: accountId } });
      if (!a || a.isGroup || a.type !== 'ASSET') throw badRequest('الحساب يجب أن يكون حساب أصول فرعياً');
      if (await tx.treasury.findUnique({ where: { accountId } })) throw badRequest('الحساب مربوط بصندوق أو بنك آخر');
    } else {
      const parent = await tx.account.findUniqueOrThrow({ where: { systemKey: b.kind === 'CASH' ? 'CASH_GROUP' : 'BANK_GROUP' } });
      const used = new Set((await tx.account.findMany({ select: { code: true } })).map((a) => a.code));
      let code = '';
      for (let i = 1; i < 100 && !code; i++) { const c = `${parent.code}${String(i).padStart(2, '0')}`; if (!used.has(c)) code = c; }
      const a = await tx.account.create({ data: { code, name: b.kind === 'BANK' && b.bankName ? `${b.bankName} — ${b.name}` : b.name, type: 'ASSET', nature: 'DEBIT', parentId: parent.id } });
      accountId = a.id;
    }
    const created = await tx.treasury.create({ data: { ...b, accountId } });
    await audit(tx, req.ctx, { action: 'treasury.create', entityType: 'treasury', entityId: created.id, summary: created.name, after: created });
    return created;
  });
  res.status(201).json(t);
}));

treasuryRouter.put('/treasuries/:id', requirePerm('accounting.treasury.manage'), ah(async (req, res) => {
  const b = parse(treasuryBody.omit({ kind: true, accountId: true }).partial().extend({ isActive: z.boolean().optional() }), req.body);
  const t = await prisma.$transaction(async (tx) => {
    const before = await tx.treasury.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    if (b.isActive === false && !(await balanceOf(tx, before.accountId)).eq(0)) throw badRequest('لا يمكن إيقاف صندوق أو حساب له رصيد؛ حوّل رصيده أولاً');
    const u = await tx.treasury.update({ where: { id: before.id }, data: b });
    await audit(tx, req.ctx, { action: 'treasury.update', entityType: 'treasury', entityId: u.id, summary: u.name, before, after: u });
    return u;
  });
  res.json(t);
}));

treasuryRouter.get('/treasuries/:id/statement', requireAnyPerm('accounting.treasury.view', 'accounting.reports.view'), ah(async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional() }), req.query);
  const t = await prisma.treasury.findUnique({ where: { id: req.params.id } });
  if (!t) throw notFound();
  const today = new Date().toLocaleDateString('en-CA');
  res.json({ treasury: t, ...(await accountStatement(t.accountId, dayOf(q.from ?? `${today.slice(0, 8)}01`), dayOf(q.to ?? today))) });
}));

// ───────────── Vouchers ─────────────

const voucherBody = z.object({
  kind: z.nativeEnum(VoucherKind), date: day, method: z.nativeEnum(VoucherMethod), treasuryId: z.string().uuid().nullable().optional(),
  amount: z.coerce.number().positive('المبلغ يجب أن يكون أكبر من صفر').max(100_000_000), counterAccountId: z.string().uuid('اختر الحساب المقابل'),
  partyType: nullableStr(20), partyId: nullableStr(60), partyName: z.string().trim().min(2, 'اسم الدافع / المستفيد مطلوب').max(150),
  purpose: z.string().trim().min(2, 'السبب مطلوب').max(300), reference: nullableStr(100), notes: nullableStr(1000), reason: nullableStr(300),
  cheque: z.object({ number: z.string().trim().min(1, 'رقم الشيك مطلوب').max(40), bankName: z.string().trim().min(2, 'البنك مطلوب').max(100), drawer: nullableStr(150), accountNumber: nullableStr(60), issueDate: day.nullable().optional(), dueDate: day }).optional(),
});
type VoucherInput = z.infer<typeof voucherBody>;
const snap = (v: Prisma.VoucherGetPayload<object>) => ({ date: dateOnlyStr(v.date), method: v.method, treasuryId: v.treasuryId, amount: D(v.amount).toNumber(), counterAccountId: v.counterAccountId, partyName: v.partyName, purpose: v.purpose, reference: v.reference, notes: v.notes, status: v.status });

async function checkVoucher(tx: Tx, b: VoucherInput) {
  if (b.kind === 'PAYMENT' && b.method === 'VISA') throw badRequest('الصرف بالفيزا غير متاح؛ اختر طريقة أخرى');
  const needsTreasury = !['VISA', 'CHEQUE'].includes(b.method) || (b.method === 'CHEQUE' && b.kind === 'PAYMENT');
  if (needsTreasury) {
    if (!b.treasuryId) throw badRequest(b.method === 'CHEQUE' ? 'اختر الحساب البنكي المسحوب عليه الشيك' : 'اختر الصندوق أو الحساب البنكي');
    const t = await tx.treasury.findUnique({ where: { id: b.treasuryId } });
    if (!t?.isActive) throw badRequest('الصندوق أو الحساب البنكي غير متاح');
    if (b.method === 'CASH' && t.kind !== 'CASH') throw badRequest('الدفع النقدي يكون من صندوق نقدي');
    if (['TRANSFER', 'CLIQ'].includes(b.method) && t.kind !== 'BANK') throw badRequest('التحويل وCliQ يكونان على حساب بنكي');
    if (b.method === 'CHEQUE' && t.kind !== 'BANK') throw badRequest('الشيك الصادر يُسحب على حساب بنكي');
  }
  const a = await tx.account.findUnique({ where: { id: b.counterAccountId } });
  if (!a || a.isGroup || !a.isActive) throw badRequest('الحساب المقابل يجب أن يكون حساباً فرعياً فعّالاً');
  if (b.method === 'CHEQUE' && !b.cheque) throw badRequest('أدخل بيانات الشيك');
}

treasuryRouter.get('/vouchers', requireAnyPerm('accounting.vouchers.view', 'accounting.vouchers.create'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ kind: z.nativeEnum(VoucherKind).optional(), method: z.nativeEnum(VoucherMethod).optional(), treasuryId: z.string().uuid().optional(), status: z.enum(['ACTIVE', 'CANCELLED']).optional(), from: day.optional(), to: day.optional() }), req.query);
  const where: Prisma.VoucherWhereInput = {
    ...(q.kind && { kind: q.kind }), ...(q.method && { method: q.method }), ...(q.treasuryId && { treasuryId: q.treasuryId }), ...(q.status && { status: q.status }),
    ...((q.from || q.to) && { date: { ...(q.from && { gte: dayOf(q.from) }), ...(q.to && { lte: dayOf(q.to) }) } }),
    ...(q.q && { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { partyName: { contains: q.q, mode: 'insensitive' } }, { purpose: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] }),
  };
  const [items, total, sum] = await Promise.all([
    prisma.voucher.findMany({ where, orderBy: [{ date: 'desc' }, { number: 'desc' }], ...paginate(q) }),
    prisma.voucher.count({ where }),
    prisma.voucher.aggregate({ where: { ...where, status: 'ACTIVE' }, _sum: { amount: true } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.createdById).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
  res.json({ ...paged(items.map((v) => ({ ...v, date: dateOnlyStr(v.date), createdBy: users.find((u) => u.id === v.createdById)?.fullName ?? null })), total, q), totalAmount: sum._sum.amount ?? 0 });
}));

treasuryRouter.get('/vouchers/:id', requireAnyPerm('accounting.vouchers.view', 'accounting.vouchers.create'), ah(async (req, res) => {
  const v = await prisma.voucher.findUnique({ where: { id: req.params.id } });
  if (!v) throw notFound('السند غير موجود');
  const [treasury, counter, entry, revisions, cheque, clinic] = await Promise.all([
    v.treasuryId ? prisma.treasury.findUnique({ where: { id: v.treasuryId } }) : null,
    prisma.account.findUnique({ where: { id: v.counterAccountId }, select: { code: true, name: true } }),
    prisma.journalEntry.findUnique({ where: { sourceKey: `voucher:${v.id}` }, select: { id: true, number: true, status: true } }),
    prisma.docRevision.findMany({ where: { docType: 'voucher', docId: v.id }, orderBy: { createdAt: 'asc' } }),
    v.chequeId ? prisma.cheque.findUnique({ where: { id: v.chequeId } }) : null,
    getSetting('clinic'),
  ]);
  const ids = [v.createdById, v.updatedById, v.cancelledById, ...revisions.map((r) => r.userId)].filter(Boolean) as string[];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.fullName ?? null;
  res.json({
    ...v, date: dateOnlyStr(v.date), treasury, counterAccount: counter, entry, cheque, amountWords: amountInWords(D(v.amount).toNumber()),
    createdBy: name(v.createdById), updatedBy: name(v.updatedById), cancelledBy: name(v.cancelledById),
    revisions: revisions.map((r) => ({ ...r, user: name(r.userId) })), clinic: { name: clinic.name, nameEn: clinic.nameEn, address: clinic.address, phone: clinic.phone, hasLogo: !!clinic.logoKey },
  });
}));

/** Issue a voucher: saved and posted together (a closed period refuses both). */
treasuryRouter.post('/vouchers', requirePerm('accounting.vouchers.create'), ah(async (req, res) => {
  const b = parse(voucherBody, req.body);
  const v = await prisma.$transaction(async (tx) => {
    await checkVoucher(tx, b);
    const number = await docNumber(tx, b.kind === 'RECEIPT' ? 'RV' : 'PV');
    const { cheque, reason: _r, ...data } = b;
    const created = await tx.voucher.create({ data: { ...data, number, date: dayOf(b.date), amount: r3(b.amount), treasuryId: b.method === 'VISA' || (b.method === 'CHEQUE' && b.kind === 'RECEIPT') ? null : b.treasuryId ?? null, createdById: req.ctx.userId } });
    if (cheque) await createChequeForVoucher(tx, req.ctx, created, cheque);
    if (b.method === 'VISA') await trackVisa(tx, 'voucher', created.id);
    await postDoc(tx, 'voucher', created.id);
    await docRevision(tx, 'voucher', created.id, 1, 'create', snap(created), req.ctx.userId);
    await audit(tx, req.ctx, { action: 'voucher.create', entityType: 'voucher', entityId: created.id, summary: `${number}: ${b.partyName} — ${b.amount}` });
    return created;
  });
  res.status(201).json(v);
}));

/** Edit after posting: the entry follows; old and new values are kept (reason optional unless required by the settings). */
treasuryRouter.put('/vouchers/:id', requirePerm('accounting.vouchers.edit'), ah(async (req, res) => {
  const b = parse(voucherBody, req.body);
  const v = await prisma.$transaction(async (tx) => {
    const before = await tx.voucher.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    if (before.status === 'CANCELLED') throw badRequest('السند ملغى');
    if (b.kind !== before.kind) throw badRequest('لا يمكن تغيير نوع السند');
    if ((await getSetting('accounting', tx)).requireReason && !b.reason) throw badRequest('سبب التعديل مطلوب');
    if (before.chequeId || b.method === 'CHEQUE') {
      if (b.method !== before.method || b.amount !== D(before.amount).toNumber()) throw badRequest('سند الشيك: عدّل الشيك من شاشة الشيكات، أو ألغِ السند وأصدر غيره');
    }
    await checkVoucher(tx, b);
    const { cheque: _c, reason, ...data } = b;
    const updated = await tx.voucher.update({ where: { id: before.id }, data: { ...data, date: dayOf(b.date), amount: r3(b.amount), treasuryId: b.method === 'VISA' || (b.method === 'CHEQUE' && b.kind === 'RECEIPT') ? null : b.treasuryId ?? null, updatedById: req.ctx.userId, version: { increment: 1 } } });
    if (b.method === 'VISA' || before.method === 'VISA') await trackVisa(tx, 'voucher', updated.id);
    await postDoc(tx, 'voucher', updated.id);
    const changes = diffFields(snap(before), snap(updated));
    await docRevision(tx, 'voucher', updated.id, updated.version, 'update', snap(updated), req.ctx.userId, changes, reason);
    await audit(tx, req.ctx, { action: 'voucher.update', entityType: 'voucher', entityId: updated.id, summary: `${updated.number}: تعديل ${changes.map((c) => c.field).join('، ')}${reason ? ` — ${reason}` : ''}`, before: snap(before), after: snap(updated) });
    return updated;
  });
  res.json(v);
}));

/** Cancel (never deleted): its entry is removed (or reversed in a closed period); the voucher and its history stay. */
treasuryRouter.post('/vouchers/:id/cancel', requirePerm('accounting.vouchers.cancel'), ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: nullableStr(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const v = await tx.voucher.findUnique({ where: { id: req.params.id } });
    if (!v) throw notFound();
    if (v.status === 'CANCELLED') throw badRequest('السند ملغى مسبقاً');
    if ((await getSetting('accounting', tx)).requireReason && !reason) throw badRequest('سبب الإلغاء مطلوب');
    if (v.chequeId) {
      const c = await tx.cheque.findUniqueOrThrow({ where: { id: v.chequeId } });
      if (!['RECEIVED', 'IN_SAFE', 'READY', 'ISSUED', 'DRAFT', 'DELIVERED'].includes(c.status)) throw badRequest('الشيك المرتبط تحركت حالته (أودع / صُرف…)؛ عالجه من شاشة الشيكات');
      await tx.cheque.update({ where: { id: c.id }, data: { status: 'CANCELLED' } });
      await tx.chequeEvent.create({ data: { chequeId: c.id, fromStatus: c.status, toStatus: 'CANCELLED', date: v.date, note: `إلغاء السند ${v.number}`, userId: req.ctx.userId } });
    }
    const u = await tx.voucher.update({ where: { id: v.id }, data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date(), cancelledById: req.ctx.userId, version: { increment: 1 } } });
    if (v.method === 'VISA') await trackVisa(tx, 'voucher', v.id);
    await postDoc(tx, 'voucher', v.id);
    await docRevision(tx, 'voucher', v.id, u.version, 'cancel', snap(u), req.ctx.userId, undefined, reason);
    await audit(tx, req.ctx, { action: 'voucher.cancel', entityType: 'voucher', entityId: v.id, summary: `${v.number}: إلغاء${reason ? ` — ${reason}` : ''}` });
  });
  res.json({ ok: true });
}));

// ───────────── Transfers between treasuries ─────────────

treasuryRouter.get('/transfers', requireAnyPerm('accounting.treasury.view', 'accounting.treasury.manage'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ treasuryId: z.string().uuid().optional() }), req.query);
  const where: Prisma.TreasuryTransferWhereInput = q.treasuryId ? { OR: [{ fromId: q.treasuryId }, { toId: q.treasuryId }] } : {};
  const [items, total, ts] = await Promise.all([prisma.treasuryTransfer.findMany({ where, orderBy: { date: 'desc' }, ...paginate(q) }), prisma.treasuryTransfer.count({ where }), prisma.treasury.findMany({ select: { id: true, name: true } })]);
  res.json(paged(items.map((t) => ({ ...t, date: dateOnlyStr(t.date), from: ts.find((x) => x.id === t.fromId)?.name, to: ts.find((x) => x.id === t.toId)?.name })), total, q));
}));

treasuryRouter.post('/transfers', requirePerm('accounting.treasury.manage'), ah(async (req, res) => {
  const b = parse(z.object({ date: day, fromId: z.string().uuid('اختر المصدر'), toId: z.string().uuid('اختر الوجهة'), amount: z.coerce.number().positive().max(100_000_000), fee: z.coerce.number().min(0).default(0), reference: nullableStr(100), notes: nullableStr(500) }), req.body);
  if (b.fromId === b.toId) throw badRequest('المصدر والوجهة متطابقان');
  const t = await prisma.$transaction(async (tx) => {
    const [f, to] = await Promise.all([tx.treasury.findUnique({ where: { id: b.fromId } }), tx.treasury.findUnique({ where: { id: b.toId } })]);
    if (!f?.isActive || !to?.isActive) throw badRequest('الصندوق أو الحساب غير متاح');
    const created = await tx.treasuryTransfer.create({ data: { ...b, date: dayOf(b.date), amount: r3(b.amount), fee: r3(b.fee), number: await docNumber(tx, 'TT'), createdById: req.ctx.userId } });
    await postDoc(tx, 'transfer', created.id);
    await docRevision(tx, 'transfer', created.id, 1, 'create', { ...b }, req.ctx.userId);
    await audit(tx, req.ctx, { action: 'treasury.transfer', entityType: 'treasury_transfer', entityId: created.id, summary: `${created.number}: ${f.name} → ${to.name} ${b.amount}` });
    return created;
  });
  res.status(201).json(t);
}));

treasuryRouter.post('/transfers/:id/cancel', requirePerm('accounting.treasury.manage'), ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: nullableStr(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const t = await tx.treasuryTransfer.findUnique({ where: { id: req.params.id } });
    if (!t || t.status === 'CANCELLED') throw badRequest('التحويل غير موجود أو ملغى');
    await tx.treasuryTransfer.update({ where: { id: t.id }, data: { status: 'CANCELLED', cancelReason: reason } });
    await postDoc(tx, 'transfer', t.id);
    await docRevision(tx, 'transfer', t.id, 2, 'cancel', {}, req.ctx.userId, undefined, reason);
    await audit(tx, req.ctx, { action: 'treasury.transfer_cancel', entityType: 'treasury_transfer', entityId: t.id, summary: `${t.number}: إلغاء${reason ? ` — ${reason}` : ''}` });
  });
  res.json({ ok: true });
}));

// ───────────── Cash counts / daily close ─────────────

export const DENOMS = [50, 20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005];

treasuryRouter.get('/cash-counts', requireAnyPerm('accounting.cash.count', 'accounting.cash.approve', 'accounting.treasury.view'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ treasuryId: z.string().uuid().optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }), req.query);
  const where: Prisma.CashCountWhereInput = { ...(q.treasuryId && { treasuryId: q.treasuryId }), ...(q.status && { status: q.status }) };
  const [items, total, ts] = await Promise.all([prisma.cashCount.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }), prisma.cashCount.count({ where }), prisma.treasury.findMany({ select: { id: true, name: true } })]);
  const users = await prisma.user.findMany({ where: { id: { in: items.flatMap((i) => [i.countedById, i.approvedById]).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.fullName ?? null;
  res.json(paged(items.map((c) => ({ ...c, date: dateOnlyStr(c.date), treasury: ts.find((t) => t.id === c.treasuryId)?.name, countedBy: name(c.countedById), approvedBy: name(c.approvedById) })), total, q));
}));

/** Count: the system compares the money counted with the book balance. Nothing changes in the books yet. */
treasuryRouter.post('/cash-counts', requirePerm('accounting.cash.count'), ah(async (req, res) => {
  const b = parse(z.object({ treasuryId: z.string().uuid(), date: day, isClose: z.boolean().default(false), denominations: z.record(z.string(), z.coerce.number().int().min(0).max(1_000_000)), reason: nullableStr(500) }), req.body);
  const c = await prisma.$transaction(async (tx) => {
    const t = await tx.treasury.findUnique({ where: { id: b.treasuryId } });
    if (!t || t.kind !== 'CASH') throw badRequest('الجرد للصناديق النقدية فقط');
    if (t.custodianId && t.custodianId !== req.ctx.userId && !can(req.ctx, 'accounting.cash.approve')) throw forbidden('هذا الصندوق بعهدة موظف آخر');
    const counted = r3(Object.entries(b.denominations).reduce((s, [k, n]) => s.add(D(k).mul(n)), D(0)));
    const book = await balanceOf(tx, t.accountId, dayOf(b.date));
    const difference = counted.sub(book);
    if (!difference.eq(0) && !b.reason) throw badRequest(`يوجد ${difference.gt(0) ? 'زيادة' : 'عجز'} بقيمة ${difference.abs().toFixed(3)}؛ اذكر السبب`);
    const created = await tx.cashCount.create({ data: { number: await docNumber(tx, 'CC'), treasuryId: t.id, date: dayOf(b.date), denominations: b.denominations, counted, book, difference, reason: b.reason, isClose: b.isClose, countedById: req.ctx.userId, status: difference.eq(0) ? 'APPROVED' : 'PENDING', ...(difference.eq(0) && { approvedAt: new Date() }) } });
    await audit(tx, req.ctx, { action: 'cash.count', entityType: 'cash_count', entityId: created.id, summary: `${created.number} ${t.name}: فعلي ${counted.toFixed(3)} / دفتري ${book.toFixed(3)}` });
    return created;
  });
  res.status(201).json(c);
}));

/** Approve (a difference then becomes an adjustment entry) or reject. */
treasuryRouter.post('/cash-counts/:id/decide', requirePerm('accounting.cash.approve'), ah(async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), note: nullableStr(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const c = await tx.cashCount.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound();
    if (c.status !== 'PENDING') throw badRequest('تم البت في هذا الجرد');
    await tx.cashCount.update({ where: { id: c.id }, data: { status: b.approve ? 'APPROVED' : 'REJECTED', approvedById: req.ctx.userId, approvedAt: new Date(), decisionNote: b.note } });
    if (b.approve) await postDoc(tx, 'cash-count', c.id);
    await audit(tx, req.ctx, { action: b.approve ? 'cash.count_approve' : 'cash.count_reject', entityType: 'cash_count', entityId: c.id, summary: `${c.number}: ${b.approve ? 'اعتماد' : 'رفض'} فرق ${D(c.difference).toFixed(3)}` });
  });
  res.json({ ok: true });
}));

