import { Prisma, type SalaryProfile } from '@prisma/client';
import type { Tx } from '../../lib/prisma';
import { D, r3 } from '../../lib/money';
import { dateOnlyStr } from '../../lib/dates';
import { type EmpPolicy, type Policy, graceOf } from '../staff/policy';

/**
 * Turns a month of attendance into payslip lines, following the policy (Settings → Medical → staff, attendance and
 * payroll) and the employee's own exceptions. Every line keeps its source (attendance record, leave day, manual
 * overtime) and is unique per (slip, kind, source), so recalculating a draft never counts anything twice.
 *
 *  - Lateness / early leave / absence / unpaid leave are deducted from MONTHLY salaries only: an hourly employee is
 *    simply not paid for the time he was not there (deducting it again would charge him twice).
 *  - Overtime = time after the scheduled end (capped at the next shift). Paid only when the policy is on, the employee
 *    is eligible, it reaches the minimum and (when required) a manager approved it; otherwise it is kept for follow-up.
 */
export interface Item { kind: string; sourceType: string; sourceId: string; date: Date; minutes: number; days: number; amount: Prisma.Decimal; state: string; note?: string | null }

const BLOCK = { MINUTE: 1, Q15: 15, Q30: 30, HOUR: 60 } as const;
const roundUp = (m: number, block: number) => (m <= 0 ? 0 : Math.ceil(m / block) * block);
const EFFECT_DAYS = { PAID: 0, HALF: 0.5, UNPAID: 1 } as const;

export function values(profile: Pick<SalaryProfile, 'payType' | 'basic' | 'hourlyRate'>, p: Policy, e: EmpPolicy) {
  const hourly = profile.payType === 'HOURLY';
  const dailyHours = e.dailyHours ?? p.payroll.dailyHours;
  const dayValue = hourly ? D(profile.hourlyRate).mul(dailyHours) : D(profile.basic).div(p.payroll.dayDivisor);
  const hourValue = e.hourValue !== undefined ? D(e.hourValue) : hourly ? D(profile.hourlyRate) : dayValue.div(dailyHours);
  return { hourly, dailyHours, dayValue, hourValue };
}

export async function calculate(tx: Tx, profile: SalaryProfile, from: Date, to: Date, p: Policy, e: EmpPolicy) {
  const { hourly, dayValue, hourValue } = values(profile, p, e);
  const [att, leaves, manual] = await Promise.all([
    tx.attendance.findMany({ where: { userId: profile.userId, date: { gte: from, lte: to } }, orderBy: { date: 'asc' } }),
    tx.leave.findMany({ where: { userId: profile.userId, status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } } }),
    tx.overtimeEntry.findMany({ where: { userId: profile.userId, date: { gte: from, lte: to } }, orderBy: { startAt: 'asc' } }),
  ]);
  const items: Item[] = [];
  const zero = D(0);
  const onLeave = new Set<string>();
  for (const l of leaves) for (let d = new Date(Math.max(l.startDate.getTime(), from.getTime())); d <= l.endDate && d <= to; d = new Date(d.getTime() + 86_400_000)) onLeave.add(dateOnlyStr(d));

  const grace = graceOf(p, e);
  const block = BLOCK[p.late.rounding];
  const deductFor = (minutes: number) => p.late.method === 'FIXED' ? D(p.late.fixedAmount) : p.late.method === 'PERCENT' ? dayValue.mul(p.late.percent).div(100) : hourValue.mul(minutes).div(60);
  const holiday = (d: Date) => p.overtime.holidayEnabled && (p.overtime.holidayWeekdays.includes(d.getUTCDay()) || p.overtime.holidays.includes(dateOnlyStr(d)));
  const otRate = (d: Date) => {
    const base = p.overtime.method === 'FIXED' ? D(p.overtime.fixedRate) : hourValue;
    const factor = holiday(d) ? p.overtime.holidayMultiplier : p.overtime.method === 'MULTIPLIER' ? e.overtimeMultiplier ?? p.overtime.multiplier : 1;
    return base.mul(factor);
  };
  const otNeedsApproval = e.overtimeNeedsApproval ?? p.overtime.needsApproval;

  let regularMinutes = 0, workDays = 0, absenceDays = 0, reviewDays = 0, lateCount = 0, lateMinutes = 0, earlyMinutes = 0;
  for (const r of att) {
    const day = dateOnlyStr(r.date);
    const worked = Math.max(0, r.workedMinutes - r.overtimeMinutes);
    regularMinutes += worked;
    if (r.checkIn || r.workedMinutes > 0) workDays++;
    if (!r.reviewedAt && (r.status === 'NO_RECORD' || (r.checkIn && !r.checkOut))) reviewDays++;

    if (r.status === 'ABSENT' && !onLeave.has(day)) {
      absenceDays++;
      const effect = r.excused ? p.leaves.excusedAbsence : p.leaves.unexcusedAbsence;
      const days = EFFECT_DAYS[effect];
      const state = hourly ? 'HOURLY' : !p.payroll.absenceAffects ? 'OFF' : days ? 'DEDUCTED' : 'PAID';
      items.push({ kind: 'ABSENCE', sourceType: 'attendance', sourceId: r.id, date: r.date, minutes: 0, days: 1, amount: state === 'DEDUCTED' ? dayValue.mul(days) : zero, state, note: r.excused ? 'غياب مبرر' : 'غياب غير مبرر' });
    }

    if (r.lateMinutes > 0) {
      lateCount++;
      lateMinutes += r.lateMinutes;
      const minutes = roundUp(Math.max(0, r.lateMinutes - grace), block);
      let state = 'DEDUCTED';
      if (hourly) state = 'HOURLY';
      else if (!p.late.deduct) state = 'OFF';
      else if (e.lateExempt || r.lateDecision === 'EXEMPT') state = 'EXEMPT';
      else if (r.lateExcuseStatus === 'ACCEPTED') state = 'EXCUSED';
      else if (r.lateExcuseStatus === 'PENDING') state = 'PENDING';
      else if (p.late.mode === 'APPROVAL' && r.lateDecision !== 'DEDUCT') state = 'PENDING';
      items.push({ kind: 'LATE', sourceType: 'attendance', sourceId: r.id, date: r.date, minutes, days: 0, amount: state === 'DEDUCTED' ? deductFor(minutes) : zero, state, note: `تأخر ${r.lateMinutes} د، سماح ${grace} د${e.lateExempt ? '، الموظف معفى' : ''}` });
    }

    if (r.earlyLeaveMinutes > 0) {
      earlyMinutes += r.earlyLeaveMinutes;
      const minutes = roundUp(Math.max(0, r.earlyLeaveMinutes - grace), block);
      const state = hourly ? 'HOURLY' : !p.early.deduct ? 'OFF' : 'DEDUCTED';
      items.push({ kind: 'EARLY', sourceType: 'attendance', sourceId: r.id, date: r.date, minutes, days: 0, amount: state === 'DEDUCTED' ? deductFor(minutes) : zero, state, note: `غادر قبل نهاية الشفت بـ ${r.earlyLeaveMinutes} د` });
    }

    if (r.overtimeMinutes > 0) {
      let state = 'PAID';
      if (!p.overtime.enabled) state = 'OFF';
      else if (e.overtimeEligible === false) state = 'NOT_ELIGIBLE';
      else if (r.overtimeMinutes < p.overtime.minMinutes) state = 'BELOW_MIN';
      else if (r.overtimeDecision === 'REJECTED') state = 'REJECTED';
      else if (otNeedsApproval && r.overtimeDecision !== 'APPROVED') state = 'PENDING';
      items.push({ kind: 'OVERTIME', sourceType: 'attendance', sourceId: r.id, date: r.date, minutes: r.overtimeMinutes, days: 0, amount: state === 'PAID' ? otRate(r.date).mul(r.overtimeMinutes).div(60) : zero, state, note: holiday(r.date) ? 'يوم عطلة' : null });
    }
  }

  let leaveDays = 0;
  for (const l of leaves) {
    for (let d = new Date(Math.max(l.startDate.getTime(), from.getTime())); d <= l.endDate && d <= to; d = new Date(d.getTime() + 86_400_000)) {
      leaveDays++;
      const effect = p.leaves.pay[l.type];
      const days = EFFECT_DAYS[effect];
      const state = hourly ? 'HOURLY' : days ? 'DEDUCTED' : 'PAID';
      items.push({ kind: 'LEAVE', sourceType: 'leave', sourceId: `${l.id}:${dateOnlyStr(d)}`, date: new Date(d), minutes: 0, days: 1, amount: state === 'DEDUCTED' ? dayValue.mul(days) : zero, state, note: l.type });
    }
  }

  for (const m of manual) {
    const state = !p.overtime.enabled ? 'OFF' : e.overtimeEligible === false ? 'NOT_ELIGIBLE' : 'PAID';
    items.push({ kind: 'OVERTIME_MANUAL', sourceType: 'overtime', sourceId: m.id, date: m.date, minutes: m.minutes, days: 0, amount: state === 'PAID' ? otRate(m.date).mul(m.minutes).div(60) : zero, state, note: m.reason });
  }

  for (const i of items) i.amount = r3(i.amount);
  const hours = hourly ? D(regularMinutes).div(60).toDecimalPlaces(2) : D(0);
  return {
    items,
    fields: {
      payType: profile.payType, jobTitle: profile.jobTitle,
      hours, hourlyRate: hourly ? profile.hourlyRate : D(0),
      basic: hourly ? r3(hours.mul(profile.hourlyRate)) : D(profile.basic),
      allowances: p.payroll.autoAllowances ? r3((profile.allowances as { amount: number }[]).reduce((t, a) => t.add(a.amount), D(0))) : D(0),
      workDays, absenceDays, leaveDays, reviewDays, lateCount, lateMinutes, earlyMinutes,
    },
  };
}

/** Totals of a slip from its lines (waived lines left out) and its manual amounts. */
export function totals(items: { kind: string; amount: Prisma.Decimal.Value; minutes: number; state: string; waived: boolean }[]) {
  const sum = (kinds: string[]) => r3(items.filter((i) => kinds.includes(i.kind) && !i.waived).reduce((t, i) => t.add(i.amount), D(0)));
  return {
    absenceDeduction: sum(['ABSENCE', 'LEAVE']),
    lateDeduction: sum(['LATE']),
    earlyDeduction: sum(['EARLY']),
    overtime: sum(['OVERTIME', 'OVERTIME_MANUAL']),
    overtimeMinutes: items.filter((i) => (i.kind === 'OVERTIME' || i.kind === 'OVERTIME_MANUAL') && i.state === 'PAID' && !i.waived).reduce((t, i) => t + i.minutes, 0),
  };
}

type Money = Prisma.Decimal.Value;
export const netOf = (s: { basic: Money; allowances: Money; commission: Money; bonus: Money; overtime: Money; absenceDeduction: Money; lateDeduction: Money; earlyDeduction: Money; deductions: Money; advance: Money }) =>
  r3(D(s.basic).add(s.allowances).add(s.commission).add(s.bonus).add(s.overtime).sub(s.absenceDeduction).sub(s.lateDeduction).sub(s.earlyDeduction).sub(s.deductions).sub(s.advance));
