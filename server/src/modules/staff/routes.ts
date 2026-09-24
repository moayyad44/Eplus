import { Router } from 'express';
import { z } from 'zod';
import { AttendanceStatus, LeaveType, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, nullableStr, optionalDate, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { addDays, dateOnly, dateOnlyStr, ymd } from '../../lib/dates';
import { getSetting } from '../../lib/settings';
import { notifyPermission } from '../../lib/notify';
import { can, type Ctx } from '../../auth/context';
import { evaluateAttendance } from './attendance';

export const staffRouter = Router();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'الوقت بصيغة HH:mm');
const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');
const userMini = { select: { id: true, fullName: true, staffType: true } } as const;

// ── Schedule (shift assignments) ──

staffRouter.get(
  '/schedule',
  requirePerm('shifts.view'),
  ah(async (req, res) => {
    const q = parse(z.object({ from: ymdStr, to: ymdStr, userId: z.string().uuid().optional(), staffType: z.string().optional() }), req.query);
    const userFilter: Prisma.UserWhereInput = { ...(q.staffType && { staffType: q.staffType as never }) };
    const range = { gte: dateOnly(q.from), lte: dateOnly(q.to) };
    const [assignments, leaves, attendance] = await Promise.all([
      prisma.shiftAssignment.findMany({
        where: { date: range, ...(q.userId && { userId: q.userId }), user: userFilter },
        include: { user: userMini, shift: { select: { id: true, name: true, type: true, color: true } } },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
      prisma.leave.findMany({
        where: { status: 'APPROVED', startDate: { lte: range.lte }, endDate: { gte: range.gte }, ...(q.userId && { userId: q.userId }), user: userFilter },
        include: { user: userMini },
      }),
      prisma.attendance.findMany({ where: { date: range, ...(q.userId && { userId: q.userId }) }, select: { userId: true, date: true, status: true } }),
    ]);
    res.json({ assignments, leaves, attendance });
  }),
);

staffRouter.post(
  '/schedule/bulk',
  requirePerm('shifts.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        userIds: z.array(z.string().uuid()).min(1, 'اختر موظفاً واحداً على الأقل').max(200),
        shiftId: z.string().uuid('اختر الشفت'),
        from: ymdStr, to: ymdStr,
        weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'اختر أيام العمل'),
        startTime: hhmm.optional(), endTime: hhmm.optional(),
        notes: nullableStr(300),
      }),
      req.body,
    );
    const from = dateOnly(body.from), to = dateOnly(body.to);
    if (to < from) throw badRequest('تاريخ النهاية قبل البداية');
    if ((to.getTime() - from.getTime()) / 86_400_000 > 180) throw badRequest('الحد الأقصى 180 يوماً في المرة الواحدة');
    const shift = await prisma.shift.findFirst({ where: { id: body.shiftId, isActive: true } });
    if (!shift) throw badRequest('الشفت غير متاح');
    const leaves = await prisma.leave.findMany({ where: { userId: { in: body.userIds }, status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } } });
    const data: Prisma.ShiftAssignmentCreateManyInput[] = [];
    let skippedLeave = 0;
    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
      if (!body.weekdays.includes(d.getUTCDay())) continue;
      for (const userId of body.userIds) {
        if (leaves.some((l) => l.userId === userId && l.startDate <= d && l.endDate >= d)) { skippedLeave++; continue; }
        data.push({ userId, shiftId: shift.id, date: new Date(d), startTime: body.startTime ?? shift.startTime, endTime: body.endTime ?? shift.endTime, notes: body.notes, createdById: req.ctx.userId });
      }
    }
    const created = await prisma.$transaction(async (tx) => {
      const r = await tx.shiftAssignment.createMany({ data, skipDuplicates: true });
      await audit(tx, req.ctx, { action: 'schedule.bulk_create', entityType: 'shift', entityId: shift.id, summary: `جدولة ${r.count} دوام (${shift.name}) من ${body.from} إلى ${body.to}` });
      return r.count;
    });
    res.status(201).json({ created, skippedLeave, skippedExisting: data.length - created });
  }),
);

staffRouter.delete(
  '/schedule/:id',
  requirePerm('shifts.manage'),
  ah(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const a = await tx.shiftAssignment.findUnique({ where: { id: req.params.id }, include: { _count: { select: { attendance: true } }, user: { select: { fullName: true } } } });
      if (!a) throw notFound();
      if (a._count.attendance) throw badRequest('لا يمكن حذف دوام عليه حضور مسجل');
      await tx.shiftAssignment.delete({ where: { id: a.id } });
      await audit(tx, req.ctx, { action: 'schedule.delete', entityType: 'shift_assignment', entityId: a.id, summary: `${a.user.fullName} ${dateOnlyStr(a.date)}`, before: a });
    });
    res.json({ ok: true });
  }),
);

// ── Leaves ──

staffRouter.get(
  '/leaves',
  requireAnyPerm('shifts.view', 'shifts.manage'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), userId: z.string().uuid().optional() }), req.query);
    const where: Prisma.LeaveWhereInput = {
      ...(q.status && { status: q.status }),
      ...(!can(req.ctx, 'shifts.manage') ? { userId: req.ctx.userId } : q.userId ? { userId: q.userId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.leave.findMany({ where, ...paginate(q), orderBy: { startDate: 'desc' }, include: { user: userMini } }),
      prisma.leave.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);

staffRouter.post(
  '/leaves',
  requireAnyPerm('shifts.view', 'shifts.manage'),
  ah(async (req, res) => {
    const body = parse(z.object({ userId: z.string().uuid().optional(), type: z.nativeEnum(LeaveType), startDate: ymdStr, endDate: ymdStr, reason: nullableStr(500) }), req.body);
    const manager = can(req.ctx, 'shifts.manage');
    const userId = body.userId ?? req.ctx.userId;
    if (userId !== req.ctx.userId && !manager) throw forbidden();
    if (body.endDate < body.startDate) throw badRequest('تاريخ النهاية قبل البداية');
    const leave = await prisma.$transaction(async (tx) => {
      const l = await tx.leave.create({
        data: {
          userId, type: body.type, startDate: dateOnly(body.startDate), endDate: dateOnly(body.endDate), reason: body.reason, createdById: req.ctx.userId,
          ...(manager && { status: 'APPROVED', decidedById: req.ctx.userId, decidedAt: new Date() }),
        },
        include: { user: userMini },
      });
      await audit(tx, req.ctx, { action: 'leave.create', entityType: 'leave', entityId: l.id, summary: `إجازة ${l.user.fullName} ${body.startDate} → ${body.endDate}`, after: l });
      if (!manager) await notifyPermission('shifts.manage', { type: 'SYSTEM', title: `طلب إجازة من ${l.user.fullName}`, body: `${body.startDate} → ${body.endDate}`, link: '/staff/leaves' }, tx);
      return l;
    });
    res.status(201).json(leave);
  }),
);

staffRouter.post(
  '/leaves/:id/decision',
  requirePerm('shifts.manage'),
  ah(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']) }), req.body);
    const l = await prisma.$transaction(async (tx) => {
      const before = await tx.leave.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound();
      const row = await tx.leave.update({ where: { id: before.id }, data: { status, decidedById: req.ctx.userId, decidedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'leave.decision', entityType: 'leave', entityId: row.id, before: { status: before.status }, after: { status } });
      return row;
    });
    res.json(l);
  }),
);

// ── Attendance ──

async function upsertAttendance(tx: Tx, ctx: Ctx, userId: string, day: Date, patch: { checkIn?: Date | null; checkOut?: Date | null; status?: AttendanceStatus; notes?: string | null }) {
  const date = dateOnly(day);
  const { graceMinutes } = await getSetting('attendance', tx);
  const [existing, assignment] = await Promise.all([
    tx.attendance.findUnique({ where: { userId_date: { userId, date } } }),
    tx.shiftAssignment.findFirst({ where: { userId, date }, orderBy: { startTime: 'asc' } }),
  ]);
  const checkIn = patch.checkIn !== undefined ? patch.checkIn : existing?.checkIn ?? null;
  const checkOut = patch.checkOut !== undefined ? patch.checkOut : existing?.checkOut ?? null;
  if (checkIn && checkOut && checkOut < checkIn) throw badRequest('وقت المغادرة قبل وقت الحضور');
  const ev = evaluateAttendance(assignment, checkIn, checkOut, graceMinutes);
  const status = patch.status && ['ABSENT', 'LEAVE'].includes(patch.status) ? patch.status : ev.status;
  const data = {
    checkIn, checkOut, status, lateMinutes: ev.lateMinutes, earlyLeaveMinutes: ev.earlyLeaveMinutes, workedMinutes: ev.workedMinutes,
    shiftAssignmentId: assignment?.id ?? null, notes: patch.notes !== undefined ? patch.notes : existing?.notes ?? null, recordedById: ctx.userId,
  };
  const row = existing
    ? await tx.attendance.update({ where: { id: existing.id }, data })
    : await tx.attendance.create({ data: { ...data, userId, date } });
  await audit(tx, ctx, { action: existing ? 'attendance.update' : 'attendance.create', entityType: 'attendance', entityId: row.id, before: existing, after: row });
  if (ev.lateMinutes > 0 && (!existing || !existing.lateMinutes)) {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    await notifyPermission('attendance.manage', {
      type: 'STAFF_LATE', title: `تأخر موظف: ${u?.fullName}`, body: `تأخير ${ev.lateMinutes} دقيقة`, link: '/staff/attendance', dedupeKey: `late:${userId}:${ymd(day)}`,
    }, tx, userId);
  }
  return row;
}

staffRouter.get(
  '/attendance/me',
  ah(async (req, res) => {
    const date = dateOnly();
    const [record, assignment] = await Promise.all([
      prisma.attendance.findUnique({ where: { userId_date: { userId: req.ctx.userId, date } } }),
      prisma.shiftAssignment.findFirst({ where: { userId: req.ctx.userId, date }, include: { shift: { select: { name: true } } } }),
    ]);
    res.json({ record, assignment });
  }),
);

staffRouter.post(
  '/attendance/check-in',
  ah(async (req, res) => {
    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.attendance.findUnique({ where: { userId_date: { userId: req.ctx.userId, date: dateOnly(now) } } });
      if (existing?.checkIn) throw badRequest('تم تسجيل الحضور مسبقاً اليوم');
      return upsertAttendance(tx, req.ctx, req.ctx.userId, now, { checkIn: now });
    });
    res.json(row);
  }),
);

staffRouter.post(
  '/attendance/check-out',
  ah(async (req, res) => {
    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      // Overnight shifts: fall back to yesterday's open record.
      let rec = await tx.attendance.findUnique({ where: { userId_date: { userId: req.ctx.userId, date: dateOnly(now) } } });
      if (!rec?.checkIn) rec = await tx.attendance.findFirst({ where: { userId: req.ctx.userId, date: dateOnly(addDays(now, -1)), checkIn: { not: null }, checkOut: null } });
      if (!rec?.checkIn) throw badRequest('لم يتم تسجيل الحضور بعد');
      if (rec.checkOut) throw badRequest('تم تسجيل المغادرة مسبقاً');
      return upsertAttendance(tx, req.ctx, req.ctx.userId, rec.date, { checkOut: now });
    });
    res.json(row);
  }),
);

staffRouter.post(
  '/attendance',
  requirePerm('attendance.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ userId: z.string().uuid(), date: ymdStr, checkIn: optionalDate, checkOut: optionalDate, status: z.nativeEnum(AttendanceStatus).optional(), notes: nullableStr(300) }),
      req.body,
    );
    if (!body.checkIn && !['ABSENT', 'LEAVE'].includes(body.status ?? '')) throw badRequest('أدخل وقت الحضور أو اختر غياب/إجازة');
    const row = await prisma.$transaction((tx) =>
      upsertAttendance(tx, req.ctx, body.userId, new Date(`${body.date}T12:00:00`), {
        checkIn: body.status === 'ABSENT' || body.status === 'LEAVE' ? null : body.checkIn ?? null,
        checkOut: body.status === 'ABSENT' || body.status === 'LEAVE' ? null : body.checkOut ?? null,
        status: body.status,
        notes: body.notes,
      }),
    );
    res.json(row);
  }),
);

staffRouter.get(
  '/attendance',
  requirePerm('attendance.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ from: ymdStr, to: ymdStr, userId: z.string().uuid().optional(), status: z.nativeEnum(AttendanceStatus).optional() }), req.query);
    const where: Prisma.AttendanceWhereInput = {
      date: { gte: dateOnly(q.from), lte: dateOnly(q.to) },
      ...(!can(req.ctx, 'attendance.manage') ? { userId: req.ctx.userId } : q.userId ? { userId: q.userId } : {}),
      ...(q.status && { status: q.status }),
    };
    const [items, total, totals] = await Promise.all([
      prisma.attendance.findMany({ where, ...paginate(q), orderBy: [{ date: 'desc' }], include: { user: userMini, shiftAssignment: { select: { startTime: true, endTime: true, shift: { select: { name: true } } } } } }),
      prisma.attendance.count({ where }),
      prisma.attendance.aggregate({ where, _sum: { lateMinutes: true, earlyLeaveMinutes: true, workedMinutes: true } }),
    ]);
    res.json({ ...paged(items, total, q), totals: totals._sum });
  }),
);

