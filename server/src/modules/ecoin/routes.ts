import { Router } from 'express';
import { z } from 'zod';
import type { ECoinTxnType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { can } from '../../auth/context';
import { addDays, dateOnly, dateOnlyStr, rangeFromQuery } from '../../lib/dates';
import { getSetting, settingSchemas } from '../../lib/settings';
import { notifyUsers } from '../../lib/notify';
import { credit, debit, expireDueLocked, lockWallet, refundDebit, walletSummary } from './wallet';
import { basePrice, hoursOf, windowOf } from '../shiftx/core';

export const ecoinRouter = Router();

const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');
const TYPES = ['EARN', 'EXPIRE', 'PURCHASE', 'SECURE', 'ADJUST', 'CLAWBACK', 'REVERSAL'] as const;

async function ensureOwnWallet(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { staffType: true } });
  if (u?.staffType !== 'DOCTOR') throw forbidden('نظام E Coin مخصص للأطباء فقط');
}

/** The doctor's own wallet. */
ecoinRouter.get('/me', requirePerm('ecoin.use'), ah(async (req, res) => {
  await ensureOwnWallet(req.ctx.userId);
  const cfg = await getSetting('ecoin');
  res.json({ ...(await walletSummary(req.ctx.userId)), enabled: cfg.enabled, securePrice: cfg.securePrice, expiryDays: cfg.expiryDays });
}));

/** Ledger: own rows, or anyone's with ecoin.view_all. */
ecoinRouter.get('/transactions', requireAnyPerm('ecoin.use', 'ecoin.view_all'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ userId: z.string().uuid().optional(), type: z.enum(TYPES).optional(), from: ymdStr.optional(), to: ymdStr.optional() }), req.query);
  const all = can(req.ctx, 'ecoin.view_all');
  if (!all) await ensureOwnWallet(req.ctx.userId);
  const userId = all ? q.userId : req.ctx.userId;
  const range = q.from || q.to ? rangeFromQuery(q.from ?? q.to, q.to ?? q.from) : null;
  const where: Prisma.ECoinTxnWhereInput = { ...(userId && { userId }), ...(q.type && { type: q.type }), ...(range && { createdAt: { gte: range.from, lte: range.to } }) };
  const [items, total] = await Promise.all([
    prisma.eCoinTxn.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
    prisma.eCoinTxn.count({ where }),
  ]);
  const [invoices, slots, users, lots, reversed] = await Promise.all([
    prisma.invoice.findMany({ where: { id: { in: items.map((t) => t.invoiceId).filter(Boolean) as string[] } }, select: { id: true, invoiceNumber: true } }),
    prisma.shiftAssignment.findMany({ where: { id: { in: items.map((t) => t.assignmentId).filter(Boolean) as string[] } }, include: { shift: { select: { name: true } } } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(items.flatMap((t) => [t.userId, t.createdById]).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } }),
    prisma.eCoinLot.findMany({ where: { id: { in: items.map((t) => t.lotId).filter(Boolean) as string[] } }, select: { id: true, earnedAt: true, expiresAt: true } }),
    prisma.eCoinTxn.findMany({ where: { reversalOfId: { in: items.map((t) => t.id) } }, select: { reversalOfId: true, id: true } }),
  ]);
  const nm = (id: string | null) => (id ? users.find((u) => u.id === id)?.fullName ?? null : null);
  res.json(paged(items.map((t) => {
    const s = slots.find((x) => x.id === t.assignmentId);
    const lot = lots.find((l) => l.id === t.lotId);
    return {
      ...t, user: nm(t.userId), by: nm(t.createdById), invoiceNumber: invoices.find((i) => i.id === t.invoiceId)?.invoiceNumber ?? null,
      slot: s ? { id: s.id, name: s.shift.name, date: dateOnlyStr(s.date), startTime: s.startTime, endTime: s.endTime } : null,
      lot: lot ?? null, reversedBy: reversed.find((r) => r.reversalOfId === t.id)?.id ?? null,
    };
  }), total, q));
}));

/** All doctors' wallets with their figures (administration). */
ecoinRouter.get('/wallets', requirePerm('ecoin.view_all'), ah(async (_req, res) => {
  const doctors = await prisma.user.findMany({ where: { staffType: 'DOCTOR', deletedAt: null }, select: { id: true, fullName: true, isActive: true }, orderBy: { fullName: 'asc' } });
  const [wallets, sums, penalties] = await Promise.all([
    prisma.eCoinWallet.findMany({ where: { userId: { in: doctors.map((d) => d.id) } } }),
    prisma.eCoinTxn.groupBy({ by: ['userId', 'type'], where: { userId: { in: doctors.map((d) => d.id) } }, _sum: { amount: true } }),
    prisma.eCoinPenalty.findMany({ where: { status: 'ACTIVE' } }),
  ]);
  const s = (u: string, t: ECoinTxnType) => sums.find((x) => x.userId === u && x.type === t)?._sum.amount ?? 0;
  res.json(doctors.map((d) => ({
    ...d, balance: wallets.find((w) => w.userId === d.id)?.balance ?? 0, earned: s(d.id, 'EARN'), spentPurchases: -s(d.id, 'PURCHASE'), spentSecuring: -s(d.id, 'SECURE'),
    expired: -s(d.id, 'EXPIRE'), adjustments: s(d.id, 'ADJUST'), clawedBack: -s(d.id, 'CLAWBACK'), penalty: penalties.find((p) => p.userId === d.id) ?? null,
  })));
}));

/** Manual correction of a doctor's balance (mandatory reason, logged with before/after). */
ecoinRouter.post('/adjust', requirePerm('ecoin.adjust'), ah(async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid(), amount: z.coerce.number().int().refine((n) => n !== 0, 'أدخل عدداً غير الصفر').refine((n) => Math.abs(n) <= 1000, 'العدد كبير جداً'), reason: z.string().trim().min(5, 'السبب إلزامي (5 أحرف على الأقل)').max(300) }), req.body);
  const u = await prisma.user.findUnique({ where: { id: b.userId }, select: { fullName: true, staffType: true } });
  if (u?.staffType !== 'DOCTOR') throw badRequest('المحفظة للأطباء فقط');
  const txn = await prisma.$transaction(async (tx) => {
    const t = b.amount > 0
      ? (await credit(tx, b.userId, b.amount, { source: 'ADJUSTMENT' }, { type: 'ADJUST', reason: b.reason, createdById: req.ctx.userId })).txn
      : await debit(tx, b.userId, -b.amount, { type: 'ADJUST', reason: b.reason, createdById: req.ctx.userId });
    await audit(tx, req.ctx, { action: 'ecoin.adjust', entityType: 'ecoin_wallet', entityId: b.userId, summary: `تعديل يدوي لرصيد ${u.fullName}: ${b.amount > 0 ? '+' : ''}${b.amount} E Coin — ${b.reason}`, before: { balance: t.balanceBefore }, after: { balance: t.balanceAfter, reason: b.reason } });
    await notifyUsers([b.userId], { type: 'ECOIN', title: `تعديل رصيد E Coin: ${b.amount > 0 ? '+' : ''}${b.amount}`, body: b.reason, link: '/ecoin' }, tx);
    return t;
  });
  res.status(201).json(txn);
}));

/**
 * Administrative reversal of a wrong transaction. The original row stays; a REVERSAL row records the correction
 * (at most once per transaction). Purchase/secure: coins back to the doctor and, if the shift has not started,
 * the holder/protection is restored.
 */
ecoinRouter.post('/transactions/:id/reverse', requirePerm('ecoin.manage'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(5, 'السبب إلزامي (5 أحرف على الأقل)').max(300) }), req.body);
  const out = await prisma.$transaction(async (tx) => {
    const t = await tx.eCoinTxn.findUnique({ where: { id: req.params.id } });
    if (!t) throw notFound('العملية غير موجودة');
    await lockWallet(tx, t.userId);
    if (await tx.eCoinTxn.findUnique({ where: { reversalOfId: t.id } })) throw badRequest('تم إلغاء هذه العملية مسبقاً');
    if (!['PURCHASE', 'SECURE', 'ADJUST', 'EARN'].includes(t.type)) throw badRequest('لا يمكن إلغاء هذا النوع من العمليات');
    const base = { type: 'REVERSAL' as const, reversalOfId: t.id, assignmentId: t.assignmentId, reason: b.reason, createdById: req.ctx.userId };
    let note = '';
    let r;
    if (t.amount < 0) {
      r = await refundDebit(tx, t, base);
      if (t.assignmentId && (t.type === 'PURCHASE' || t.type === 'SECURE')) {
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "shift_assignments" WHERE id = ${t.assignmentId} FOR UPDATE`;
        const a = rows.length ? await tx.shiftAssignment.findUniqueOrThrow({ where: { id: t.assignmentId } }) : null;
        if (a && windowOf(a).start > new Date() && a.userId === t.userId) {
          if (t.type === 'SECURE' && a.holding === 'SECURED') {
            await tx.shiftAssignment.update({ where: { id: a.id }, data: { holding: 'ASSIGNED', securedAt: null } });
            note = 'أُلغي تأمين الشفت';
          }
          if (t.type === 'PURCHASE' && a.holding === 'PURCHASED') {
            const meta = (t.meta ?? {}) as { previousHolderId?: string | null };
            const prev = meta.previousHolderId ? await tx.user.findFirst({ where: { id: meta.previousHolderId, isActive: true, deletedAt: null } }) : null;
            await tx.shiftAssignment.update({ where: { id: a.id }, data: prev ? { userId: prev.id, holding: 'ASSIGNED' } : { userId: null, holding: 'VACANT' } });
            note = prev ? `أُعيد الشفت إلى ${prev.fullName}` : 'أصبح الشفت شاغراً';
          }
          if (note) await tx.shiftEvent.create({ data: { assignmentId: a.id, type: 'REVERSED', fromUserId: t.userId, toUserId: t.type === 'PURCHASE' ? ((t.meta as { previousHolderId?: string } | null)?.previousHolderId ?? null) : t.userId, txnId: r.id, note: `${note} — ${b.reason}`, createdById: req.ctx.userId } });
        } else note = 'الشفت بدأ أو تغيّر صاحبه، فأُعيدت العملات فقط';
      }
    } else {
      // A credit (earned / added): take back what is still in its lot (never below zero).
      await expireDueLocked(tx, t.userId);
      const before = await lockWallet(tx, t.userId);
      const lot = t.lotId ? await tx.eCoinLot.findUnique({ where: { id: t.lotId } }) : null;
      const take = Math.min(lot?.remaining ?? 0, t.amount, before);
      r = await tx.eCoinTxn.create({ data: { userId: t.userId, amount: -take, balanceBefore: before, balanceAfter: before - take, lotId: lot?.id ?? null, invoiceId: t.invoiceId, ...base } });
      if (take > 0 && lot) {
        await tx.eCoinLot.update({ where: { id: lot.id }, data: { remaining: lot.remaining - take } });
        await tx.eCoinLotUse.create({ data: { txnId: r.id, lotId: lot.id, amount: take } });
        await tx.eCoinWallet.update({ where: { userId: t.userId }, data: { balance: before - take } });
      }
      if (take < t.amount) note = `استُرجع ${take} من ${t.amount} (الباقي صُرف أو انتهت صلاحيته)`;
    }
    await audit(tx, req.ctx, { action: 'ecoin.reverse', entityType: 'ecoin_transaction', entityId: t.id, summary: `إلغاء عملية E Coin (${t.type} ${t.amount}) — ${b.reason}${note ? ` — ${note}` : ''}`, after: { reversalId: r.id, reason: b.reason, note } });
    await notifyUsers([t.userId], { type: 'ECOIN', title: 'إلغاء عملية E Coin من الإدارة', body: `${b.reason}${note ? ` — ${note}` : ''}`, link: '/ecoin' }, tx);
    return { reversal: r, note };
  });
  res.json(out);
}));

// ── Settings and prices ──

ecoinRouter.get('/settings', requireAnyPerm('ecoin.manage', 'ecoin.view_all'), ah(async (_req, res) => res.json(await getSetting('ecoin'))));
ecoinRouter.put('/settings', requirePerm('ecoin.manage'), ah(async (req, res) => {
  const current = await getSetting('ecoin');
  const value = settingSchemas.ecoin.parse({ ...current, ...req.body });
  const hours = value.durationPrices.map((d) => d.hours);
  if (new Set(hours).size !== hours.length) throw badRequest('مدة الشفت مكررة في جدول الأسعار');
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({ where: { key: 'ecoin' }, create: { key: 'ecoin', value, updatedBy: req.ctx.userId }, update: { value, updatedBy: req.ctx.userId } });
    await audit(tx, req.ctx, { action: 'settings.update', entityType: 'setting', entityId: 'ecoin', before: current, after: value });
  });
  res.json(value);
}));

const ruleBody = z.object({
  shiftId: z.string().uuid('اختر الشفت'),
  weekday: z.coerce.number().int().min(0).max(6).nullish(),
  date: ymdStr.nullish(),
  price: z.coerce.number().int().min(0).max(100),
}).refine((r) => (r.weekday == null) !== !r.date, { message: 'اختر يوماً من الأسبوع أو تاريخاً محدداً (أحدهما فقط)', path: ['date'] });

ecoinRouter.get('/price-rules', requireAnyPerm('ecoin.manage', 'ecoin.view_all'), ah(async (_req, res) => {
  const rules = await prisma.shiftPriceRule.findMany({ where: { isActive: true }, orderBy: [{ shiftId: 'asc' }, { date: 'asc' }, { weekday: 'asc' }] });
  const shifts = await prisma.shift.findMany({ where: { id: { in: rules.map((r) => r.shiftId) } }, select: { id: true, name: true, startTime: true, endTime: true } });
  res.json(rules.map((r) => ({ ...r, date: r.date ? dateOnlyStr(r.date) : null, shift: shifts.find((s) => s.id === r.shiftId) })));
}));

ecoinRouter.post('/price-rules', requirePerm('ecoin.manage'), ah(async (req, res) => {
  const b = parse(ruleBody, req.body);
  const r = await prisma.$transaction(async (tx) => {
    const same = await tx.shiftPriceRule.findFirst({ where: { shiftId: b.shiftId, isActive: true, ...(b.date ? { date: dateOnly(b.date) } : { weekday: b.weekday! }) } });
    if (same) throw badRequest('يوجد سعر مخصص لهذا الشفت في هذا اليوم/التاريخ. عدّله بدلاً من إضافة جديد');
    const row = await tx.shiftPriceRule.create({ data: { shiftId: b.shiftId, weekday: b.weekday ?? null, date: b.date ? dateOnly(b.date) : null, price: b.price, createdById: req.ctx.userId } });
    await audit(tx, req.ctx, { action: 'ecoin.price_rule.create', entityType: 'shift_price_rule', entityId: row.id, after: { ...b } });
    return row;
  });
  res.status(201).json(r);
}));

ecoinRouter.put('/price-rules/:id', requirePerm('ecoin.manage'), ah(async (req, res) => {
  const b = parse(z.object({ price: z.coerce.number().int().min(0).max(100) }), req.body);
  const r = await prisma.$transaction(async (tx) => {
    const before = await tx.shiftPriceRule.findUnique({ where: { id: req.params.id } });
    if (!before || !before.isActive) throw notFound();
    const row = await tx.shiftPriceRule.update({ where: { id: before.id }, data: { price: b.price } });
    await audit(tx, req.ctx, { action: 'ecoin.price_rule.update', entityType: 'shift_price_rule', entityId: row.id, before: { price: before.price }, after: { price: row.price } });
    return row;
  });
  res.json(r);
}));

ecoinRouter.delete('/price-rules/:id', requirePerm('ecoin.manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const before = await tx.shiftPriceRule.findUnique({ where: { id: req.params.id } });
    if (!before || !before.isActive) throw notFound();
    // Kept (inactive) so past prices stay explainable; purchases already made keep the price they were made at.
    await tx.shiftPriceRule.update({ where: { id: before.id }, data: { isActive: false } });
    await audit(tx, req.ctx, { action: 'ecoin.price_rule.delete', entityType: 'shift_price_rule', entityId: before.id, before });
  });
  res.json({ ok: true });
}));

/** Price applied to each distributed doctor shift in a range, and where it comes from. */
ecoinRouter.get('/prices', requireAnyPerm('ecoin.manage', 'ecoin.view_all'), ah(async (req, res) => {
  const q = parse(z.object({ from: ymdStr, to: ymdStr }), req.query);
  const cfg = await getSetting('ecoin');
  const [slots, rules] = await Promise.all([
    prisma.shiftAssignment.findMany({ where: { date: { gte: dateOnly(q.from), lte: dateOnly(q.to) }, staffType: 'DOCTOR' }, include: { shift: { select: { name: true } }, user: { select: { fullName: true } } }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] }),
    prisma.shiftPriceRule.findMany({ where: { isActive: true } }),
  ]);
  res.json(slots.map((a) => ({ id: a.id, date: dateOnlyStr(a.date), shift: a.shift.name, startTime: a.startTime, endTime: a.endTime, hours: hoursOf(a), holder: a.user?.fullName ?? null, holding: a.holding, ...basePrice(a, rules, cfg) })));
}));

ecoinRouter.get('/penalties', requireAnyPerm('ecoin.view_all', 'ecoin.use'), ah(async (req, res) => {
  const all = can(req.ctx, 'ecoin.view_all');
  const rows = await prisma.eCoinPenalty.findMany({ where: all ? (req.query.userId ? { userId: String(req.query.userId) } : {}) : { userId: req.ctx.userId }, orderBy: { triggeredAt: 'desc' }, take: 200 });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, fullName: true } });
  res.json(rows.map((r) => ({ ...r, user: users.find((u) => u.id === r.userId)?.fullName })));
}));

/** Reports per doctor for a period (weekly / monthly / any), filterable by doctor. */
ecoinRouter.get('/reports', requirePerm('ecoin.view_all'), ah(async (req, res) => {
  const q = parse(z.object({ from: ymdStr.optional(), to: ymdStr.optional(), userId: z.string().uuid().optional() }), req.query);
  const { from, to } = rangeFromQuery(q.from ?? dateOnlyStr(addDays(new Date(), -30)), q.to ?? dateOnlyStr(new Date()));
  const doctors = await prisma.user.findMany({ where: { staffType: 'DOCTOR', deletedAt: null, ...(q.userId && { id: q.userId }) }, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } });
  const ids = doctors.map((d) => d.id);
  const period = { gte: from, lte: to };
  const [wallets, txSums, events, swaps, covers, handovers, penalties] = await Promise.all([
    prisma.eCoinWallet.findMany({ where: { userId: { in: ids } } }),
    prisma.eCoinTxn.groupBy({ by: ['userId', 'type'], where: { userId: { in: ids }, createdAt: period }, _sum: { amount: true }, _count: true }),
    prisma.shiftEvent.findMany({ where: { createdAt: period, type: { in: ['PURCHASED', 'SECURED', 'RELEASED'] } }, select: { type: true, fromUserId: true, toUserId: true } }),
    prisma.shiftSwap.findMany({ where: { createdAt: period }, select: { status: true, requesterId: true, targetUserId: true } }),
    prisma.shiftCoverage.findMany({ where: { createdAt: period }, select: { status: true, requesterId: true, ownerId: true } }),
    prisma.shiftHandover.findMany({ where: { createdAt: period }, select: { lateMinutes: true, extendedMinutes: true, nextUserId: true, prevUserId: true } }),
    prisma.eCoinPenalty.findMany({ where: { triggeredAt: period, userId: { in: ids } } }),
  ]);
  const sum = (u: string, t: ECoinTxnType) => txSums.find((x) => x.userId === u && x.type === t)?._sum.amount ?? 0;
  const rows = doctors.map((d) => ({
    id: d.id, name: d.fullName,
    balance: wallets.find((w) => w.userId === d.id)?.balance ?? 0,
    earned: sum(d.id, 'EARN'), spent: -(sum(d.id, 'PURCHASE') + sum(d.id, 'SECURE')), expired: -sum(d.id, 'EXPIRE'),
    adjustments: sum(d.id, 'ADJUST'), clawedBack: -sum(d.id, 'CLAWBACK'),
    bought: events.filter((e) => e.type === 'PURCHASED' && e.toUserId === d.id).length,
    lost: events.filter((e) => e.type === 'PURCHASED' && e.fromUserId === d.id).length,
    secured: events.filter((e) => e.type === 'SECURED' && e.toUserId === d.id).length,
    released: events.filter((e) => e.type === 'RELEASED' && e.fromUserId === d.id).length,
    swaps: swaps.filter((s) => s.status === 'ACCEPTED' && (s.requesterId === d.id || s.targetUserId === d.id)).length,
    coverRequests: covers.filter((c) => c.requesterId === d.id || c.ownerId === d.id).length,
    lateMinutes: handovers.filter((h) => h.nextUserId === d.id).reduce((t, h) => t + h.lateMinutes, 0),
    extendedMinutes: handovers.filter((h) => h.prevUserId === d.id).reduce((t, h) => t + h.extendedMinutes, 0),
    penalties: penalties.filter((p) => p.userId === d.id).length,
  }));
  const totals = {
    earned: rows.reduce((t, r) => t + r.earned, 0), spent: rows.reduce((t, r) => t + r.spent, 0), expired: rows.reduce((t, r) => t + r.expired, 0),
    purchases: events.filter((e) => e.type === 'PURCHASED').length, secured: events.filter((e) => e.type === 'SECURED').length,
    releases: events.filter((e) => e.type === 'RELEASED').length, swaps: swaps.filter((s) => s.status === 'ACCEPTED').length,
    swapRequests: swaps.length, coverRequests: covers.length, coverAccepted: covers.filter((c) => c.status === 'ACCEPTED').length,
    handovers: handovers.length, lateMinutes: handovers.reduce((t, h) => t + h.lateMinutes, 0), extendedMinutes: handovers.reduce((t, h) => t + h.extendedMinutes, 0),
    penalties: penalties.length,
  };
  res.json({ from, to, rows, totals });
}));
