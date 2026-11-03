import { Router } from 'express';
import { z } from 'zod';
import type { Prisma, ShiftEventType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { can } from '../../auth/context';
import { addDays, dateOnly, dateOnlyStr, rangeFromQuery } from '../../lib/dates';
import { getSetting, settingSchemas } from '../../lib/settings';
import { basePrice, hoursOf, purchasePrice, slotInclude, slotState, viewerOf, windowOf } from './core';
import {
  adminAssign, buyShift, isUniqueViolation, recordHandover, releaseShift, requestCoverage, requestSwap, respondCoverage, respondSwap, secureShift,
} from './actions';

export const shiftsRouter = Router();

const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');
const names = async (ids: (string | null | undefined)[]) => {
  const list = [...new Set(ids.filter(Boolean))] as string[];
  const users = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true, staffType: true } });
  return Object.fromEntries(users.map((u) => [u.id, u]));
};

/** Weekly (or any range up to 6 weeks) board of all distributed shifts, with each slot's state for the viewer. */
shiftsRouter.get(
  '/board',
  requirePerm('shifts.view'),
  ah(async (req, res) => {
    const q = parse(z.object({ from: ymdStr, to: ymdStr, staffType: z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'ACCOUNTANT', 'ADMIN', 'OTHER']).optional() }), req.query);
    const from = dateOnly(q.from), to = dateOnly(q.to);
    if (to < from || (to.getTime() - from.getTime()) / 86_400_000 > 42) throw badRequest('اختر فترة حتى 6 أسابيع');
    const now = new Date();
    const [cfg, ex, viewer] = await Promise.all([getSetting('ecoin'), getSetting('shiftExchange'), viewerOf(prisma, req.ctx)]);
    const showPrices = cfg.enabled && ((viewer.isDoctor && viewer.canEcoin) || can(req.ctx, 'ecoin.view_all'));
    const [slots, templates, rules, coverages, handovers, mine] = await Promise.all([
      prisma.shiftAssignment.findMany({ where: { date: { gte: from, lte: to }, ...(q.staffType && { staffType: q.staffType }) }, include: { ...slotInclude, user: { select: { id: true, fullName: true, staffType: true } } }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] }),
      prisma.shift.findMany({ where: { isActive: true }, orderBy: { startTime: 'asc' } }),
      prisma.shiftPriceRule.findMany({ where: { isActive: true } }),
      prisma.shiftCoverage.findMany({ where: { status: { in: ['PENDING', 'ACCEPTED'] }, assignment: { date: { gte: from, lte: to } } } }),
      prisma.shiftHandover.findMany({ where: { plannedStart: { gte: addDays(from, -1), lte: addDays(to, 2) } } }),
      prisma.shiftAssignment.findMany({ where: { userId: req.ctx.userId, date: { gte: addDays(from, -1), lte: to } } }),
    ]);
    const myEnds = new Set(mine.map((m) => windowOf(m).end.getTime()));
    const penalty = showPrices && viewer.isDoctor ? await prisma.eCoinPenalty.findFirst({ where: { userId: req.ctx.userId, status: 'ACTIVE', usesLeft: { gt: 0 } } }) : null;
    const who = await names([...coverages.map((c) => c.requesterId), ...handovers.flatMap((h) => [h.nextUserId, h.prevUserId])]);
    const out = slots.map((a) => {
      const st = slotState(a, viewer, cfg, ex, now);
      const doctorSlot = a.staffType === 'DOCTOR';
      const base = showPrices && doctorSlot ? basePrice(a, rules, cfg) : null;
      const discount = base && penalty ? Math.min(penalty.discount, base.price) : 0;
      const w = windowOf(a);
      return {
        id: a.id, date: dateOnlyStr(a.date), startTime: a.startTime, endTime: a.endTime, hours: Math.round(hoursOf(a) * 100) / 100,
        start: w.start, end: w.end, shift: a.shift, staffType: a.staffType, holder: a.user, holding: a.holding, securedAt: a.securedAt,
        status: st.status, lockReason: st.lockReason, mine: st.mine,
        canBuy: st.canBuy, canSecure: st.canSecure, canRelease: st.canRelease, canSwapFrom: st.canSwapFrom, canSwapWith: st.canSwapWith,
        canCover: ex.coverEnabled && viewer.canCover && !!a.userId && !st.mine && w.end > now && myEnds.has(w.start.getTime()),
        price: base ? { base: base.price, source: base.source, discount, price: Math.max(0, base.price - discount) } : null,
        securePrice: showPrices && doctorSlot ? cfg.securePrice : null,
        coverages: coverages.filter((c) => c.assignmentId === a.id).map((c) => ({ id: c.id, minutes: c.minutes, status: c.status, startAt: c.startAt, endAt: c.endAt, by: who[c.requesterId]?.fullName ?? '' })),
        handovers: handovers.filter((h) => h.nextAssignmentId === a.id || h.prevAssignmentId === a.id).map((h) => ({
          id: h.id, lateMinutes: h.lateMinutes, extendedMinutes: h.extendedMinutes, reason: h.reason, role: h.nextAssignmentId === a.id ? 'NEXT' : 'PREV',
          prev: h.prevUserId ? who[h.prevUserId]?.fullName : null, next: h.nextUserId ? who[h.nextUserId]?.fullName : null,
        })),
      };
    });
    // Shift templates with nobody on a day: "not distributed by the administration" (never purchasable).
    const unassigned: { date: string; shift: { id: string; name: string; startTime: string; endTime: string; color: string | null } }[] = [];
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
      const day = dateOnlyStr(d);
      for (const t of templates) if (!slots.some((a) => a.shiftId === t.id && dateOnlyStr(a.date) === day)) unassigned.push({ date: day, shift: { id: t.id, name: t.name, startTime: t.startTime, endTime: t.endTime, color: t.color } });
    }
    let balance: number | null = null;
    if (viewer.isDoctor && viewer.canEcoin && cfg.enabled) balance = (await prisma.eCoinWallet.findUnique({ where: { userId: req.ctx.userId } }))?.balance ?? 0;
    res.json({
      now, slots: out, unassigned,
      viewer: { ...viewer, showPrices, balance, penalty: penalty && { discount: penalty.discount, usesLeft: penalty.usesLeft }, canManage: can(req.ctx, 'shifts.manage'), canHandover: can(req.ctx, 'shifts.handover') },
      rules: { purchaseLeadMinutes: cfg.purchaseLeadMinutes, changeLeadMinutes: ex.changeLeadMinutes, minCoverMinutes: ex.minCoverMinutes, maxCoverMinutes: ex.maxCoverMinutes, ecoinEnabled: cfg.enabled },
    });
  }),
);

/** One shift: price for the viewer and its full ownership history. */
shiftsRouter.get(
  '/:id',
  requirePerm('shifts.view'),
  ah(async (req, res) => {
    const a = await prisma.shiftAssignment.findUnique({ where: { id: req.params.id }, include: { ...slotInclude, user: { select: { id: true, fullName: true } }, events: { orderBy: { createdAt: 'asc' } } } });
    if (!a) throw notFound('الشفت غير موجود');
    const [cfg, ex, viewer] = await Promise.all([getSetting('ecoin'), getSetting('shiftExchange'), viewerOf(prisma, req.ctx)]);
    const st = slotState(a, viewer, cfg, ex);
    const price = cfg.enabled && a.staffType === 'DOCTOR' && ((viewer.isDoctor && viewer.canEcoin) || can(req.ctx, 'ecoin.view_all')) ? await purchasePrice(prisma, req.ctx.userId, a, cfg) : null;
    const who = await names([a.originalUserId, ...a.events.flatMap((e) => [e.fromUserId, e.toUserId, e.createdById])]);
    res.json({
      id: a.id, date: dateOnlyStr(a.date), startTime: a.startTime, endTime: a.endTime, shift: a.shift, holder: a.user, holding: a.holding, staffType: a.staffType,
      originalHolder: a.originalUserId ? who[a.originalUserId]?.fullName ?? null : null, ...st,
      price: price && { base: price.base, discount: price.discount, price: price.price, source: price.source },
      events: a.events.map((e) => ({ ...e, from: e.fromUserId ? who[e.fromUserId]?.fullName : null, to: e.toUserId ? who[e.toUserId]?.fullName : null, by: e.createdById ? who[e.createdById]?.fullName : null })),
    });
  }),
);

const requestId = z.object({ requestId: z.string().uuid().optional() });
/** Runs a coin operation; a request id already used (resent request) returns the first result, never charges twice. */
async function coinOp(fn: () => Promise<{ txn: { id: string; balanceAfter: number; amount: number }; replayed: boolean }>) {
  try {
    return await fn();
  } catch (e) {
    if (isUniqueViolation(e)) return fn(); // two identical requests raced: the second now finds the first
    throw e;
  }
}

shiftsRouter.post('/:id/buy', requirePerm('ecoin.use'), ah(async (req, res) => {
  const b = parse(requestId, req.body);
  const r = await coinOp(() => prisma.$transaction((tx) => buyShift(tx, req.ctx, req.params.id, b.requestId)));
  res.json({ ok: true, replayed: r.replayed, price: -r.txn.amount, balance: r.txn.balanceAfter, txnId: r.txn.id });
}));

shiftsRouter.post('/:id/secure', requirePerm('ecoin.use'), ah(async (req, res) => {
  const b = parse(requestId, req.body);
  const r = await coinOp(() => prisma.$transaction((tx) => secureShift(tx, req.ctx, req.params.id, b.requestId)));
  res.json({ ok: true, replayed: r.replayed, price: -r.txn.amount, balance: r.txn.balanceAfter, txnId: r.txn.id });
}));

shiftsRouter.post('/:id/release', requirePerm('shifts.release'), ah(async (req, res) => {
  const b = parse(z.object({ reason: nullableStr(300), confirm: z.literal(true, { errorMap: () => ({ message: 'يجب تأكيد التنازل' }) }) }), req.body);
  await prisma.$transaction((tx) => releaseShift(tx, req.ctx, req.params.id, b.reason ?? null));
  res.json({ ok: true });
}));

shiftsRouter.post('/:id/assign', requirePerm('shifts.manage'), ah(async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid(), reason: z.string().trim().min(3, 'اذكر السبب').max(300) }), req.body);
  await prisma.$transaction((tx) => adminAssign(tx, req.ctx, req.params.id, b.userId, b.reason));
  res.json({ ok: true });
}));

// ── Swaps & partial coverage requests ──

shiftsRouter.post('/swaps', requirePerm('shifts.swap'), ah(async (req, res) => {
  const b = parse(z.object({ fromAssignmentId: z.string().uuid(), toAssignmentId: z.string().uuid(), note: nullableStr(300) }), req.body);
  res.status(201).json(await prisma.$transaction((tx) => requestSwap(tx, req.ctx, b.fromAssignmentId, b.toAssignmentId, b.note ?? null)));
}));

shiftsRouter.post('/swaps/:id/respond', requireAnyPerm('shifts.swap', 'shifts.view'), ah(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['ACCEPT', 'REJECT', 'CANCEL']) }), req.body);
  res.json(await prisma.$transaction((tx) => respondSwap(tx, req.ctx, req.params.id, b.decision)));
}));

shiftsRouter.post('/coverages', requirePerm('shifts.cover'), ah(async (req, res) => {
  const b = parse(z.object({ assignmentId: z.string().uuid(), minutes: z.coerce.number().int().min(1).max(1440), note: nullableStr(300) }), req.body);
  res.status(201).json(await prisma.$transaction((tx) => requestCoverage(tx, req.ctx, b.assignmentId, b.minutes, b.note ?? null)));
}));

shiftsRouter.post('/coverages/:id/respond', requireAnyPerm('shifts.cover', 'shifts.view'), ah(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['ACCEPT', 'REJECT', 'CANCEL']) }), req.body);
  res.json(await prisma.$transaction((tx) => respondCoverage(tx, req.ctx, req.params.id, b.decision)));
}));

/** My requests (sent and received). The administration sees everyone's with ?all=1. */
shiftsRouter.get('/requests/list', requirePerm('shifts.view'), ah(async (req, res) => {
  const all = req.query.all === '1' && can(req.ctx, 'shifts.manage');
  const me = req.ctx.userId;
  const [swaps, covers] = await Promise.all([
    prisma.shiftSwap.findMany({ where: all ? {} : { OR: [{ requesterId: me }, { targetUserId: me }] }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.shiftCoverage.findMany({ where: all ? {} : { OR: [{ requesterId: me }, { ownerId: me }] }, orderBy: { createdAt: 'desc' }, take: 100, include: { assignment: { include: slotInclude } } }),
  ]);
  const slots = await prisma.shiftAssignment.findMany({ where: { id: { in: swaps.flatMap((s) => [s.fromAssignmentId, s.toAssignmentId]) } }, include: slotInclude });
  const slot = (id: string) => { const a = slots.find((x) => x.id === id); return a && { id: a.id, date: dateOnlyStr(a.date), startTime: a.startTime, endTime: a.endTime, shift: a.shift }; };
  const who = await names([...swaps.flatMap((s) => [s.requesterId, s.targetUserId]), ...covers.flatMap((c) => [c.requesterId, c.ownerId])]);
  res.json({
    swaps: swaps.map((s) => ({ ...s, requester: who[s.requesterId]?.fullName, target: who[s.targetUserId]?.fullName, from: slot(s.fromAssignmentId), to: slot(s.toAssignmentId), incoming: s.targetUserId === me })),
    coverages: covers.map((c) => ({
      ...c, assignment: undefined, requester: who[c.requesterId]?.fullName, owner: who[c.ownerId]?.fullName, incoming: c.ownerId === me,
      slot: { id: c.assignment.id, date: dateOnlyStr(c.assignment.date), startTime: c.assignment.startTime, endTime: c.assignment.endTime, shift: c.assignment.shift },
    })),
  });
}));

// ── Late arrivals / extensions ──

shiftsRouter.post('/handovers', requirePerm('shifts.handover'), ah(async (req, res) => {
  const b = parse(z.object({ nextAssignmentId: z.string().uuid(), lateMinutes: z.coerce.number().int().min(0).max(720), extendedMinutes: z.coerce.number().int().min(0).max(720), reason: nullableStr(300) }), req.body);
  res.status(201).json(await prisma.$transaction((tx) => recordHandover(tx, req.ctx, { ...b, reason: b.reason ?? null })));
}));

shiftsRouter.get('/handovers/list', requirePerm('shifts.view'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ from: ymdStr.optional(), to: ymdStr.optional(), userId: z.string().uuid().optional() }), req.query);
  const seeAll = can(req.ctx, 'shifts.manage') || can(req.ctx, 'shifts.handover');
  const who = seeAll ? q.userId : req.ctx.userId;
  const { from, to } = rangeFromQuery(q.from ?? dateOnlyStr(addDays(new Date(), -30)), q.to ?? dateOnlyStr(new Date()));
  const where: Prisma.ShiftHandoverWhereInput = { createdAt: { gte: from, lte: to }, ...(who && { OR: [{ nextUserId: who }, { prevUserId: who }] }) };
  const [items, total, sums] = await Promise.all([
    prisma.shiftHandover.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
    prisma.shiftHandover.count({ where }),
    prisma.shiftHandover.aggregate({ where, _sum: { lateMinutes: true, extendedMinutes: true } }),
  ]);
  const u = await names(items.flatMap((h) => [h.nextUserId, h.prevUserId, h.recordedById]));
  res.json({ ...paged(items.map((h) => ({ ...h, next: h.nextUserId ? u[h.nextUserId]?.fullName : null, prev: h.prevUserId ? u[h.prevUserId]?.fullName : null, recordedBy: u[h.recordedById]?.fullName })), total, q), totals: sums._sum });
}));

/** Shift history log (purchases, protections, releases, swaps, coverage, handovers). Own entries unless manager. */
shiftsRouter.get('/events/list', requirePerm('shifts.view'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ from: ymdStr.optional(), to: ymdStr.optional(), userId: z.string().uuid().optional(), type: z.string().optional() }), req.query);
  const seeAll = can(req.ctx, 'shifts.manage') || can(req.ctx, 'ecoin.view_all');
  const who = seeAll ? q.userId : req.ctx.userId;
  const { from, to } = rangeFromQuery(q.from ?? dateOnlyStr(addDays(new Date(), -30)), q.to ?? dateOnlyStr(new Date()));
  const where: Prisma.ShiftEventWhereInput = {
    createdAt: { gte: from, lte: to },
    ...(q.type && { type: q.type as ShiftEventType }),
    ...(who && { OR: [{ fromUserId: who }, { toUserId: who }] }),
    // A nurse never sees coin details of doctors' shifts beyond his own history.
  };
  const [items, total] = await Promise.all([
    prisma.shiftEvent.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: { assignment: { include: slotInclude } } }),
    prisma.shiftEvent.count({ where }),
  ]);
  const u = await names(items.flatMap((e) => [e.fromUserId, e.toUserId, e.createdById]));
  res.json(paged(items.map((e) => ({
    id: e.id, type: e.type, createdAt: e.createdAt, price: e.price, note: e.note,
    from: e.fromUserId ? u[e.fromUserId]?.fullName : null, to: e.toUserId ? u[e.toUserId]?.fullName : null, by: e.createdById ? u[e.createdById]?.fullName : null,
    slot: { id: e.assignment.id, date: dateOnlyStr(e.assignment.date), startTime: e.assignment.startTime, endTime: e.assignment.endTime, shift: e.assignment.shift },
  })), total, q));
}));

// ── Exchange settings (swap / release / coverage), part of the general settings ──

shiftsRouter.get('/settings/exchange', requireAnyPerm('shifts.manage', 'shifts.view'), ah(async (_req, res) => res.json(await getSetting('shiftExchange'))));
shiftsRouter.put('/settings/exchange', requirePerm('shifts.manage'), ah(async (req, res) => {
  const current = await getSetting('shiftExchange');
  const value = settingSchemas.shiftExchange.parse({ ...current, ...req.body });
  if (value.minCoverMinutes > value.maxCoverMinutes) throw badRequest('الحد الأدنى للتغطية أكبر من الحد الأقصى');
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({ where: { key: 'shiftExchange' }, create: { key: 'shiftExchange', value, updatedBy: req.ctx.userId }, update: { value, updatedBy: req.ctx.userId } });
    await audit(tx, req.ctx, { action: 'settings.update', entityType: 'setting', entityId: 'shiftExchange', before: current, after: value });
  });
  res.json(value);
}));

