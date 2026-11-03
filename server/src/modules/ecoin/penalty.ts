import type { ECoinPenalty } from '@prisma/client';
import { prisma, type Db } from '../../lib/prisma';
import { getSetting } from '../../lib/settings';
import { notifyUsers } from '../../lib/notify';
import { addDays, dateOnly } from '../../lib/dates';
import { shiftWindow as windowOf } from '../staff/attendance';

/**
 * Incentive rule. A doctor's worked shifts are taken in consecutive blocks of N (default 5), each block evaluated
 * once (the wallet remembers up to where). If the coins he earned from lab activity during the shifts of a block
 * are below the minimum, his own next shifts (default 5) become cheaper for the other doctors to buy (default by
 * 1 E Coin). The discount belongs to him: it follows his shifts, not a shift that changed hands.
 *
 * "Worked" = he held the shift when it ended (ownership cannot change once a shift has started), and his
 * attendance for that day is not ABSENT / LEAVE and he has no approved leave. Shifts are only evaluated once
 * their day is over, after the daily automatic-absence pass, so a missed shift is never counted as worked.
 */
export async function evaluatePenalties(now = new Date()) {
  const cfg = await getSetting('ecoin');
  if (!cfg.enabled) return;
  for (const p of await prisma.eCoinPenalty.findMany({ where: { status: 'ACTIVE' } })) await refreshPenalty(prisma, p, now);
  const doctors = await prisma.user.findMany({ where: { staffType: 'DOCTOR', isActive: true, deletedAt: null }, select: { id: true } });
  const lastDay = addDays(dateOnly(now), -1); // only days already closed
  for (const { id: userId } of doctors) {
    const wallet = await prisma.eCoinWallet.upsert({ where: { userId }, create: { userId, penaltyCheckedThrough: now }, update: {} });
    // First run for this doctor: start counting from now (shifts before the system existed are not judged).
    if (!wallet.penaltyCheckedThrough) {
      await prisma.eCoinWallet.update({ where: { userId }, data: { penaltyCheckedThrough: now } });
      continue;
    }
    const since = wallet.penaltyCheckedThrough;
    const slots = await prisma.shiftAssignment.findMany({
      where: { userId, staffType: 'DOCTOR', date: { gte: addDays(dateOnly(since), -1), lte: lastDay } },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
    const ended = slots.map((a) => ({ a, w: windowOf(a) })).filter((x) => x.w.end > since && x.w.end <= now).sort((x, y) => x.w.end.getTime() - y.w.end.getTime());
    if (!ended.length) continue;
    const days = ended.map((x) => x.a.date);
    const [absent, leaves] = await Promise.all([
      prisma.attendance.findMany({ where: { userId, date: { in: days }, status: { in: ['ABSENT', 'LEAVE'] } }, select: { date: true } }),
      prisma.leave.findMany({ where: { userId, status: 'APPROVED', startDate: { lte: days[days.length - 1] }, endDate: { gte: days[0] } } }),
    ]);
    const missed = (d: Date) => absent.some((x) => x.date.getTime() === d.getTime()) || leaves.some((l) => l.startDate <= d && l.endDate >= d);
    const worked = ended.filter((x) => !missed(x.a.date));
    let through = since;
    for (let i = 0; i + cfg.penaltyWindowShifts <= worked.length; i += cfg.penaltyWindowShifts) {
      const block = worked.slice(i, i + cfg.penaltyWindowShifts);
      const windowStart = block[0].w.start, windowEnd = block[block.length - 1].w.end;
      const lots = await prisma.eCoinLot.findMany({ where: { userId, source: 'LAB_INVOICE', activityAt: { gte: windowStart, lte: windowEnd } }, select: { amount: true, activityAt: true } });
      const coins = lots.filter((l) => block.some((b) => l.activityAt >= b.w.start && l.activityAt <= b.w.end)).reduce((t, l) => t + l.amount, 0);
      through = windowEnd;
      if (!cfg.penaltyEnabled || coins >= cfg.penaltyMinCoins) continue;
      const active = await prisma.eCoinPenalty.findFirst({ where: { userId, status: 'ACTIVE' } });
      if (active) continue; // one discount at a time; this block is consumed either way
      const p = await prisma.eCoinPenalty.upsert({
        where: { userId_windowEnd: { userId, windowEnd } },
        create: {
          userId, windowStart, windowEnd, coinsEarned: coins, discount: cfg.penaltyDiscount, usesTotal: cfg.penaltyUses, usesLeft: cfg.penaltyUses,
          windowShifts: block.map((b) => ({ id: b.a.id, date: b.a.date.toISOString().slice(0, 10), start: b.a.startTime, end: b.a.endTime })),
        },
        update: {},
      });
      await notifyUsers([userId], {
        type: 'ECOIN', title: 'تخفيض سعر شفتاتك',
        body: `لم تكتسب E Coin خلال آخر ${cfg.penaltyWindowShifts} شفتات عمل، لذلك ينخفض سعر شراء شفتاتك القادمة (${cfg.penaltyUses} شفتات) بمقدار ${cfg.penaltyDiscount} E Coin، فيسهل على الأطباء الآخرين شراؤها. أمّن شفتك إن أردت الاحتفاظ به`,
        link: '/ecoin', dedupeKey: `pen:${p.id}`,
      });
    }
    if (through > since) await prisma.eCoinWallet.update({ where: { userId }, data: { penaltyCheckedThrough: through } });
  }
}

/**
 * Which shifts a penalty covers: the penalised doctor's first N shifts that start after it was triggered.
 * A shift sold at the discount stays counted (selling never stretches the period); a shift he no longer holds
 * for any other reason (swap, release, reassignment) drops out and his next one takes its place.
 * Only those he still holds and that have not started are discounted. Each one that has started or was sold
 * is used up; when all N are used up the prices go back to normal.
 */
export async function penaltyCoverage(db: Db, p: ECoinPenalty, now = new Date()) {
  const sold = await db.eCoinTxn.findMany({ where: { type: 'PURCHASE', meta: { path: ['penaltyId'], equals: p.id } }, select: { assignmentId: true } });
  const soldIds = sold.map((t) => t.assignmentId).filter((x): x is string => !!x);
  const rows = await db.shiftAssignment.findMany({
    where: { OR: [{ userId: p.userId, staffType: 'DOCTOR', date: { gte: addDays(dateOnly(p.triggeredAt), -1) } }, { id: { in: soldIds } }] },
  });
  const list = rows.map((a) => ({ a, w: windowOf(a) })).filter((x) => x.w.start > p.triggeredAt)
    .sort((x, y) => x.w.start.getTime() - y.w.start.getTime()).slice(0, p.usesTotal);
  const open = list.filter((x) => x.a.userId === p.userId && x.w.start > now);
  return { slotIds: new Set(open.map((x) => x.a.id)), usesLeft: p.usesTotal - (list.length - open.length), shifts: list.map((x) => x.a.id) };
}

/** Keeps usesLeft in step and ends the penalty once its shifts are all used up (notifies the doctor once). */
export async function refreshPenalty(db: Db, p: ECoinPenalty, now = new Date()) {
  const cov = await penaltyCoverage(db, p, now);
  if (p.status !== 'ACTIVE') return cov;
  const left = Math.max(0, cov.usesLeft);
  if (left !== p.usesLeft || left === 0) {
    await db.eCoinPenalty.update({ where: { id: p.id }, data: { usesLeft: left, ...(left === 0 && { status: 'ENDED', endedAt: now }) } });
    if (left === 0) await notifyUsers([p.userId], { type: 'ECOIN', title: 'انتهت فترة التخفيض', body: 'عادت أسعار شفتاتك لقيمتها الطبيعية', link: '/ecoin', dedupeKey: `pen-end:${p.id}` }, db);
  }
  return cov;
}

/** Discount on one slot: only when its current holder has an active penalty that covers it. */
export async function slotDiscount(db: Db, a: { id: string; userId: string | null }, now = new Date()) {
  if (!a.userId) return null;
  const penalty = await db.eCoinPenalty.findFirst({ where: { userId: a.userId, status: 'ACTIVE' } });
  if (!penalty) return null;
  const cov = await penaltyCoverage(db, penalty, now);
  return cov.slotIds.has(a.id) ? penalty : null;
}
