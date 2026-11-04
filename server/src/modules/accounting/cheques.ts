import { Router } from 'express';
import { z } from 'zod';
import { ChequeDirection, ChequeStatus, Prisma, type Voucher } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import type { Ctx } from '../../auth/context';
import { getSetting } from '../../lib/settings';
import { D } from '../../lib/money';
import { addDays, dateOnlyStr } from '../../lib/dates';
import { dayOf } from './journal';
import { postDoc } from './link';
import { docNumber } from './common';

/**
 * Cheques, incoming and outgoing. An incoming cheque is registered with its receipt voucher and stays «in the safe»
 * until deposited; a deposit only puts it «under collection» — the bank balance changes when it is collected.
 * An outgoing cheque is registered with its payment voucher and leaves the bank only when it is actually cashed.
 * Every status change is kept (who, when, why) with its own entry; a bounced cheque is never deleted.
 */
export const chequesRouter = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');

const HOLD: ChequeStatus[] = ['RECEIVED', 'IN_SAFE', 'READY'];
const NEXT: Record<ChequeDirection, Partial<Record<ChequeStatus, ChequeStatus[]>>> = {
  IN: {
    RECEIVED: ['IN_SAFE', 'READY', 'CANCELLED', 'RETURNED_TO_OWNER', 'REPLACED'],
    IN_SAFE: ['READY', 'CANCELLED', 'RETURNED_TO_OWNER', 'REPLACED'],
    READY: ['IN_SAFE', 'CANCELLED', 'RETURNED_TO_OWNER', 'REPLACED'],
    UNDER_COLLECTION: ['COLLECTED', 'BOUNCED'],
    COLLECTED: ['BOUNCED'],
    BOUNCED: ['REPLACED', 'RETURNED_TO_OWNER'],
  },
  OUT: {
    ISSUED: ['DELIVERED', 'DUE', 'CLEARED', 'CANCELLED', 'STOPPED', 'REPLACED'],
    DELIVERED: ['DUE', 'CLEARED', 'STOPPED', 'CANCELLED', 'BOUNCED', 'REPLACED'],
    DUE: ['CLEARED', 'STOPPED', 'BOUNCED', 'REPLACED'],
  },
};

export async function createChequeForVoucher(tx: Tx, ctx: Ctx, v: Voucher, c: { number: string; bankName: string; drawer?: string | null; accountNumber?: string | null; issueDate?: string | null; dueDate: string }) {
  const direction: ChequeDirection = v.kind === 'RECEIPT' ? 'IN' : 'OUT';
  if (await tx.cheque.findUnique({ where: { direction_bankName_number: { direction, bankName: c.bankName, number: c.number } } })) throw conflict(`الشيك رقم ${c.number} على ${c.bankName} مسجل مسبقاً`);
  const status: ChequeStatus = direction === 'IN' ? 'RECEIVED' : 'ISSUED';
  const ch = await tx.cheque.create({
    data: {
      ref: await docNumber(tx, 'CHQ'), direction, number: c.number, bankName: c.bankName, drawer: c.drawer || v.partyName, counterparty: v.partyName, accountNumber: c.accountNumber,
      issueDate: c.issueDate ? dayOf(c.issueDate) : null, dueDate: dayOf(c.dueDate), amount: v.amount, reason: v.purpose, reference: v.reference, treasuryId: direction === 'OUT' ? v.treasuryId : null,
      counterAccountId: v.counterAccountId, status, createdById: ctx.userId,
    },
  });
  await tx.chequeEvent.create({ data: { chequeId: ch.id, toStatus: status, date: v.date, note: `${v.kind === 'RECEIPT' ? 'استلام مع سند القبض' : 'إصدار مع سند الصرف'} ${v.number}`, userId: ctx.userId } });
  await tx.voucher.update({ where: { id: v.id }, data: { chequeId: ch.id } });
  return ch;
}

async function move(tx: Tx, ctx: Ctx, id: string, to: ChequeStatus, b: { date: string; treasuryId?: string | null; fee?: number; note?: string | null; depositId?: string }) {
  await tx.$queryRaw`SELECT id FROM acc_cheques WHERE id = ${id} FOR UPDATE`;
  const c = await tx.cheque.findUnique({ where: { id } });
  if (!c) throw notFound('الشيك غير موجود');
  const deposit = to === 'UNDER_COLLECTION';
  const allowed = deposit ? c.direction === 'IN' && HOLD.includes(c.status) : NEXT[c.direction][c.status]?.includes(to);
  if (!allowed) throw badRequest(`لا يمكن نقل الشيك ${c.number} من «${c.status}» إلى «${to}»`);
  if (to === 'COLLECTED' && !c.treasuryId && !b.treasuryId) throw badRequest('حدد البنك الذي حُصّل فيه الشيك');
  if (to === 'BOUNCED' && b.fee && !(b.treasuryId ?? c.treasuryId)) throw badRequest('حدد البنك الذي خصم رسوم الارتجاع');
  const ev = await tx.chequeEvent.create({ data: { chequeId: c.id, fromStatus: c.status, toStatus: to, date: dayOf(b.date), treasuryId: b.treasuryId ?? c.treasuryId, fee: b.fee ?? 0, note: b.note, userId: ctx.userId } });
  await tx.cheque.update({ where: { id: c.id }, data: { status: to, ...(b.treasuryId && { treasuryId: b.treasuryId }), ...(b.depositId && { depositId: b.depositId }), ...(b.fee && { fees: { increment: b.fee } }) } });
  await postDoc(tx, 'cheque-event', ev.id);
  await audit(tx, ctx, { action: 'cheque.status', entityType: 'cheque', entityId: c.id, summary: `شيك ${c.number} (${c.bankName}): ${c.status} → ${to}${b.note ? ` — ${b.note}` : ''}` });
  return ev;
}

chequesRouter.get('/cheques', requireAnyPerm('accounting.cheques.view', 'accounting.cheques.manage'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ direction: z.nativeEnum(ChequeDirection).optional(), status: z.string().optional(), dueFrom: day.optional(), dueTo: day.optional(), alert: z.enum(['due', 'overdue', 'collecting', 'bounced']).optional() }), req.query);
  const cfg = await getSetting('accounting');
  const today = dayOf(new Date().toLocaleDateString('en-CA'));
  const statuses = q.status ? (q.status.split(',') as ChequeStatus[]) : undefined;
  const alert: Prisma.ChequeWhereInput =
    q.alert === 'due' ? { OR: [{ direction: 'IN', status: { in: HOLD } }, { direction: 'OUT', status: { in: ['ISSUED', 'DELIVERED', 'DUE'] } }], dueDate: { gte: today, lte: addDays(today, cfg.chequeDueDays) } }
    : q.alert === 'overdue' ? { OR: [{ direction: 'IN', status: { in: HOLD } }, { direction: 'OUT', status: { in: ['ISSUED', 'DELIVERED', 'DUE'] } }], dueDate: { lt: today } }
    : q.alert === 'collecting' ? { status: 'UNDER_COLLECTION', updatedAt: { lt: addDays(new Date(), -cfg.collectionLateDays) } }
    : q.alert === 'bounced' ? { status: 'BOUNCED' } : {};
  const where: Prisma.ChequeWhereInput = {
    ...alert, ...(q.direction && { direction: q.direction }), ...(statuses && { status: { in: statuses } }),
    ...((q.dueFrom || q.dueTo) && { dueDate: { ...(q.dueFrom && { gte: dayOf(q.dueFrom) }), ...(q.dueTo && { lte: dayOf(q.dueTo) }) } }),
    ...(q.q && { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { counterparty: { contains: q.q, mode: 'insensitive' } }, { drawer: { contains: q.q, mode: 'insensitive' } }, { bankName: { contains: q.q, mode: 'insensitive' } }, { ref: { contains: q.q, mode: 'insensitive' } }] }),
  };
  const [items, total, sum, byStatus] = await Promise.all([
    prisma.cheque.findMany({ where, orderBy: [{ dueDate: 'asc' }], ...paginate(q) }),
    prisma.cheque.count({ where }),
    prisma.cheque.aggregate({ where, _sum: { amount: true } }),
    prisma.cheque.groupBy({ by: ['direction', 'status'], _sum: { amount: true }, _count: true }),
  ]);
  res.json({ ...paged(items.map((c) => ({ ...c, dueDate: dateOnlyStr(c.dueDate), issueDate: c.issueDate && dateOnlyStr(c.issueDate), next: c.direction === 'IN' && HOLD.includes(c.status) ? [...(NEXT.IN[c.status] ?? [])] : NEXT[c.direction][c.status] ?? [] })), total, q), totalAmount: sum._sum.amount ?? 0, byStatus: byStatus.map((s) => ({ direction: s.direction, status: s.status, count: s._count, amount: D(s._sum.amount).toNumber() })) });
}));

chequesRouter.get('/cheques/:id', requireAnyPerm('accounting.cheques.view', 'accounting.cheques.manage'), ah(async (req, res) => {
  const c = await prisma.cheque.findUnique({ where: { id: req.params.id }, include: { events: { orderBy: { createdAt: 'asc' } } } });
  if (!c) throw notFound('الشيك غير موجود');
  const [voucher, entries, users] = await Promise.all([
    prisma.voucher.findUnique({ where: { chequeId: c.id }, select: { id: true, number: true } }),
    prisma.journalEntry.findMany({ where: { OR: [{ sourceKey: { in: c.events.map((e) => `cheque-event:${e.id}`) } }] }, select: { id: true, number: true, sourceKey: true, status: true } }),
    prisma.user.findMany({ where: { id: { in: c.events.map((e) => e.userId).filter(Boolean) as string[] } }, select: { id: true, fullName: true } }),
  ]);
  res.json({
    ...c, dueDate: dateOnlyStr(c.dueDate), issueDate: c.issueDate && dateOnlyStr(c.issueDate), voucher, next: c.direction === 'IN' && HOLD.includes(c.status) ? NEXT.IN[c.status] : NEXT[c.direction][c.status] ?? [],
    events: c.events.map((e) => ({ ...e, date: dateOnlyStr(e.date), user: users.find((u) => u.id === e.userId)?.fullName ?? null, entry: entries.find((x) => x.sourceKey === `cheque-event:${e.id}`) ?? null })),
  });
}));

chequesRouter.post('/cheques/:id/status', requirePerm('accounting.cheques.manage'), ah(async (req, res) => {
  const b = parse(z.object({ to: z.nativeEnum(ChequeStatus), date: day, treasuryId: z.string().uuid().nullable().optional(), fee: z.coerce.number().min(0).default(0), note: nullableStr(300) }), req.body);
  if (b.to === 'UNDER_COLLECTION') throw badRequest('الإيداع يكون من «إيداع شيكات»');
  if (['BOUNCED', 'CANCELLED', 'STOPPED', 'RETURNED_TO_OWNER'].includes(b.to) && !b.note) throw badRequest('اذكر السبب');
  await prisma.$transaction((tx) => move(tx, req.ctx, req.params.id, b.to, b));
  res.json({ ok: true });
}));

/** Deposit one or many incoming cheques together: they become «under collection» (not yet in the bank balance). */
chequesRouter.post('/cheques/deposits', requirePerm('accounting.cheques.manage'), ah(async (req, res) => {
  const b = parse(z.object({ date: day, treasuryId: z.string().uuid('اختر الحساب البنكي'), chequeIds: z.array(z.string().uuid()).min(1, 'اختر الشيكات').max(500), slipNumber: nullableStr(60), reference: nullableStr(100), notes: nullableStr(500) }), req.body);
  const d = await prisma.$transaction(async (tx) => {
    const bank = await tx.treasury.findUnique({ where: { id: b.treasuryId } });
    if (!bank || bank.kind !== 'BANK') throw badRequest('الإيداع يكون في حساب بنكي');
    const cs = await tx.cheque.findMany({ where: { id: { in: b.chequeIds } } });
    const total = cs.reduce((t, c) => t.add(c.amount), D(0));
    const dep = await tx.chequeDeposit.create({ data: { number: await docNumber(tx, 'CD'), date: dayOf(b.date), treasuryId: b.treasuryId, slipNumber: b.slipNumber, reference: b.reference, notes: b.notes, total, createdById: req.ctx.userId } });
    for (const id of b.chequeIds) await move(tx, req.ctx, id, 'UNDER_COLLECTION', { date: b.date, treasuryId: b.treasuryId, depositId: dep.id, note: `إيداع ${dep.number}${b.slipNumber ? ` — إيصال ${b.slipNumber}` : ''}` });
    return dep;
  });
  res.status(201).json(d);
}));

chequesRouter.get('/cheques-deposits', requireAnyPerm('accounting.cheques.view', 'accounting.cheques.manage'), ah(async (req, res) => {
  const q = parse(pageQuery, req.query);
  const [items, total, ts] = await Promise.all([prisma.chequeDeposit.findMany({ orderBy: { date: 'desc' }, ...paginate(q) }), prisma.chequeDeposit.count(), prisma.treasury.findMany({ select: { id: true, name: true } })]);
  const cheques = await prisma.cheque.findMany({ where: { depositId: { in: items.map((i) => i.id) } }, select: { id: true, depositId: true, number: true, amount: true, status: true, drawer: true } });
  res.json(paged(items.map((d) => ({ ...d, date: dateOnlyStr(d.date), treasury: ts.find((t) => t.id === d.treasuryId)?.name, cheques: cheques.filter((c) => c.depositId === d.id) })), total, q));
}));

// ───── Cheque inventory (physical count) ─────

chequesRouter.get('/cheque-counts', requireAnyPerm('accounting.cheques.view', 'accounting.cheques.manage'), ah(async (req, res) => {
  const q = parse(pageQuery, req.query);
  const [items, total] = await Promise.all([prisma.chequeCount.findMany({ orderBy: { createdAt: 'desc' }, ...paginate(q) }), prisma.chequeCount.count()]);
  const users = await prisma.user.findMany({ where: { id: { in: items.flatMap((i) => [i.countedById, i.approvedById]).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
  res.json(paged(items.map((c) => ({ ...c, date: dateOnlyStr(c.date), countedBy: users.find((u) => u.id === c.countedById)?.fullName, approvedBy: users.find((u) => u.id === c.approvedById)?.fullName })), total, q));
}));

/** The cheques that should physically be in the clinic now. */
chequesRouter.get('/cheque-counts/expected', requirePerm('accounting.cheques.manage'), ah(async (_req, res) => {
  const cs = await prisma.cheque.findMany({ where: { direction: 'IN', status: { in: HOLD } }, orderBy: { dueDate: 'asc' } });
  res.json(cs.map((c) => ({ ...c, dueDate: dateOnlyStr(c.dueDate) })));
}));

chequesRouter.post('/cheque-counts', requirePerm('accounting.cheques.manage'), ah(async (req, res) => {
  const b = parse(z.object({
    date: day, notes: nullableStr(500),
    lines: z.array(z.object({ chequeId: z.string().uuid(), result: z.enum(['FOUND', 'MISSING']), note: nullableStr(300) })).max(2000),
    extra: z.array(z.object({ number: z.string().trim().min(1), bankName: nullableStr(100), amount: z.coerce.number().min(0), note: nullableStr(300) })).max(200).default([]),
  }), req.body);
  const expected = await prisma.cheque.findMany({ where: { direction: 'IN', status: { in: HOLD } } });
  const missing = expected.filter((c) => !b.lines.some((l) => l.chequeId === c.id));
  if (missing.length) throw badRequest(`لم يُحدَّد وضع ${missing.length} شيك من الشيكات المتوقع وجودها`);
  const diff = b.lines.some((l) => l.result === 'MISSING') || b.extra.length > 0;
  const lines = b.lines.map((l) => { const c = expected.find((x) => x.id === l.chequeId); return { ...l, number: c?.number, bankName: c?.bankName, amount: c ? D(c.amount).toNumber() : 0, drawer: c?.drawer }; });
  const c = await prisma.$transaction(async (tx) => {
    const created = await tx.chequeCount.create({ data: { number: await docNumber(tx, 'CQC'), date: dayOf(b.date), lines, extra: b.extra, notes: b.notes, countedById: req.ctx.userId, status: diff ? 'PENDING' : 'APPROVED', ...(!diff && { approvedAt: new Date() }) } });
    await audit(tx, req.ctx, { action: 'cheque.count', entityType: 'cheque_count', entityId: created.id, summary: `${created.number}: ${lines.filter((l) => l.result === 'FOUND').length} موجود، ${lines.filter((l) => l.result === 'MISSING').length} مفقود، ${b.extra.length} غير مسجل` });
    return created;
  });
  res.status(201).json(c);
}));

/** Approving a count records the review; any accounting treatment of a difference is a separate, deliberate step. */
chequesRouter.post('/cheque-counts/:id/approve', requirePerm('accounting.cash.approve'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const c = await tx.chequeCount.findUnique({ where: { id: req.params.id } });
    if (!c || c.status !== 'PENDING') throw badRequest('الجرد غير موجود أو معتمد');
    await tx.chequeCount.update({ where: { id: c.id }, data: { status: 'APPROVED', approvedById: req.ctx.userId, approvedAt: new Date() } });
    await audit(tx, req.ctx, { action: 'cheque.count_approve', entityType: 'cheque_count', entityId: c.id, summary: `اعتماد ${c.number}` });
  });
  res.json({ ok: true });
}));
