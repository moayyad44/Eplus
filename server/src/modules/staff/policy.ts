import { z } from 'zod';
import type { Attendance, ShiftAssignment } from '@prisma/client';
import type { Db } from '../../lib/prisma';
import { prisma } from '../../lib/prisma';
import { getSetting, type SettingValue } from '../../lib/settings';
import { badRequest } from '../../lib/errors';
import { addDays, dateOnly, dateOnlyStr } from '../../lib/dates';
import { evaluateAttendance, shiftWindow, type Evaluation } from './attendance';

export type Policy = SettingValue<'attendance'>;

/** Employee-specific policy (Payroll → salary profile). A key left out uses the general setting. */
export const empPolicySchema = z.object({
  lateExempt: z.boolean().optional(),
  graceMinutes: z.number().int().min(0).max(120).optional(),
  dailyHours: z.number().min(1).max(24).optional(),
  hourValue: z.number().min(0).max(10_000).optional(),
  overtimeEligible: z.boolean().optional(),
  overtimeMultiplier: z.number().min(1).max(5).optional(),
  overtimeNeedsApproval: z.boolean().optional(),
});
export type EmpPolicy = z.infer<typeof empPolicySchema>;

export const readEmpPolicy = (v: unknown): EmpPolicy => {
  const p = empPolicySchema.safeParse(v ?? {});
  return p.success ? p.data : {};
};

export const getPolicy = (db: Db = prisma) => getSetting('attendance', db);

export async function empPolicies(db: Db, userIds: string[]) {
  const rows = await db.salaryProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true, policy: true } });
  return new Map(rows.map((r) => [r.userId, readEmpPolicy(r.policy)]));
}

export const graceOf = (p: Policy, e: EmpPolicy) => e.graceMinutes ?? p.graceMinutes;

type Slot = Pick<ShiftAssignment, 'id' | 'date' | 'startTime' | 'endTime'>;

/** Everything the evaluation needs besides the times: the employee's next shift and any handover extension. */
async function context(db: Db, userId: string, a: Slot | null) {
  if (!a) return { nextStart: null as Date | null, extensionMinutes: 0 };
  const { start } = shiftWindow(a);
  const others = await db.shiftAssignment.findMany({ where: { userId, id: { not: a.id }, date: { gte: a.date, lte: addDays(a.date, 2) } }, select: { date: true, startTime: true, endTime: true } });
  const nexts = others.map((o) => shiftWindow(o).start).filter((s) => s > start).sort((x, y) => x.getTime() - y.getTime());
  const ext = await db.shiftHandover.aggregate({ where: { prevAssignmentId: a.id }, _sum: { extendedMinutes: true } });
  return { nextStart: nexts[0] ?? null, extensionMinutes: ext._sum.extendedMinutes ?? 0 };
}

/** Evaluates one record with the current policy (general + the employee's own). */
export async function evaluateFor(db: Db, userId: string, a: Slot | null, checkIn: Date | null, checkOut: Date | null, p?: Policy, e?: EmpPolicy): Promise<Evaluation> {
  const policy = p ?? await getPolicy(db);
  const emp = e ?? (await empPolicies(db, [userId])).get(userId) ?? {};
  const ctx = await context(db, userId, a);
  return evaluateAttendance(a, checkIn, checkOut, { graceMinutes: graceOf(policy, emp), method: policy.method, requireCheckout: policy.overtime.requireCheckout, ...ctx });
}

/** The shift a check-in belongs to: the one whose window (from 3 hours before its start) contains the moment. */
export async function shiftAt(db: Db, userId: string, at: Date) {
  const day = dateOnly(at);
  const list = await db.shiftAssignment.findMany({ where: { userId, date: { gte: addDays(day, -1), lte: addDays(day, 1) } }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] });
  const open = list.filter((x) => { const w = shiftWindow(x); return at >= new Date(w.start.getTime() - 3 * 3_600_000) && at <= w.end; });
  return open.sort((x, y) => Math.abs(shiftWindow(x).start.getTime() - at.getTime()) - Math.abs(shiftWindow(y).start.getTime() - at.getTime()))[0] ?? null;
}

/** After a month's payroll is approved its attendance is locked (when the policy says so): reopen the payroll first. */
export async function assertOpen(db: Db, dates: Date[], p?: Policy) {
  const policy = p ?? await getPolicy(db);
  if (!policy.payroll.lockOnApproval) return;
  const months = [...new Set(dates.map((d) => dateOnlyStr(d).slice(0, 7)))];
  const locked = await db.payrollRun.findFirst({ where: { month: { in: months }, status: { in: ['APPROVED', 'PAID'] } } });
  if (locked) throw badRequest(`رواتب شهر ${locked.month} ${locked.status === 'PAID' ? 'مصروفة' : 'معتمدة'}؛ سجلات دوام هذا الشهر مقفلة${locked.status === 'PAID' ? '' : '. أعد فتح كشف الرواتب أولاً'}`);
}

/**
 * What the screen shows: PRESENT, LATE, ABSENT, LEAVE, NO_RECORD (لم يسجل الحضور), NO_CHECKOUT (لم يسجل المغادرة),
 * COMPLETE (دوام مكتمل), EARLY_LEAVE; and whether the record still needs a manager's review.
 */
export function display(r: Pick<Attendance, 'status' | 'checkIn' | 'checkOut' | 'date' | 'lateMinutes' | 'earlyLeaveMinutes' | 'overtimeMinutes' | 'lateDecision' | 'lateExcuseStatus' | 'overtimeDecision' | 'reviewedAt'> & { shiftAssignment?: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'> | null }, p: Policy, e: EmpPolicy, now = new Date()) {
  let state: string;
  if (r.status === 'LEAVE' || r.status === 'ABSENT' || r.status === 'NO_RECORD') state = r.status;
  else if (r.checkIn && !r.checkOut) {
    const ended = r.shiftAssignment ? shiftWindow(r.shiftAssignment).end < now : dateOnlyStr(r.date) < dateOnlyStr(dateOnly(now));
    state = ended ? 'NO_CHECKOUT' : r.lateMinutes ? 'LATE' : 'PRESENT';
  } else if (r.lateMinutes) state = 'LATE';
  else if (r.earlyLeaveMinutes) state = 'EARLY_LEAVE';
  else state = 'COMPLETE';
  const pending: string[] = [];
  if ((state === 'NO_RECORD' || state === 'NO_CHECKOUT') && !r.reviewedAt) pending.push(state);
  if (r.lateExcuseStatus === 'PENDING') pending.push('EXCUSE');
  if (r.lateMinutes && p.late.deduct && p.late.mode === 'APPROVAL' && !r.lateDecision && !e.lateExempt && r.lateExcuseStatus !== 'ACCEPTED') pending.push('LATE');
  const otApproval = e.overtimeNeedsApproval ?? p.overtime.needsApproval;
  if (r.overtimeMinutes >= p.overtime.minMinutes && r.overtimeMinutes > 0 && p.overtime.enabled && e.overtimeEligible !== false && otApproval && !r.overtimeDecision) pending.push('OVERTIME');
  const review = r.reviewedAt && !pending.length ? 'APPROVED' : pending.length ? 'NEEDS_REVIEW' : 'OK';
  return { state, review, pending };
}

/** Brings the month's records in line with the current policy before a payroll is calculated (only records with an arrival). */
export async function reevaluate(db: Db, userIds: string[], from: Date, to: Date, p: Policy, emp: Map<string, EmpPolicy>) {
  const recs = await db.attendance.findMany({ where: { userId: { in: userIds }, date: { gte: from, lte: to }, checkIn: { not: null } }, include: { shiftAssignment: true } });
  for (const r of recs) {
    const a = r.shiftAssignment && r.shiftAssignment.userId === r.userId ? r.shiftAssignment : null;
    const ev = await evaluateFor(db, r.userId, a, r.checkIn, r.checkOut, p, emp.get(r.userId) ?? {});
    const status = ['PRESENT', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY'].includes(r.status) ? ev.status : r.status;
    if (status !== r.status || ev.lateMinutes !== r.lateMinutes || ev.earlyLeaveMinutes !== r.earlyLeaveMinutes || ev.workedMinutes !== r.workedMinutes || ev.overtimeMinutes !== r.overtimeMinutes) {
      await db.attendance.update({ where: { id: r.id }, data: { status, lateMinutes: ev.lateMinutes, earlyLeaveMinutes: ev.earlyLeaveMinutes, workedMinutes: ev.workedMinutes, overtimeMinutes: ev.overtimeMinutes } });
    }
  }
}
