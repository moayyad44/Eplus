import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Prisma, VisaStatus } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { getSetting } from '../../lib/settings';
import { D, r3 } from '../../lib/money';
import { addDays, dateOnlyStr } from '../../lib/dates';
import { dayOf } from './journal';
import { postDoc } from './link';
import { docNumber } from './common';
import { readTable, toAmount } from './xlsx';

/**
 * The Visa box: every card payment is followed from the swipe until the money reaches the bank. A card payment
 * sits in «Visa clearing» (never in the bank) until a settlement from the card company covers it; one settlement
 * may cover many payments, a payment may be covered by several settlements (partial), and the fee is kept apart.
 */
export const visaRouter = Router();

/** Keep the card-payment record of a payment / receipt voucher in step with it. Call inside its transaction. */
export async function trackVisa(tx: Tx, sourceType: 'payment' | 'voucher', id: string) {
  const existing = await tx.visaTransaction.findUnique({ where: { sourceType_sourceId: { sourceType, sourceId: id } } });
  let data: { date: Date; amount: Prisma.Decimal; posReference: string | null; invoiceNumber: string | null; patientName: string | null; recordedBy: string | null; status: VisaStatus } | null = null;
  if (sourceType === 'payment') {
    const p = await tx.payment.findUnique({ where: { id }, include: { method: true, invoice: { select: { invoiceNumber: true } }, patient: { select: { fullName: true } } } });
    if (p && p.method.code === 'VISA') {
      const by = p.receivedById ? (await tx.user.findUnique({ where: { id: p.receivedById }, select: { fullName: true } }))?.fullName ?? null : null;
      data = { date: p.paidAt, amount: D(p.amount), posReference: p.reference, invoiceNumber: p.invoice.invoiceNumber, patientName: p.patient.fullName, recordedBy: by, status: p.voidedAt ? 'CANCELLED' : p.type === 'REFUND' ? 'REFUNDED' : 'PENDING' };
    }
  } else {
    const v = await tx.voucher.findUnique({ where: { id } });
    if (v && v.method === 'VISA' && v.kind === 'RECEIPT') data = { date: v.date, amount: D(v.amount), posReference: v.reference, invoiceNumber: v.reference, patientName: v.partyName, recordedBy: null, status: v.status === 'CANCELLED' ? 'CANCELLED' : 'PENDING' };
  }
  if (!data) {
    if (existing && D(existing.settled).eq(0)) await tx.visaTransaction.delete({ where: { id: existing.id } });
    else if (existing) await tx.visaTransaction.update({ where: { id: existing.id }, data: { status: 'REVIEW', notes: 'تغيرت طريقة الدفع بعد التسوية' } });
    return;
  }
  const t = existing
    ? await tx.visaTransaction.update({ where: { id: existing.id }, data: { ...data, status: existing.status === 'REVIEW' ? 'REVIEW' : data.status } })
    : await tx.visaTransaction.create({ data: { ...data, sourceType, sourceId: id } });
  if (['CANCELLED', 'REFUNDED'].includes(data.status) && D(t.settled).gt(0)) await tx.visaTransaction.update({ where: { id: t.id }, data: { status: 'REVIEW', notes: 'أُلغيت أو استُردت بعد إدراجها في تسوية' } });
  else if (data.status === 'PENDING') await recompute(tx, t.id);
}

/** Settled amount and status from the active settlements that cover it. */
async function recompute(tx: Tx, id: string) {
  const t = await tx.visaTransaction.findUniqueOrThrow({ where: { id } });
  const s = await tx.visaSettlementLine.aggregate({ where: { transactionId: id, settlement: { status: 'ACTIVE' } }, _sum: { amount: true } });
  const settled = D(s._sum.amount);
  const status: VisaStatus = ['CANCELLED', 'REFUNDED', 'REVIEW'].includes(t.status) ? t.status : settled.eq(0) ? 'PENDING' : settled.lt(t.amount) ? 'PARTIAL' : 'SETTLED';
  await tx.visaTransaction.update({ where: { id }, data: { settled, status } });
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

visaRouter.get('/visa/summary', requireAnyPerm('accounting.visa.manage', 'accounting.reports.view'), ah(async (_req, res) => {
  const { visaLateDays } = await getSetting('accounting');
  const late = addDays(new Date(), -visaLateDays);
  const [open, lateAgg, settlements, review, cancelled] = await Promise.all([
    prisma.visaTransaction.aggregate({ where: { status: { in: ['PENDING', 'PARTIAL'] } }, _sum: { amount: true, settled: true }, _count: true }),
    prisma.visaTransaction.aggregate({ where: { status: { in: ['PENDING', 'PARTIAL'] }, date: { lt: late } }, _sum: { amount: true, settled: true }, _count: true }),
    prisma.visaSettlement.aggregate({ where: { status: 'ACTIVE' }, _sum: { gross: true, fee: true, net: true }, _count: true }),
    prisma.visaTransaction.count({ where: { status: 'REVIEW' } }),
    prisma.visaTransaction.aggregate({ where: { status: { in: ['CANCELLED', 'REFUNDED'] } }, _sum: { amount: true }, _count: true }),
  ]);
  res.json({
    notReached: D(open._sum.amount).sub(D(open._sum.settled)).toNumber(), notReachedCount: open._count,
    late: D(lateAgg._sum.amount).sub(D(lateAgg._sum.settled)).toNumber(), lateCount: lateAgg._count, lateDays: visaLateDays,
    reached: D(settlements._sum.net).toNumber(), settledGross: D(settlements._sum.gross).toNumber(), fees: D(settlements._sum.fee).toNumber(), settlements: settlements._count,
    review, cancelledOrRefunded: D(cancelled._sum.amount).toNumber(),
  });
}));

visaRouter.get('/visa/transactions', requireAnyPerm('accounting.visa.manage', 'accounting.reports.view'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.string().optional(), from: day.optional(), to: day.optional(), late: z.enum(['true']).optional() }), req.query);
  const { visaLateDays } = await getSetting('accounting');
  const statuses = q.status ? (q.status.split(',') as VisaStatus[]) : undefined;
  const where: Prisma.VisaTransactionWhereInput = {
    ...(statuses && { status: { in: statuses } }),
    ...((q.from || q.to) && { date: { ...(q.from && { gte: new Date(`${q.from}T00:00:00`) }), ...(q.to && { lte: new Date(`${q.to}T23:59:59.999`) }) } }),
    ...(q.late && { status: { in: ['PENDING', 'PARTIAL'] }, date: { lt: addDays(new Date(), -visaLateDays) } }),
    ...(q.q && { OR: [{ posReference: { contains: q.q, mode: 'insensitive' } }, { invoiceNumber: { contains: q.q, mode: 'insensitive' } }, { patientName: { contains: q.q, mode: 'insensitive' } }] }),
  };
  const [items, total, sum] = await Promise.all([
    prisma.visaTransaction.findMany({ where, orderBy: { date: 'desc' }, ...paginate(q), include: { lines: { include: { settlement: { select: { id: true, number: true, date: true, status: true } } } } } }),
    prisma.visaTransaction.count({ where }),
    prisma.visaTransaction.aggregate({ where, _sum: { amount: true, settled: true } }),
  ]);
  const now = Date.now();
  res.json({ ...paged(items.map((t) => ({ ...t, remaining: D(t.amount).sub(t.settled).toNumber(), ageDays: Math.floor((now - t.date.getTime()) / 86_400_000), late: ['PENDING', 'PARTIAL'].includes(t.status) && now - t.date.getTime() > visaLateDays * 86_400_000 })), total, q), totalAmount: sum._sum.amount ?? 0, totalSettled: sum._sum.settled ?? 0 });
}));

visaRouter.post('/visa/transactions/:id/review', requirePerm('accounting.visa.manage'), ah(async (req, res) => {
  const b = parse(z.object({ review: z.boolean(), note: nullableStr(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const t = await tx.visaTransaction.findUnique({ where: { id: req.params.id } });
    if (!t) throw notFound();
    await tx.visaTransaction.update({ where: { id: t.id }, data: { status: b.review ? 'REVIEW' : 'PENDING', notes: b.note ?? t.notes } });
    if (!b.review) await recompute(tx, t.id);
    await audit(tx, req.ctx, { action: 'visa.review', entityType: 'visa_transaction', entityId: t.id, summary: `${b.review ? 'تحتاج مراجعة' : 'انتهت المراجعة'}: ${t.posReference ?? ''} ${D(t.amount).toFixed(3)}${b.note ? ` — ${b.note}` : ''}` });
  });
  res.json({ ok: true });
}));

visaRouter.get('/visa/settlements', requireAnyPerm('accounting.visa.manage', 'accounting.reports.view'), ah(async (req, res) => {
  const q = parse(pageQuery, req.query);
  const [items, total, ts] = await Promise.all([prisma.visaSettlement.findMany({ orderBy: { date: 'desc' }, ...paginate(q), include: { _count: { select: { lines: true } } } }), prisma.visaSettlement.count(), prisma.treasury.findMany({ select: { id: true, name: true } })]);
  res.json(paged(items.map((s) => ({ ...s, date: dateOnlyStr(s.date), treasury: ts.find((t) => t.id === s.treasuryId)?.name })), total, q));
}));

visaRouter.get('/visa/settlements/:id', requireAnyPerm('accounting.visa.manage', 'accounting.reports.view'), ah(async (req, res) => {
  const s = await prisma.visaSettlement.findUnique({ where: { id: req.params.id }, include: { lines: { include: { transaction: true } } } });
  if (!s) throw notFound();
  const entry = await prisma.journalEntry.findUnique({ where: { sourceKey: `visa-settlement:${s.id}` }, select: { id: true, number: true, status: true } });
  res.json({ ...s, date: dateOnlyStr(s.date), entry, treasury: await prisma.treasury.findUnique({ where: { id: s.treasuryId } }) });
}));

/** Record a transfer from the card company: which payments it covers (fully or partly), the fee, the net received. */
visaRouter.post('/visa/settlements', requirePerm('accounting.visa.manage'), ah(async (req, res) => {
  const b = parse(z.object({
    date: day, treasuryId: z.string().uuid('اختر الحساب البنكي'), fee: z.coerce.number().min(0).default(0), reference: nullableStr(100), notes: nullableStr(500),
    lines: z.array(z.object({ transactionId: z.string().uuid(), amount: z.coerce.number().positive() })).min(1, 'اختر عمليات الفيزا المشمولة').max(2000),
  }), req.body);
  const s = await prisma.$transaction(async (tx) => {
    const bank = await tx.treasury.findUnique({ where: { id: b.treasuryId } });
    if (!bank || bank.kind !== 'BANK' || !bank.isActive) throw badRequest('تسوية الفيزا تصل إلى حساب بنكي');
    if (new Set(b.lines.map((l) => l.transactionId)).size !== b.lines.length) throw badRequest('عملية مكررة في التسوية');
    for (const l of b.lines) {
      await tx.$queryRaw`SELECT id FROM acc_visa_transactions WHERE id = ${l.transactionId} FOR UPDATE`;
      const t = await tx.visaTransaction.findUnique({ where: { id: l.transactionId } });
      if (!t) throw badRequest('عملية فيزا غير موجودة');
      if (!['PENDING', 'PARTIAL'].includes(t.status)) throw badRequest(`العملية ${t.posReference ?? ''} (${D(t.amount).toFixed(3)}) ليست قيد التسوية`);
      if (D(l.amount).gt(D(t.amount).sub(t.settled))) throw badRequest(`المبلغ المسوّى للعملية ${t.posReference ?? ''} أكبر من المتبقي ${D(t.amount).sub(t.settled).toFixed(3)}`);
    }
    const gross = r3(b.lines.reduce((t, l) => t.add(l.amount), D(0)));
    const fee = r3(b.fee);
    if (fee.gte(gross)) throw badRequest('العمولة أكبر من إجمالي العمليات');
    const created = await tx.visaSettlement.create({ data: { number: await docNumber(tx, 'VS'), date: dayOf(b.date), treasuryId: b.treasuryId, gross, fee, net: gross.sub(fee), reference: b.reference, notes: b.notes, createdById: req.ctx.userId, lines: { create: b.lines.map((l) => ({ transactionId: l.transactionId, amount: r3(l.amount) })) } } });
    for (const l of b.lines) await recompute(tx, l.transactionId);
    await postDoc(tx, 'visa-settlement', created.id);
    await audit(tx, req.ctx, { action: 'visa.settlement', entityType: 'visa_settlement', entityId: created.id, summary: `${created.number}: ${b.lines.length} عملية — إجمالي ${gross.toFixed(3)}، عمولة ${fee.toFixed(3)}، صافي ${gross.sub(fee).toFixed(3)}` });
    return created;
  });
  res.status(201).json(s);
}));

visaRouter.post('/visa/settlements/:id/cancel', requirePerm('accounting.visa.manage'), ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: nullableStr(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const s = await tx.visaSettlement.findUnique({ where: { id: req.params.id }, include: { lines: true } });
    if (!s || s.status === 'CANCELLED') throw badRequest('التسوية غير موجودة أو ملغاة');
    await tx.visaSettlement.update({ where: { id: s.id }, data: { status: 'CANCELLED', notes: [s.notes, reason && `أُلغيت: ${reason}`].filter(Boolean).join(' — ') } });
    for (const l of s.lines) await recompute(tx, l.transactionId);
    await postDoc(tx, 'visa-settlement', s.id);
    await audit(tx, req.ctx, { action: 'visa.settlement_cancel', entityType: 'visa_settlement', entityId: s.id, summary: `${s.number}: إلغاء${reason ? ` — ${reason}` : ''}` });
  });
  res.json({ ok: true });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
/**
 * Statement from the bank / card company (one line per card payment: date, amount, reference). Each line is matched
 * by reference, else by amount within ±3 days. Shows matched, different amounts, lines with no record in the system,
 * and card payments missing from the statement. Nothing is written: the user then records the settlement.
 */
visaRouter.post('/visa/match', requirePerm('accounting.visa.manage'), upload.single('file'), ah(async (req, res) => {
  if (!req.file || !/\.(xlsx|csv)$/i.test(req.file.originalname)) throw badRequest('اختر ملف Excel (.xlsx) أو CSV');
  const { sheets } = await readTable(req.file.buffer, req.file.originalname);
  const rows = sheets[0]?.rows ?? [];
  const hi = rows.findIndex((r) => r.some((c) => /مبلغ|amount/i.test(String(c ?? ''))));
  if (hi < 0) throw badRequest('لم يُعثر على عمود «المبلغ»');
  const h = rows[hi].map((c) => String(c ?? ''));
  const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const ci = { date: col(/تاريخ|date/i), amount: col(/مبلغ|amount/i), ref: col(/مرجع|رقم العملية|ref|rrn|auth/i), fee: col(/عمولة|fee|commission/i) };
  const open = await prisma.visaTransaction.findMany({ where: { status: { in: ['PENDING', 'PARTIAL'] } } });
  const used = new Set<string>();
  const out = rows.slice(hi + 1).filter((r) => r.some((c) => c != null && c !== '')).map((r, i) => {
    const amount = toAmount(r[ci.amount]);
    const ref = ci.ref >= 0 ? String(r[ci.ref] ?? '').trim() : '';
    const date = ci.date >= 0 ? String(r[ci.date] ?? '').slice(0, 10) : '';
    const fee = ci.fee >= 0 ? toAmount(r[ci.fee]) : 0;
    const remaining = (t: (typeof open)[number]) => D(t.amount).sub(t.settled).toNumber();
    let t = ref ? open.find((x) => !used.has(x.id) && x.posReference && x.posReference.trim() === ref) : undefined;
    let how: 'REFERENCE' | 'AMOUNT_DATE' | 'NONE' = t ? 'REFERENCE' : 'NONE';
    if (!t && !Number.isNaN(amount)) {
      const d = date ? new Date(`${date}T12:00:00`).getTime() : NaN;
      t = open.find((x) => !used.has(x.id) && Math.abs(remaining(x) - amount) < 0.0005 && (Number.isNaN(d) || Math.abs(x.date.getTime() - d) <= 3 * 86_400_000));
      if (t) how = 'AMOUNT_DATE';
    }
    if (t) used.add(t.id);
    const diff = t ? Number((amount - remaining(t)).toFixed(3)) : null;
    return { line: hi + 2 + i, date, amount: Number.isNaN(amount) ? null : amount, reference: ref || null, fee, match: how, transactionId: t?.id ?? null, transaction: t ? { posReference: t.posReference, amount: D(t.amount).toNumber(), remaining: remaining(t), date: t.date, invoiceNumber: t.invoiceNumber, patientName: t.patientName } : null, status: !t ? 'NOT_IN_SYSTEM' : diff ? 'AMOUNT_DIFFERS' : 'MATCHED', difference: diff };
  });
  const missing = open.filter((x) => !used.has(x.id)).map((x) => ({ id: x.id, date: x.date, amount: D(x.amount).toNumber(), remaining: D(x.amount).sub(x.settled).toNumber(), posReference: x.posReference, invoiceNumber: x.invoiceNumber, patientName: x.patientName }));
  res.json({ columns: h, rows: out, missingFromStatement: missing, totals: { lines: out.length, matched: out.filter((x) => x.status === 'MATCHED').length, differs: out.filter((x) => x.status === 'AMOUNT_DIFFERS').length, notInSystem: out.filter((x) => x.status === 'NOT_IN_SYSTEM').length, fees: Number(out.reduce((s, x) => s + (x.fee || 0), 0).toFixed(3)) } });
}));
