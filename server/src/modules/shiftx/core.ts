import type { Prisma, ShiftAssignment, ShiftPriceRule } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import { can } from '../../auth/context';
import type { Db, Tx } from '../../lib/prisma';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { addDays, dateOnlyStr } from '../../lib/dates';
import { getSetting, type SettingValue } from '../../lib/settings';
import { shiftWindow } from '../staff/attendance';

/** Shared rules of the shift exchange. All times come from the server clock, never from the browser. */

export type Slot = ShiftAssignment & { shift: { id: string; name: string; type: string; color: string | null } };
export const slotInclude = { shift: { select: { id: true, name: true, type: true, color: true } } } satisfies Prisma.ShiftAssignmentInclude;

export const windowOf = (a: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'>) => shiftWindow(a);
export const hoursOf = (a: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'>) => {
  const w = windowOf(a);
  return (w.end.getTime() - w.start.getTime()) / 3_600_000;
};
export const minutesUntil = (d: Date, now = new Date()) => (d.getTime() - now.getTime()) / 60_000;

/** Locks one slot row for the rest of the transaction (so two buyers can never both get it). */
export async function lockSlot(tx: Tx, id: string): Promise<Slot> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "shift_assignments" WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw notFound('الشفت غير موجود');
  return tx.shiftAssignment.findUniqueOrThrow({ where: { id }, include: slotInclude });
}

export function ensureNotStarted(a: Slot, leadMinutes: number, what: string, now = new Date()) {
  const { start, end } = windowOf(a);
  if (end <= now) throw badRequest(`لا يمكن ${what}: الشفت انتهى`);
  if (start <= now) throw badRequest(`لا يمكن ${what}: الشفت بدأ بالفعل`);
  if (minutesUntil(start, now) <= leadMinutes) throw badRequest(`لا يمكن ${what}: يبدأ الشفت خلال ${leadMinutes} دقيقة أو أقل`);
}

/** Refuses when the user already works at that time (or is on approved leave that day). */
export async function ensureFree(tx: Tx, userId: string, a: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'>, excludeIds: string[] = []) {
  const w = windowOf(a);
  const near = await tx.shiftAssignment.findMany({
    where: { userId, date: { gte: addDays(a.date, -1), lte: addDays(a.date, 1) }, id: { notIn: excludeIds } },
    include: { shift: { select: { name: true } } },
  });
  const clash = near.find((o) => { const ow = windowOf(o); return ow.start < w.end && w.start < ow.end; });
  if (clash) throw badRequest(`يوجد تعارض مع دوام آخر للموظف: ${clash.shift.name} بتاريخ ${dateOnlyStr(clash.date)} (${clash.startTime}–${clash.endTime})`);
  const leave = await tx.leave.findFirst({ where: { userId, status: 'APPROVED', startDate: { lte: a.date }, endDate: { gte: a.date } } });
  if (leave) throw badRequest('الموظف في إجازة معتمدة في ذلك اليوم');
}

export async function ensureDoctor(tx: Tx, ctx: Ctx) {
  if (!can(ctx, 'ecoin.use')) throw forbidden('لا تملك صلاحية استخدام E Coin');
  const u = await tx.user.findUnique({ where: { id: ctx.userId }, select: { staffType: true } });
  if (u?.staffType !== 'DOCTOR') throw forbidden('نظام E Coin مخصص للأطباء فقط');
  const cfg = await getSetting('ecoin', tx);
  if (!cfg.enabled) throw badRequest('نظام E Coin متوقف من الإدارة');
  return cfg;
}

// ── Prices ──

export type PriceSource = 'DATE' | 'WEEKDAY' | 'DURATION' | 'OTHER';
/** Base price of a slot: rule for its date, else for its weekday, else by its length. */
export function basePrice(a: Pick<ShiftAssignment, 'shiftId' | 'date' | 'startTime' | 'endTime'>, rules: ShiftPriceRule[], cfg: SettingValue<'ecoin'>): { price: number; source: PriceSource; ruleId?: string } {
  const day = dateOnlyStr(a.date);
  const mine = rules.filter((r) => r.isActive && r.shiftId === a.shiftId);
  const byDate = mine.find((r) => r.date && dateOnlyStr(r.date) === day);
  if (byDate) return { price: byDate.price, source: 'DATE', ruleId: byDate.id };
  const byWeekday = mine.find((r) => r.weekday != null && r.weekday === a.date.getUTCDay());
  if (byWeekday) return { price: byWeekday.price, source: 'WEEKDAY', ruleId: byWeekday.id };
  const h = hoursOf(a);
  const byLength = cfg.durationPrices.find((d) => Math.abs(d.hours - h) < 0.01);
  return byLength ? { price: byLength.price, source: 'DURATION' } : { price: cfg.otherPrice, source: 'OTHER' };
}

/** Purchase price for a buyer: base minus his active incentive discount (never below zero). */
export async function purchasePrice(tx: Db, buyerId: string, a: Slot, cfg: SettingValue<'ecoin'>) {
  const rules = await tx.shiftPriceRule.findMany({ where: { shiftId: a.shiftId, isActive: true } });
  const base = basePrice(a, rules, cfg);
  const penalty = cfg.penaltyEnabled ? await tx.eCoinPenalty.findFirst({ where: { userId: buyerId, status: 'ACTIVE', usesLeft: { gt: 0 } }, orderBy: { triggeredAt: 'asc' } }) : null;
  const discount = penalty ? Math.min(penalty.discount, base.price) : 0;
  return { base: base.price, source: base.source, discount, price: Math.max(0, base.price - discount), penalty };
}

// ── State of a slot for one viewer ──

export type SlotStatus = 'AVAILABLE' | 'VACANT' | 'SECURED' | 'PURCHASED' | 'TOO_LATE' | 'STARTED' | 'ENDED';
export interface Viewer { userId: string; isDoctor: boolean; canEcoin: boolean; canSwap: boolean; canRelease: boolean; canCover: boolean }

export function slotState(a: Slot, viewer: Viewer, cfg: SettingValue<'ecoin'>, ex: SettingValue<'shiftExchange'>, now = new Date()) {
  const { start, end } = windowOf(a);
  const mine = a.userId === viewer.userId;
  const lead = minutesUntil(start, now);
  let status: SlotStatus;
  if (end <= now) status = 'ENDED';
  else if (start <= now) status = 'STARTED';
  else if (a.holding === 'SECURED') status = 'SECURED';
  else if (a.holding === 'PURCHASED') status = 'PURCHASED';
  else if (lead <= cfg.purchaseLeadMinutes) status = 'TOO_LATE';
  else status = a.holding === 'VACANT' ? 'VACANT' : 'AVAILABLE';

  const doctorSlot = a.staffType === 'DOCTOR';
  const ecoinOn = cfg.enabled && viewer.isDoctor && viewer.canEcoin && doctorSlot;
  let lockReason: string | null = null;
  const canBuy = ecoinOn && !mine && (status === 'AVAILABLE' || status === 'VACANT');
  if (!canBuy) {
    lockReason =
      status === 'ENDED' ? 'انتهى الشفت'
      : status === 'STARTED' ? 'بدأ الشفت بالفعل'
      : status === 'SECURED' ? (mine ? 'شفتك مؤمَّن: لا يستطيع أحد شراءه' : 'قام صاحبه بتأمينه، فلا يمكن شراؤه')
      : status === 'PURCHASED' ? (mine ? 'اشتريت هذا الشفت وهو محمي باسمك' : 'تم شراؤه من طبيب آخر وأصبح ملكاً له')
      : status === 'TOO_LATE' ? `يبدأ خلال ${cfg.purchaseLeadMinutes} دقيقة أو أقل، فلم يعد قابلاً للشراء`
      : mine ? 'هذا شفتك: يمكنك تأمينه بدلاً من شرائه'
      : !doctorSlot ? 'الشراء بالعملات لشفتات الأطباء فقط'
      : !cfg.enabled ? 'نظام E Coin متوقف'
      : 'الشراء بالعملات متاح للأطباء فقط';
  }
  const notStarted = start > now;
  const changeOk = notStarted && lead > ex.changeLeadMinutes;
  return {
    status, start, end, mine, canBuy, lockReason,
    canSecure: ecoinOn && mine && a.holding === 'ASSIGNED' && notStarted,
    canRelease: ex.releaseEnabled && viewer.canRelease && mine && changeOk,
    canSwapFrom: ex.swapEnabled && viewer.canSwap && mine && changeOk,
    canSwapWith: ex.swapEnabled && viewer.canSwap && !mine && !!a.userId && changeOk,
  };
}

export async function viewerOf(tx: Db, ctx: Ctx): Promise<Viewer> {
  const u = await tx.user.findUnique({ where: { id: ctx.userId }, select: { staffType: true } });
  return {
    userId: ctx.userId, isDoctor: u?.staffType === 'DOCTOR', canEcoin: can(ctx, 'ecoin.use'),
    canSwap: can(ctx, 'shifts.swap'), canRelease: can(ctx, 'shifts.release'), canCover: can(ctx, 'shifts.cover'),
  };
}

/** Pending swap/coverage requests on a slot that just changed hands are no longer valid. */
export async function closeOpenRequests(tx: Tx, slotId: string, why: string) {
  const swaps = await tx.shiftSwap.findMany({ where: { status: 'PENDING', OR: [{ fromAssignmentId: slotId }, { toAssignmentId: slotId }] } });
  if (swaps.length) await tx.shiftSwap.updateMany({ where: { id: { in: swaps.map((s) => s.id) } }, data: { status: 'CANCELLED', note: why, respondedAt: new Date() } });
  const covers = await tx.shiftCoverage.findMany({ where: { status: 'PENDING', assignmentId: slotId } });
  if (covers.length) await tx.shiftCoverage.updateMany({ where: { id: { in: covers.map((c) => c.id) } }, data: { status: 'CANCELLED', note: why, respondedAt: new Date() } });
  return { swaps, covers };
}

export const fmtSlot = (a: Pick<Slot, 'date' | 'startTime' | 'endTime'> & { shift: { name: string } }) => `${a.shift.name} ${dateOnlyStr(a.date)} (${a.startTime}–${a.endTime})`;
