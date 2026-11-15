import type { AttendanceStatus, ShiftAssignment } from '@prisma/client';
import { atTime, addDays, minutesOf } from '../../lib/dates';

/** Shift window in absolute time; overnight shifts end on the next calendar day. */
export function shiftWindow(a: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'>) {
  const start = atTime(a.date, a.startTime);
  let end = atTime(a.date, a.endTime);
  if (minutesOf(a.endTime) <= minutesOf(a.startTime)) end = addDays(end, 1);
  return { start, end };
}

export interface EvalOptions {
  graceMinutes: number;
  /** CLOCK: worked time = check-in → check-out. SCHEDULE: the scheduled shift (from the actual arrival, to the actual
   *  leave or the shift end when no leave was recorded) + overtime. */
  method?: 'CLOCK' | 'SCHEDULE';
  /** Start of the employee's next shift: time after the scheduled end is overtime only until then (never counted twice). */
  nextStart?: Date | null;
  /** Shift extension recorded at handover (minutes), accepted as proof when an actual leave time is not required. */
  extensionMinutes?: number;
  requireCheckout?: boolean;
}

export interface Evaluation { status: AttendanceStatus; lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number; overtimeMinutes: number }

const mins = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 60_000);

export function evaluateAttendance(
  assignment: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'> | null,
  checkIn: Date | null,
  checkOut: Date | null,
  options: number | EvalOptions,
): Evaluation {
  const o: EvalOptions = typeof options === 'number' ? { graceMinutes: options } : options;
  const actual = checkIn && checkOut ? Math.max(0, mins(checkOut, checkIn)) : 0;
  if (!checkIn) return { status: 'ABSENT', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 0, overtimeMinutes: 0 };
  if (!assignment) return { status: 'PRESENT', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: actual, overtimeMinutes: 0 };
  const { start, end } = shiftWindow(assignment);
  const late = mins(checkIn, start);
  const lateMinutes = late > o.graceMinutes ? late : 0;
  const early = checkOut ? mins(end, checkOut) : 0;
  const earlyLeaveMinutes = early > o.graceMinutes ? early : 0;
  let overtimeMinutes = 0;
  if (checkOut) {
    const stop = o.nextStart && o.nextStart < checkOut ? o.nextStart : checkOut;
    const from = checkIn > end ? checkIn : end;
    overtimeMinutes = Math.max(0, mins(stop, from));
  }
  // The same period proven twice (leave time and handover extension) is counted once: the larger of the two.
  if (o.requireCheckout === false && o.extensionMinutes) overtimeMinutes = Math.max(overtimeMinutes, o.extensionMinutes);
  let workedMinutes = actual;
  if (o.method === 'SCHEDULE') {
    const from = checkIn > start ? checkIn : start;
    const to = checkOut && checkOut < end ? checkOut : end;
    workedMinutes = Math.max(0, mins(to, from)) + overtimeMinutes;
  }
  const status: AttendanceStatus = lateMinutes && earlyLeaveMinutes ? 'LATE_AND_EARLY' : lateMinutes ? 'LATE' : earlyLeaveMinutes ? 'EARLY_LEAVE' : 'PRESENT';
  return { status, lateMinutes, earlyLeaveMinutes, workedMinutes, overtimeMinutes };
}
