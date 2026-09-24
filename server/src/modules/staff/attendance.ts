import type { AttendanceStatus, ShiftAssignment } from '@prisma/client';
import { atTime, addDays, minutesOf } from '../../lib/dates';

/** Shift window in absolute time; overnight shifts end on the next calendar day. */
export function shiftWindow(a: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'>) {
  const start = atTime(a.date, a.startTime);
  let end = atTime(a.date, a.endTime);
  if (minutesOf(a.endTime) <= minutesOf(a.startTime)) end = addDays(end, 1);
  return { start, end };
}

export function evaluateAttendance(
  assignment: Pick<ShiftAssignment, 'date' | 'startTime' | 'endTime'> | null,
  checkIn: Date | null,
  checkOut: Date | null,
  graceMinutes: number,
): { status: AttendanceStatus; lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number } {
  const workedMinutes = checkIn && checkOut ? Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 60_000)) : 0;
  if (!checkIn) return { status: 'ABSENT', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 0 };
  if (!assignment) return { status: 'PRESENT', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes };
  const { start, end } = shiftWindow(assignment);
  const late = Math.round((checkIn.getTime() - start.getTime()) / 60_000);
  const lateMinutes = late > graceMinutes ? late : 0;
  const early = checkOut ? Math.round((end.getTime() - checkOut.getTime()) / 60_000) : 0;
  const earlyLeaveMinutes = early > graceMinutes ? early : 0;
  const status: AttendanceStatus = lateMinutes && earlyLeaveMinutes ? 'LATE_AND_EARLY' : lateMinutes ? 'LATE' : earlyLeaveMinutes ? 'EARLY_LEAVE' : 'PRESENT';
  return { status, lateMinutes, earlyLeaveMinutes, workedMinutes };
}
