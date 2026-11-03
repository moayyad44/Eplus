import { prisma } from '../../lib/prisma';
import { getSetting } from '../../lib/settings';
import { notifyUsers } from '../../lib/notify';
import { addDays, dateOnly } from '../../lib/dates';
import { windowOf } from '../shiftx/core';

/**
 * Incentive rule. A doctor's worked shifts are taken in consecutive blocks of N (default 5), each block evaluated
 * once (the wallet remembers up to where). If the coins he earned from lab activity during the shifts of a block
 * are below the minimum, he gets a discount (default 1 E Coin) on his next purchases (default 5).
 *
 * "Worked" = he held the shift when it ended (ownership cannot change once a shift has started), and his
 * attendance for that day is not ABSENT / LEAVE and he has no approved leave. Shifts are only evaluated once
 * their day is over, after the daily automatic-absence pass, so a missed shift is never counted as worked.
 */
export async function evaluatePenalties(now = new Date()) {
  const cfg = await getSetting('ecoin');
  if (!cfg.enabled) return;
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
        type: 'ECOIN', title: 'تفعيل تخفيض أسعار الشفتات',
        body: `لم تكتسب E Coin خلال آخر ${cfg.penaltyWindowShifts} شفتات عمل، فينخفض سعر الشفتات التي تشتريها ${cfg.penaltyDiscount} E Coin لـ ${cfg.penaltyUses} عمليات شراء`,
        link: '/ecoin', dedupeKey: `pen:${p.id}`,
      });
    }
    if (through > since) await prisma.eCoinWallet.update({ where: { userId }, data: { penaltyCheckedThrough: through } });
  }
}
