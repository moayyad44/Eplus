import { Prisma } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import { can } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { prisma } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { notifyPermission, notifyUsers } from '../../lib/notify';
import { dateOnlyStr } from '../../lib/dates';
import { debit } from '../ecoin/wallet';
import { refreshPenalty } from '../ecoin/penalty';
import { closeOpenRequests, ensureDoctor, ensureFree, ensureNotStarted, fmtSlot, lockSlot, minutesUntil, purchasePrice, windowOf, type Slot } from './core';

const name = async (tx: Tx, id: string | null) => (id ? (await tx.user.findUnique({ where: { id }, select: { fullName: true } }))?.fullName ?? '' : 'شاغر');

/** A request id already used: return what it did the first time (resent request, lost answer, double click). */
async function replay(tx: Tx, ctx: Ctx, key: string | undefined, type: 'PURCHASE' | 'SECURE') {
  if (!key) return null;
  const prev = await tx.eCoinTxn.findUnique({ where: { idempotencyKey: key } });
  if (!prev) return null;
  if (prev.userId !== ctx.userId || prev.type !== type) throw conflict('رقم الطلب مستخدم في عملية أخرى');
  return prev;
}

// ── Buy another doctor's (or a vacant) shift ──

export async function buyShift(tx: Tx, ctx: Ctx, slotId: string, requestId?: string) {
  const cfg = await ensureDoctor(tx, ctx);
  const done = await replay(tx, ctx, requestId, 'PURCHASE');
  if (done) return { txn: done, replayed: true };
  const a = await lockSlot(tx, slotId);
  // The same request may have completed while we waited for the lock: answer with its result.
  const raced = await replay(tx, ctx, requestId, 'PURCHASE');
  if (raced) return { txn: raced, replayed: true };
  if (a.staffType !== 'DOCTOR') throw badRequest('لا يمكن شراء هذا الشفت بالعملات: ليس شفت طبيب');
  if (a.userId === ctx.userId) throw badRequest('هذا شفتك بالفعل. يمكنك تأمينه بدلاً من شرائه');
  if (a.holding === 'SECURED') throw badRequest('لا يمكن شراء الشفت: قام صاحبه بتأمينه');
  if (a.holding === 'PURCHASED') throw badRequest('لا يمكن شراء الشفت: تم شراؤه من طبيب آخر');
  ensureNotStarted(a, cfg.purchaseLeadMinutes, 'شراء الشفت');
  await ensureFree(tx, ctx.userId, a, [a.id]);
  const p = await purchasePrice(tx, a, cfg);
  const prevId = a.userId;
  const txn = await debit(tx, ctx.userId, p.price, {
    type: 'PURCHASE', assignmentId: a.id, idempotencyKey: requestId ?? null, createdById: ctx.userId,
    reason: `شراء شفت ${fmtSlot(a)} من ${await name(tx, prevId)}`,
    meta: { basePrice: p.base, priceSource: p.source, discount: p.discount, penaltyId: p.penalty?.id ?? null, previousHolderId: prevId, previousHolding: a.holding },
  });
  await tx.shiftAssignment.update({ where: { id: a.id }, data: { userId: ctx.userId, holding: 'PURCHASED', securedAt: null } });
  await tx.shiftEvent.create({ data: { assignmentId: a.id, type: 'PURCHASED', fromUserId: prevId, toUserId: ctx.userId, price: p.price, txnId: txn.id, createdById: ctx.userId, note: p.discount ? `سعر ${p.base} − تخفيض ${p.discount}` : null } });
  await closeOpenRequests(tx, a.id, 'انتقلت ملكية الشفت بالشراء');
  if (p.penalty && p.discount > 0) await refreshPenalty(tx, p.penalty);
  await audit(tx, ctx, { action: 'shift.purchase', entityType: 'shift_assignment', entityId: a.id, summary: `شراء ${fmtSlot(a)} بـ ${p.price} E Coin من ${await name(tx, prevId)}`, after: { buyer: ctx.userId, previousHolderId: prevId, price: p.price, txnId: txn.id } });
  await notifyUsers([ctx.userId], { type: 'ECOIN', title: 'تم شراء الشفت', body: `${fmtSlot(a)} — خُصم ${p.price} E Coin. رصيدك الآن ${txn.balanceAfter}`, link: '/staff/board', dedupeKey: `buy:${txn.id}` }, tx);
  if (prevId) await notifyUsers([prevId], { type: 'SHIFT_EXCHANGE', title: 'خسرت شفتاً', body: `اشترى ${ctx.userName} شفتك ${fmtSlot(a)}`, link: '/staff/board', dedupeKey: `lost:${txn.id}` }, tx);
  return { txn, replayed: false };
}

// ── Secure one's own shift ──

export async function secureShift(tx: Tx, ctx: Ctx, slotId: string, requestId?: string) {
  const cfg = await ensureDoctor(tx, ctx);
  const done = await replay(tx, ctx, requestId, 'SECURE');
  if (done) return { txn: done, replayed: true };
  const a = await lockSlot(tx, slotId);
  const raced = await replay(tx, ctx, requestId, 'SECURE');
  if (raced) return { txn: raced, replayed: true };
  if (a.userId !== ctx.userId) throw badRequest('لا يمكن تأمين شفت ليس باسمك (ربما انتقلت ملكيته لطبيب آخر)');
  if (a.holding === 'SECURED') throw badRequest('الشفت مؤمَّن مسبقاً');
  if (a.holding === 'PURCHASED') throw badRequest('الشفت الذي اشتريته محمي أصلاً ولا يحتاج تأميناً');
  if (windowOf(a).start <= new Date()) throw badRequest('لا يمكن تأمين شفت بدأ أو انتهى');
  const txn = await debit(tx, ctx.userId, cfg.securePrice, { type: 'SECURE', assignmentId: a.id, idempotencyKey: requestId ?? null, createdById: ctx.userId, reason: `تأمين شفت ${fmtSlot(a)}` });
  await tx.shiftAssignment.update({ where: { id: a.id }, data: { holding: 'SECURED', securedAt: new Date() } });
  await tx.shiftEvent.create({ data: { assignmentId: a.id, type: 'SECURED', fromUserId: ctx.userId, toUserId: ctx.userId, price: cfg.securePrice, txnId: txn.id, createdById: ctx.userId } });
  await audit(tx, ctx, { action: 'shift.secure', entityType: 'shift_assignment', entityId: a.id, summary: `تأمين ${fmtSlot(a)} بـ ${cfg.securePrice} E Coin` });
  await notifyUsers([ctx.userId], { type: 'ECOIN', title: 'تم تأمين شفتك', body: `${fmtSlot(a)} أصبح محمياً من الشراء. رصيدك الآن ${txn.balanceAfter}`, link: '/staff/board', dedupeKey: `secure:${txn.id}` }, tx);
  return { txn, replayed: false };
}

// ── Release (give up) one's shift: no refund, no compensation ──

export async function releaseShift(tx: Tx, ctx: Ctx, slotId: string, reason: string | null) {
  if (!can(ctx, 'shifts.release')) throw forbidden('لا تملك صلاحية التنازل عن الشفت');
  const ex = await getSetting('shiftExchange', tx);
  if (!ex.releaseEnabled) throw badRequest('التنازل عن الشفتات متوقف من الإدارة');
  const a = await lockSlot(tx, slotId);
  if (a.userId !== ctx.userId) throw forbidden('لا يمكنك التنازل إلا عن شفت باسمك');
  ensureNotStarted(a, ex.changeLeadMinutes, 'التنازل عن الشفت');
  await tx.shiftAssignment.update({ where: { id: a.id }, data: { userId: null, holding: 'VACANT', securedAt: null } });
  await tx.shiftEvent.create({ data: { assignmentId: a.id, type: 'RELEASED', fromUserId: ctx.userId, note: reason ?? `كان ${a.holding === 'SECURED' ? 'مؤمَّناً' : a.holding === 'PURCHASED' ? 'مشترى' : 'موزعاً'} — لا استرجاع للعملات`, createdById: ctx.userId } });
  await closeOpenRequests(tx, a.id, 'تنازل صاحب الشفت عنه');
  await audit(tx, ctx, { action: 'shift.release', entityType: 'shift_assignment', entityId: a.id, summary: `تنازل ${ctx.userName} عن ${fmtSlot(a)}${reason ? ` — ${reason}` : ''}` });
  await notifyPermission('shifts.manage', { type: 'SHIFT_EXCHANGE', title: 'شفت شاغر', body: `تنازل ${ctx.userName} عن ${fmtSlot(a)}`, link: '/staff/board', dedupeKey: `released:${a.id}:${Date.now()}` }, tx, ctx.userId);
}

// ── Administration: give a slot to someone (e.g. a vacant one) ──

export async function adminAssign(tx: Tx, ctx: Ctx, slotId: string, userId: string, reason: string) {
  if (!can(ctx, 'shifts.manage')) throw forbidden();
  const a = await lockSlot(tx, slotId);
  if (windowOf(a).start <= new Date()) throw badRequest('لا يمكن تغيير صاحب شفت بدأ أو انتهى');
  if (a.userId === userId) throw badRequest('الشفت باسم هذا الموظف بالفعل');
  const u = await tx.user.findFirst({ where: { id: userId, isActive: true, deletedAt: null }, select: { fullName: true, staffType: true } });
  if (!u) throw notFound('الموظف غير موجود');
  if (a.staffType && u.staffType !== a.staffType) throw badRequest('هذا الشفت لفئة أخرى من الموظفين');
  await ensureFree(tx, userId, a, [a.id]);
  await tx.shiftAssignment.update({ where: { id: a.id }, data: { userId, holding: 'ASSIGNED', securedAt: null, staffType: a.staffType ?? u.staffType } });
  await tx.shiftEvent.create({ data: { assignmentId: a.id, type: 'REASSIGNED', fromUserId: a.userId, toUserId: userId, note: reason, createdById: ctx.userId } });
  await closeOpenRequests(tx, a.id, 'أعادت الإدارة توزيع الشفت');
  await audit(tx, ctx, { action: 'shift.reassign', entityType: 'shift_assignment', entityId: a.id, summary: `إعادة توزيع ${fmtSlot(a)} من ${await name(tx, a.userId)} إلى ${u.fullName} — ${reason}` });
  await notifyUsers([userId], { type: 'SHIFT_EXCHANGE', title: 'شفت جديد باسمك', body: fmtSlot(a), link: '/staff/board' }, tx);
  if (a.userId) await notifyUsers([a.userId], { type: 'SHIFT_EXCHANGE', title: 'أُعيد توزيع شفتك', body: `${fmtSlot(a)} أصبح باسم ${u.fullName}`, link: '/staff/board' }, tx);
}

// ── Swaps (both sides agree) ──

export async function requestSwap(tx: Tx, ctx: Ctx, fromId: string, toId: string, note: string | null) {
  if (!can(ctx, 'shifts.swap')) throw forbidden('لا تملك صلاحية طلب التبديل');
  const ex = await getSetting('shiftExchange', tx);
  if (!ex.swapEnabled) throw badRequest('تبديل الشفتات متوقف من الإدارة');
  if (fromId === toId) throw badRequest('اختر شفتين مختلفين');
  const order = [fromId, toId].sort();
  const got = new Map<string, Slot>();
  for (const id of order) got.set(id, await lockSlot(tx, id)); // fixed lock order: no deadlocks
  const from = got.get(fromId)!, to = got.get(toId)!;
  if (from.userId !== ctx.userId) throw forbidden('اختر شفتاً باسمك لتبديله');
  if (!to.userId || to.userId === ctx.userId) throw badRequest('اختر شفتاً لموظف آخر');
  if (from.staffType !== to.staffType) throw badRequest('التبديل يكون بين شفتات الفئة نفسها (طبيب مع طبيب، ممرض مع ممرض)');
  if (from.shiftId === to.shiftId && dateOnlyStr(from.date) === dateOnlyStr(to.date)) throw badRequest('الشفتان متطابقان في اليوم والوقت');
  ensureNotStarted(from, ex.changeLeadMinutes, 'التبديل');
  ensureNotStarted(to, ex.changeLeadMinutes, 'التبديل');
  const dup = await tx.shiftSwap.findFirst({ where: { status: 'PENDING', fromAssignmentId: from.id, toAssignmentId: to.id } });
  if (dup) throw badRequest('أرسلت طلب التبديل هذا مسبقاً');
  const s = await tx.shiftSwap.create({ data: { requesterId: ctx.userId, targetUserId: to.userId, fromAssignmentId: from.id, toAssignmentId: to.id, note } });
  await audit(tx, ctx, { action: 'shift.swap_request', entityType: 'shift_swap', entityId: s.id, summary: `طلب تبديل ${fmtSlot(from)} ↔ ${fmtSlot(to)}` });
  await notifyUsers([to.userId], { type: 'SHIFT_EXCHANGE', title: `طلب تبديل شفت من ${ctx.userName}`, body: `يعطيك ${fmtSlot(from)} مقابل ${fmtSlot(to)}`, link: '/staff/board?tab=requests', dedupeKey: `swap:${s.id}` }, tx);
  return s;
}

export async function respondSwap(tx: Tx, ctx: Ctx, swapId: string, decision: 'ACCEPT' | 'REJECT' | 'CANCEL') {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "shift_swaps" WHERE id = ${swapId} FOR UPDATE`;
  if (!rows.length) throw notFound('الطلب غير موجود');
  const s = await tx.shiftSwap.findUniqueOrThrow({ where: { id: swapId } });
  if (s.status !== 'PENDING') throw badRequest('تمت معالجة هذا الطلب مسبقاً');
  if (decision === 'CANCEL') {
    if (s.requesterId !== ctx.userId) throw forbidden();
    return tx.shiftSwap.update({ where: { id: s.id }, data: { status: 'CANCELLED', respondedAt: new Date() } });
  }
  if (s.targetUserId !== ctx.userId) throw forbidden('هذا الطلب ليس موجهاً إليك');
  if (!can(ctx, 'shifts.swap')) throw forbidden('لا تملك صلاحية التبديل');
  if (decision === 'REJECT') {
    const r = await tx.shiftSwap.update({ where: { id: s.id }, data: { status: 'REJECTED', respondedAt: new Date() } });
    await notifyUsers([s.requesterId], { type: 'SHIFT_EXCHANGE', title: 'رُفض طلب التبديل', body: `رفض ${ctx.userName} طلب التبديل`, link: '/staff/board?tab=requests', dedupeKey: `swap-r:${s.id}` }, tx);
    return r;
  }
  const ex = await getSetting('shiftExchange', tx);
  // Lock both slots in a fixed order (no deadlock with a concurrent purchase), then re-check everything.
  const [first, second] = [s.fromAssignmentId, s.toAssignmentId].sort();
  const locked = new Map<string, Slot>([[first, await lockSlot(tx, first)], [second, await lockSlot(tx, second)]]);
  const from = locked.get(s.fromAssignmentId)!, to = locked.get(s.toAssignmentId)!;
  if (from.userId !== s.requesterId || to.userId !== s.targetUserId) {
    await tx.shiftSwap.update({ where: { id: s.id }, data: { status: 'CANCELLED', note: 'تغيّر صاحب أحد الشفتين', respondedAt: new Date() } });
    throw badRequest('تغيّر صاحب أحد الشفتين منذ إرسال الطلب، فأُلغي الطلب');
  }
  ensureNotStarted(from, ex.changeLeadMinutes, 'التبديل');
  ensureNotStarted(to, ex.changeLeadMinutes, 'التبديل');
  await ensureFree(tx, s.requesterId, to, [from.id, to.id]);
  await ensureFree(tx, s.targetUserId, from, [from.id, to.id]);
  // Each shift keeps its own protection (secured / purchased) — it moves with the shift, documented in its history.
  await tx.shiftAssignment.update({ where: { id: from.id }, data: { userId: s.targetUserId } });
  await tx.shiftAssignment.update({ where: { id: to.id }, data: { userId: s.requesterId } });
  await tx.shiftEvent.createMany({ data: [
    { assignmentId: from.id, type: 'SWAPPED', fromUserId: s.requesterId, toUserId: s.targetUserId, refId: s.id, createdById: ctx.userId, note: from.holding !== 'ASSIGNED' ? `بقيت حالة الحماية: ${from.holding}` : null },
    { assignmentId: to.id, type: 'SWAPPED', fromUserId: s.targetUserId, toUserId: s.requesterId, refId: s.id, createdById: ctx.userId, note: to.holding !== 'ASSIGNED' ? `بقيت حالة الحماية: ${to.holding}` : null },
  ] });
  const r = await tx.shiftSwap.update({ where: { id: s.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
  await closeOpenRequests(tx, from.id, 'تم تبديل الشفت');
  await closeOpenRequests(tx, to.id, 'تم تبديل الشفت');
  await audit(tx, ctx, { action: 'shift.swap', entityType: 'shift_swap', entityId: s.id, summary: `تبديل ${fmtSlot(from)} ↔ ${fmtSlot(to)} بين ${await name(tx, s.requesterId)} و${ctx.userName}` });
  await notifyUsers([s.requesterId], { type: 'SHIFT_EXCHANGE', title: 'قُبل طلب التبديل', body: `أصبح ${fmtSlot(to)} باسمك`, link: '/staff/board', dedupeKey: `swap-a:${s.id}` }, tx);
  return r;
}

// ── Partial coverage: the previous shift's holder covers the first part of the next shift ──

export async function requestCoverage(tx: Tx, ctx: Ctx, nextId: string, minutes: number, note: string | null) {
  if (!can(ctx, 'shifts.cover')) throw forbidden('لا تملك صلاحية طلب التغطية');
  const ex = await getSetting('shiftExchange', tx);
  if (!ex.coverEnabled) throw badRequest('التغطية الجزئية متوقفة من الإدارة');
  const next = await lockSlot(tx, nextId);
  if (!next.userId || next.userId === ctx.userId) throw badRequest('اختر شفت الموظف التالي لك');
  const w = windowOf(next);
  const mine = await tx.shiftAssignment.findMany({ where: { userId: ctx.userId, date: { in: [next.date, new Date(next.date.getTime() - 86_400_000)] } } });
  const prev = mine.find((m) => windowOf(m).end.getTime() === w.start.getTime());
  if (!prev) throw badRequest('التغطية الجزئية تكون للشفت الذي يبدأ مباشرة بعد نهاية شفتك');
  if (!(minutes >= ex.minCoverMinutes && minutes <= ex.maxCoverMinutes)) throw badRequest(`مدة التغطية بين ${ex.minCoverMinutes} و${ex.maxCoverMinutes} دقيقة`);
  const total = (w.end.getTime() - w.start.getTime()) / 60_000;
  if (minutes >= total) throw badRequest('مدة التغطية يجب أن تكون أقل من مدة الشفت (وإلا فهي تبديل أو تنازل)');
  const startAt = w.start, endAt = new Date(w.start.getTime() + minutes * 60_000);
  if (endAt <= new Date()) throw badRequest('انتهت فترة التغطية المطلوبة');
  const clash = await tx.shiftCoverage.findFirst({ where: { assignmentId: next.id, status: { in: ['PENDING', 'ACCEPTED'] }, startAt: { lt: endAt }, endAt: { gt: startAt } } });
  if (clash) throw badRequest('يوجد طلب تغطية آخر لهذه الفترة');
  const c = await tx.shiftCoverage.create({ data: { assignmentId: next.id, requesterId: ctx.userId, ownerId: next.userId, minutes, startAt, endAt, note } });
  await audit(tx, ctx, { action: 'shift.cover_request', entityType: 'shift_coverage', entityId: c.id, summary: `طلب تغطية أول ${minutes} دقيقة من ${fmtSlot(next)}` });
  await notifyUsers([next.userId], { type: 'SHIFT_EXCHANGE', title: `طلب تغطية من ${ctx.userName}`, body: `يغطي أول ${minutes} دقيقة من شفتك ${fmtSlot(next)}`, link: '/staff/board?tab=requests', dedupeKey: `cover:${c.id}` }, tx);
  return c;
}

export async function respondCoverage(tx: Tx, ctx: Ctx, id: string, decision: 'ACCEPT' | 'REJECT' | 'CANCEL') {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "shift_coverages" WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw notFound('الطلب غير موجود');
  const c = await tx.shiftCoverage.findUniqueOrThrow({ where: { id } });
  if (c.status !== 'PENDING') throw badRequest('تمت معالجة هذا الطلب مسبقاً');
  if (decision === 'CANCEL') {
    if (c.requesterId !== ctx.userId) throw forbidden();
    return tx.shiftCoverage.update({ where: { id }, data: { status: 'CANCELLED', respondedAt: new Date() } });
  }
  if (c.ownerId !== ctx.userId) throw forbidden('هذا الطلب ليس موجهاً إليك');
  const slot = await lockSlot(tx, c.assignmentId);
  if (decision === 'REJECT') {
    const r = await tx.shiftCoverage.update({ where: { id }, data: { status: 'REJECTED', respondedAt: new Date() } });
    await notifyUsers([c.requesterId], { type: 'SHIFT_EXCHANGE', title: 'رُفض طلب التغطية', body: `${ctx.userName} — ${fmtSlot(slot)}`, link: '/staff/board?tab=requests', dedupeKey: `cover-r:${id}` }, tx);
    return r;
  }
  if (slot.userId !== c.ownerId) throw badRequest('تغيّر صاحب الشفت منذ إرسال الطلب');
  if (c.endAt <= new Date()) throw badRequest('انتهت فترة التغطية المطلوبة');
  const r = await tx.shiftCoverage.update({ where: { id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
  await tx.shiftEvent.create({ data: { assignmentId: slot.id, type: 'COVERAGE', fromUserId: c.ownerId, toUserId: c.requesterId, refId: c.id, createdById: ctx.userId, note: `${await name(tx, c.requesterId)} يغطي أول ${c.minutes} دقيقة؛ بقية الشفت على ${ctx.userName}` } });
  await audit(tx, ctx, { action: 'shift.cover', entityType: 'shift_coverage', entityId: id, summary: `قبول تغطية أول ${c.minutes} دقيقة من ${fmtSlot(slot)}` });
  await notifyUsers([c.requesterId], { type: 'SHIFT_EXCHANGE', title: 'قُبل طلب التغطية', body: `تغطي أول ${c.minutes} دقيقة من ${fmtSlot(slot)}`, link: '/staff/board', dedupeKey: `cover-a:${id}` }, tx);
  return r;
}

// ── Late arrival / extension of the previous shift (recorded by an authorised user, no fingerprint needed) ──

export async function recordHandover(tx: Tx, ctx: Ctx, input: { nextAssignmentId: string; lateMinutes: number; extendedMinutes: number; reason: string | null }) {
  if (!can(ctx, 'shifts.handover')) throw forbidden('لا تملك صلاحية تسجيل التأخير والتمديد');
  if (input.lateMinutes < 0 || input.extendedMinutes < 0 || (!input.lateMinutes && !input.extendedMinutes)) throw badRequest('أدخل مدة التأخير أو التمديد');
  const next = await tx.shiftAssignment.findUnique({ where: { id: input.nextAssignmentId }, include: { shift: { select: { name: true } } } });
  if (!next) throw notFound('الشفت غير موجود');
  const w = windowOf(next);
  if (w.start > new Date()) throw badRequest('لا يمكن تسجيل تأخير لشفت لم يبدأ بعد');
  // The previous holder: a shift of the same staff category ending exactly when this one starts.
  const near = await tx.shiftAssignment.findMany({ where: { date: { in: [next.date, new Date(next.date.getTime() - 86_400_000)] }, staffType: next.staffType, id: { not: next.id }, userId: { not: null } }, include: { shift: { select: { name: true } } } });
  const prev = near.find((p) => windowOf(p).end.getTime() === w.start.getTime()) ?? null;
  if (input.extendedMinutes && !prev) throw badRequest('لا يوجد شفت سابق ينتهي عند بداية هذا الشفت لتمديده');
  const h = await tx.shiftHandover.create({
    data: {
      nextAssignmentId: next.id, nextUserId: next.userId, prevAssignmentId: prev?.id ?? null, prevUserId: prev?.userId ?? null,
      plannedStart: w.start, actualStart: input.lateMinutes ? new Date(w.start.getTime() + input.lateMinutes * 60_000) : w.start,
      plannedEnd: prev ? windowOf(prev).end : null, actualEnd: prev ? new Date(windowOf(prev).end.getTime() + input.extendedMinutes * 60_000) : null,
      lateMinutes: input.lateMinutes, extendedMinutes: input.extendedMinutes, reason: input.reason, recordedById: ctx.userId,
    },
  });
  // History only: holders and coins are not touched by a late arrival or an extension.
  await tx.shiftEvent.create({ data: { assignmentId: next.id, type: 'HANDOVER', fromUserId: prev?.userId ?? null, toUserId: next.userId, refId: h.id, createdById: ctx.userId, note: `تأخر ${input.lateMinutes} دقيقة` } });
  if (prev && input.extendedMinutes) await tx.shiftEvent.create({ data: { assignmentId: prev.id, type: 'HANDOVER', fromUserId: prev.userId, toUserId: next.userId, refId: h.id, createdById: ctx.userId, note: `تمديد ${input.extendedMinutes} دقيقة لتأخر الموظف التالي` } });
  await audit(tx, ctx, { action: 'shift.handover', entityType: 'shift_handover', entityId: h.id, summary: `تأخير ${input.lateMinutes} د / تمديد ${input.extendedMinutes} د — ${next.shift.name} ${dateOnlyStr(next.date)}${input.reason ? ` — ${input.reason}` : ''}` });
  const who = [next.userId, prev?.userId].filter(Boolean) as string[];
  await notifyUsers(who, { type: 'SHIFT_EXCHANGE', title: 'تسجيل تأخير/تمديد شفت', body: `${next.shift.name} ${dateOnlyStr(next.date)}: تأخير ${input.lateMinutes} د${input.extendedMinutes ? `، تمديد الشفت السابق ${input.extendedMinutes} د` : ''}`, link: '/staff/board?tab=log', dedupeKey: `handover:${h.id}` }, tx);
  return h;
}

/** Expire pending requests whose shifts already started (run by the background scanner). */
export async function expireStaleRequests(now = new Date()) {
  const swaps = await prisma.shiftSwap.findMany({ where: { status: 'PENDING' }, select: { id: true, fromAssignmentId: true, toAssignmentId: true } });
  const slots = await prisma.shiftAssignment.findMany({ where: { id: { in: swaps.flatMap((s) => [s.fromAssignmentId, s.toAssignmentId]) } } });
  const started = new Set(slots.filter((a) => windowOf(a).start <= now).map((a) => a.id));
  const stale = swaps.filter((s) => started.has(s.fromAssignmentId) || started.has(s.toAssignmentId)).map((s) => s.id);
  if (stale.length) await prisma.shiftSwap.updateMany({ where: { id: { in: stale } }, data: { status: 'EXPIRED', respondedAt: now } });
  await prisma.shiftCoverage.updateMany({ where: { status: 'PENDING', endAt: { lte: now } }, data: { status: 'EXPIRED', respondedAt: now } });
}

export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
export { minutesUntil };
