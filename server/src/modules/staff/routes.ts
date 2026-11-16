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
import { notifyPermission } from '../../lib/notify';
import { can, type Ctx } from '../../auth/context';
import { shiftWindow } from './attendance';
import { assertOpen, display, empPolicies, evaluateFor, getPolicy, shiftAt } from './policy';

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
    const staffTypes = new Map((await prisma.user.findMany({ where: { id: { in: body.userIds } }, select: { id: true, staffType: true } })).map((u) => [u.id, u.staffType]));
    const data: Prisma.ShiftAssignmentCreateManyInput[] = [];
    let skippedLeave = 0;
    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
      if (!body.weekdays.includes(d.getUTCDay())) continue;
      for (const userId of body.userIds) {
        if (leaves.some((l) => l.userId === userId && l.startDate <= d && l.endDate >= d)) { skippedLeave++; continue; }
        data.push({
          userId, shiftId: shift.id, date: new Date(d), startTime: body.startTime ?? shift.startTime, endTime: body.endTime ?? shift.endTime, notes: body.notes, createdById: req.ctx.userId,
          staffType: staffTypes.get(userId) ?? null, originalUserId: userId,
        });
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
      const a = await tx.shiftAssignment.findUnique({ where: { id: req.params.id }, include: { _count: { select: { attendance: true, events: true, coverages: true } }, user: { select: { fullName: true } } } });
      if (!a) throw notFound();
      if (a._count.attendance) throw badRequest('لا يمكن حذف دوام عليه حضور مسجل');
      // Its history (purchase, protection, swap, release, coverage) and any E Coin spent on it must stay traceable.
      if (a._count.events || a._count.coverages || (await tx.eCoinTxn.count({ where: { assignmentId: a.id } }))) {
        throw badRequest('لا يمكن حذف دوام عليه عمليات (شراء، تأمين، تبديل، تنازل أو تغطية). أعد توزيعه بدلاً من حذفه');
      }
      await tx.shiftAssignment.delete({ where: { id: a.id } });
      await audit(tx, req.ctx, { action: 'schedule.delete', entityType: 'shift_assignment', entityId: a.id, summary: `${a.user?.fullName ?? 'شاغر'} ${dateOnlyStr(a.date)}`, before: a });
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
    const approved = manager || !(await getPolicy()).leaves.needsApproval;
    const leave = await prisma.$transaction(async (tx) => {
      const l = await tx.leave.create({
        data: {
          userId, type: body.type, startDate: dateOnly(body.startDate), endDate: dateOnly(body.endDate), reason: body.reason, createdById: req.ctx.userId,
          ...(approved && { status: 'APPROVED', decidedById: manager ? req.ctx.userId : null, decidedAt: new Date() }),
        },
        include: { user: userMini },
      });
      if (approved) await syncLeave(tx, l, true);
      await audit(tx, req.ctx, { action: 'leave.create', entityType: 'leave', entityId: l.id, summary: `إجازة ${l.user.fullName} ${body.startDate} → ${body.endDate}`, after: l });
      if (!approved) await notifyPermission('shifts.manage', { type: 'SYSTEM', title: `طلب إجازة من ${l.user.fullName}`, body: `${body.startDate} → ${body.endDate}`, link: '/staff/leaves' }, tx);
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
      if (status === 'APPROVED' && before.status !== 'APPROVED') await syncLeave(tx, row, true);
      if (status !== 'APPROVED' && before.status === 'APPROVED') await syncLeave(tx, row, false);
      await audit(tx, req.ctx, { action: 'leave.decision', entityType: 'leave', entityId: row.id, before: { status: before.status }, after: { status } });
      return row;
    });
    res.json(l);
  }),
);

/** Days of the year covered by approved leave of each type (for the balances). */
staffRouter.get(
  '/leaves/balances',
  requireAnyPerm('shifts.view', 'shifts.manage'),
  ah(async (req, res) => {
    const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query);
    const year = q.year ?? new Date().getFullYear();
    const from = dateOnly(`${year}-01-01`), to = dateOnly(`${year}-12-31`);
    const manager = can(req.ctx, 'shifts.manage');
    const p = await getPolicy();
    const users = await prisma.user.findMany({ where: { deletedAt: null, isActive: true, ...(!manager && { id: req.ctx.userId }) }, select: { id: true, fullName: true, staffType: true }, orderBy: { fullName: 'asc' } });
    const leaves = await prisma.leave.findMany({ where: { status: 'APPROVED', userId: { in: users.map((u) => u.id) }, startDate: { lte: to }, endDate: { gte: from } } });
    const days = (l: { startDate: Date; endDate: Date }) => Math.round(((l.endDate < to ? l.endDate : to).getTime() - (l.startDate > from ? l.startDate : from).getTime()) / 86_400_000) + 1;
    res.json({ year, annualDays: p.leaves.annualDays, sickDays: p.leaves.sickDays, rows: users.map((u) => {
      const used = (t: string) => leaves.filter((l) => l.userId === u.id && l.type === t).reduce((s, l) => s + days(l), 0);
      return { user: u, annualUsed: used('ANNUAL'), annualLeft: p.leaves.annualDays - used('ANNUAL'), sickUsed: used('SICK'), sickLeft: p.leaves.sickDays - used('SICK'), unpaidUsed: used('UNPAID'), otherUsed: used('EMERGENCY') + used('OTHER') };
    }) });
  }),
);

/** An approved leave day is never an absence: its records become «إجازة» (and go back to «لم يسجل» if it is withdrawn). */
async function syncLeave(tx: Tx, l: { userId: string; startDate: Date; endDate: Date }, approved: boolean) {
  await assertOpen(tx, [l.startDate, l.endDate]);
  const range = { gte: l.startDate, lte: l.endDate };
  if (approved) await tx.attendance.updateMany({ where: { userId: l.userId, date: range, checkIn: null, status: { in: ['ABSENT', 'NO_RECORD'] } }, data: { status: 'LEAVE', excused: false } });
  else await tx.attendance.updateMany({ where: { userId: l.userId, date: range, checkIn: null, status: 'LEAVE' }, data: { status: 'NO_RECORD' } });
}

// ── Attendance ──

const reasonStr = z.string().trim().min(3, 'اكتب السبب (3 أحرف على الأقل)').max(300);
const recordInclude = { user: userMini, shiftAssignment: { select: { id: true, date: true, startTime: true, endTime: true, shift: { select: { name: true } } } } } as const;

async function upsertAttendance(
  tx: Tx, ctx: Ctx, userId: string, day: string,
  patch: { checkIn?: Date | null; checkOut?: Date | null; status?: AttendanceStatus; notes?: string | null; assignmentId?: string | null; excused?: boolean },
  edit?: { reason: string },
) {
  const date = dateOnly(day);
  const policy = await getPolicy(tx);
  await assertOpen(tx, [date], policy);
  const existing = await tx.attendance.findUnique({ where: { userId_date: { userId, date } } });
  const linked = patch.assignmentId ?? existing?.shiftAssignmentId;
  let assignment = linked ? await tx.shiftAssignment.findUnique({ where: { id: linked } }) : null;
  // The slot may have changed hands since (swap, release): only the employee's own shift counts.
  if (!assignment || assignment.userId !== userId) assignment = await tx.shiftAssignment.findFirst({ where: { userId, date }, orderBy: { startTime: 'asc' } });
  const checkIn = patch.checkIn !== undefined ? patch.checkIn : existing?.checkIn ?? null;
  const checkOut = patch.checkOut !== undefined ? patch.checkOut : existing?.checkOut ?? null;
  if (checkOut && !checkIn) throw badRequest('لا يمكن تسجيل مغادرة بدون حضور');
  if (checkIn && checkOut && checkOut < checkIn) throw badRequest('وقت المغادرة قبل وقت الحضور');
  const ev = await evaluateFor(tx, userId, assignment, checkIn, checkOut, policy);
  const status = patch.status && ['ABSENT', 'LEAVE', 'NO_RECORD'].includes(patch.status) ? patch.status : ev.status;
  const data = {
    checkIn, checkOut, status, lateMinutes: ev.lateMinutes, earlyLeaveMinutes: ev.earlyLeaveMinutes, workedMinutes: ev.workedMinutes, overtimeMinutes: ev.overtimeMinutes,
    shiftAssignmentId: assignment?.id ?? null, notes: patch.notes !== undefined ? patch.notes : existing?.notes ?? null, recordedById: ctx.userId,
    excused: status === 'ABSENT' ? patch.excused ?? existing?.excused ?? false : false,
    // Decisions that no longer have anything to decide on are cleared.
    ...(!ev.lateMinutes && { lateDecision: null, lateExcuseStatus: null }),
    ...(!ev.overtimeMinutes && { overtimeDecision: null }),
    ...(edit && { editedById: ctx.userId, editedAt: new Date(), editReason: edit.reason }),
  };
  const row = existing
    ? await tx.attendance.update({ where: { id: existing.id }, data })
    : await tx.attendance.create({ data: { ...data, userId, date } });
  await audit(tx, ctx, { action: existing ? 'attendance.update' : 'attendance.create', entityType: 'attendance', entityId: row.id, summary: edit ? `تعديل سجل حضور ${day} — السبب: ${edit.reason}` : undefined, before: existing, after: row });
  if (ev.lateMinutes > 0 && (!existing || !existing.lateMinutes)) {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    await notifyPermission('attendance.manage', {
      type: 'STAFF_LATE', title: `تأخر موظف: ${u?.fullName}`, body: `تأخير ${ev.lateMinutes} دقيقة`, link: '/staff/attendance', dedupeKey: `late:${userId}:${day}`,
    }, tx, userId);
  }
  return row;
}

/** Today's record, or the one still open (an overnight shift, or a shift that starts after midnight). */
async function myOpenRecord(db: Tx | typeof prisma, userId: string, now: Date) {
  const today = dateOnly(now);
  return db.attendance.findFirst({ where: { userId, checkIn: { not: null }, checkOut: null, date: { gte: addDays(today, -1), lte: addDays(today, 1) } }, orderBy: { date: 'desc' } });
}

staffRouter.get(
  '/attendance/me',
  ah(async (req, res) => {
    const now = new Date();
    const open = await myOpenRecord(prisma, req.ctx.userId, now);
    const assignment = open?.shiftAssignmentId ? await prisma.shiftAssignment.findUnique({ where: { id: open.shiftAssignmentId }, include: { shift: { select: { name: true } } } }) : await shiftAt(prisma, req.ctx.userId, now);
    const record = open ?? (assignment ? await prisma.attendance.findUnique({ where: { userId_date: { userId: req.ctx.userId, date: assignment.date } } }) : null) ?? await prisma.attendance.findUnique({ where: { userId_date: { userId: req.ctx.userId, date: dateOnly(now) } } });
    res.json({ record, assignment, canCheckIn: can(req.ctx, 'attendance.check_in'), canCheckOut: can(req.ctx, 'attendance.check_out') });
  }),
);

staffRouter.post(
  '/attendance/check-in',
  requirePerm('attendance.check_in'),
  ah(async (req, res) => {
    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      if (await myOpenRecord(tx, req.ctx.userId, now)) throw badRequest('أنت مسجّل حضور حالياً؛ سجّل المغادرة أولاً');
      const a = await shiftAt(tx, req.ctx.userId, now);
      const day = a ? dateOnlyStr(a.date) : ymd(now);
      const existing = await tx.attendance.findUnique({ where: { userId_date: { userId: req.ctx.userId, date: dateOnly(day) } } });
      if (existing?.checkIn) throw badRequest(a ? 'تم تسجيل الحضور لهذا الشفت مسبقاً' : 'تم تسجيل الحضور مسبقاً اليوم');
      return upsertAttendance(tx, req.ctx, req.ctx.userId, day, { checkIn: now, assignmentId: a?.id ?? null });
    });
    res.json(row);
  }),
);

staffRouter.post(
  '/attendance/check-out',
  requirePerm('attendance.check_out'),
  ah(async (req, res) => {
    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      const rec = await myOpenRecord(tx, req.ctx.userId, now);
      if (!rec) {
        const done = await tx.attendance.findFirst({ where: { userId: req.ctx.userId, date: dateOnly(now), checkOut: { not: null } } });
        throw badRequest(done ? 'تم تسجيل المغادرة مسبقاً' : 'لا يوجد تسجيل حضور؛ سجّل الحضور أولاً قبل تسجيل المغادرة');
      }
      return upsertAttendance(tx, req.ctx, req.ctx.userId, dateOnlyStr(rec.date), { checkOut: now });
    });
    res.json(row);
  }),
);

/** Manual entry or correction by a manager; correcting an existing record needs a reason (kept with the record and in the audit log). */
staffRouter.post(
  '/attendance',
  requirePerm('attendance.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ userId: z.string().uuid(), date: ymdStr, checkIn: optionalDate, checkOut: optionalDate, status: z.nativeEnum(AttendanceStatus).optional(), excused: z.boolean().optional(), notes: nullableStr(300), reason: z.string().trim().max(300).optional() }),
      req.body,
    );
    const off = ['ABSENT', 'LEAVE', 'NO_RECORD'].includes(body.status ?? '');
    if (!body.checkIn && !off) throw badRequest('أدخل وقت الحضور أو اختر غياب/إجازة');
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.attendance.findUnique({ where: { userId_date: { userId: body.userId, date: dateOnly(body.date) } } });
      if (existing && (body.reason ?? '').length < 3) throw badRequest('اكتب سبب تعديل السجل');
      return upsertAttendance(tx, req.ctx, body.userId, body.date, {
        checkIn: off ? null : body.checkIn ?? null,
        checkOut: off ? null : body.checkOut ?? null,
        status: body.status, excused: body.excused, notes: body.notes,
      }, existing ? { reason: body.reason! } : body.reason ? { reason: body.reason } : undefined);
    });
    res.json(row);
  }),
);

/** A decision on one record: checks the month is open, saves, and logs the reason. */
async function decide(req: { params: Record<string, string>; ctx: Ctx }, action: string, summary: string, change: (r: Prisma.AttendanceGetPayload<object>, p: Awaited<ReturnType<typeof getPolicy>>) => Prisma.AttendanceUpdateInput | Promise<Prisma.AttendanceUpdateInput>) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.attendance.findUnique({ where: { id: req.params.id } });
    if (!r) throw notFound('سجل الحضور غير موجود');
    const p = await getPolicy(tx);
    await assertOpen(tx, [r.date], p);
    const row = await tx.attendance.update({ where: { id: r.id }, data: await change(r, p) });
    await audit(tx, req.ctx, { action, entityType: 'attendance', entityId: r.id, summary: `${summary} (${dateOnlyStr(r.date)})`, before: r, after: row });
    return row;
  });
}

staffRouter.post('/attendance/:id/late', requirePerm('attendance.late.approve'), ah(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['DEDUCT', 'EXEMPT']).nullable(), reason: reasonStr }), req.body);
  res.json(await decide(req, 'attendance.late_decision', `قرار التأخير: ${b.decision === 'EXEMPT' ? 'إعفاء' : b.decision === 'DEDUCT' ? 'خصم' : 'حسب السياسة'} — ${b.reason}`, (r, p) => {
    if (!r.lateMinutes) throw badRequest('لا يوجد تأخير في هذا السجل');
    if (b.decision === 'EXEMPT' && !p.late.allowExemption) throw badRequest('الإعفاء من خصم التأخير غير مفعّل في الإعدادات');
    return { lateDecision: b.decision };
  }));
}));

staffRouter.post('/attendance/:id/excuse', ah(async (req, res) => {
  const b = parse(z.object({ text: z.string().trim().min(3, 'اكتب مبرر التأخير').max(500) }), req.body);
  const row = await decide(req, 'attendance.late_excuse', `مبرر تأخير: ${b.text}`, async (r, p) => {
    if (r.userId !== req.ctx.userId && !can(req.ctx, 'attendance.manage')) throw forbidden();
    if (!p.late.allowExcuse) throw badRequest('تسجيل مبرر التأخير غير مفعّل في الإعدادات');
    if (!r.lateMinutes) throw badRequest('لا يوجد تأخير في هذا السجل');
    if (r.lateExcuseStatus && r.lateExcuseStatus !== 'PENDING') throw badRequest('تم البت في مبرر هذا التأخير');
    return { lateExcuse: b.text, lateExcuseStatus: 'PENDING' };
  });
  await notifyPermission('attendance.late.approve', { type: 'STAFF_LATE', title: 'مبرر تأخير بانتظار القرار', body: b.text.slice(0, 120), link: '/staff/attendance', dedupeKey: `excuse:${row.id}` }, prisma, req.ctx.userId);
  res.json(row);
}));

staffRouter.post('/attendance/:id/excuse-decision', requirePerm('attendance.late.approve'), ah(async (req, res) => {
  const b = parse(z.object({ accept: z.boolean(), reason: z.string().trim().max(300).optional() }), req.body);
  res.json(await decide(req, 'attendance.excuse_decision', `${b.accept ? 'قبول' : 'رفض'} مبرر التأخير${b.reason ? ` — ${b.reason}` : ''}`, (r) => {
    if (r.lateExcuseStatus !== 'PENDING') throw badRequest('لا يوجد مبرر بانتظار القرار');
    return { lateExcuseStatus: b.accept ? 'ACCEPTED' : 'REJECTED' };
  }));
}));

staffRouter.post('/attendance/:id/overtime', requirePerm('attendance.overtime.approve'), ah(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']).nullable(), reason: reasonStr }), req.body);
  res.json(await decide(req, 'attendance.overtime_decision', `العمل الإضافي: ${b.decision === 'APPROVED' ? 'اعتماد' : b.decision === 'REJECTED' ? 'رفض' : 'حسب السياسة'} — ${b.reason}`, (r) => {
    if (!r.overtimeMinutes) throw badRequest('لا يوجد عمل إضافي في هذا السجل');
    return { overtimeDecision: b.decision };
  }));
}));

staffRouter.post('/attendance/:id/absence', requirePerm('attendance.manage'), ah(async (req, res) => {
  const b = parse(z.object({ excused: z.boolean(), reason: reasonStr }), req.body);
  res.json(await decide(req, 'attendance.absence', `${b.excused ? 'غياب مبرر' : 'غياب غير مبرر'} — ${b.reason}`, (r) => {
    if (r.status !== 'ABSENT') throw badRequest('السجل ليس غياباً');
    return { excused: b.excused };
  }));
}));

staffRouter.post('/attendance/:id/review', requirePerm('attendance.manage'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body);
  res.json(await decide(req, 'attendance.review', `اعتماد سجل الحضور${b.reason ? ` — ${b.reason}` : ''}`, () => ({ reviewedById: req.ctx.userId, reviewedAt: new Date() })));
}));

staffRouter.get(
  '/attendance',
  requirePerm('attendance.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ from: ymdStr, to: ymdStr, userId: z.string().uuid().optional(), status: z.nativeEnum(AttendanceStatus).optional(), pending: z.enum(['1']).optional() }), req.query);
    const policy = await getPolicy();
    const where: Prisma.AttendanceWhereInput = {
      date: { gte: dateOnly(q.from), lte: dateOnly(q.to) },
      ...(!can(req.ctx, 'attendance.manage') ? { userId: req.ctx.userId } : q.userId ? { userId: q.userId } : {}),
      ...(q.status && { status: q.status }),
      ...(q.pending && { OR: [
        { status: 'NO_RECORD', reviewedAt: null },
        { checkIn: { not: null }, checkOut: null, reviewedAt: null, date: { lt: dateOnly() } },
        { lateExcuseStatus: 'PENDING' },
        ...(policy.late.deduct && policy.late.mode === 'APPROVAL' ? [{ lateMinutes: { gt: 0 }, lateDecision: null }] : []),
        ...(policy.overtime.enabled ? [{ overtimeMinutes: { gte: Math.max(1, policy.overtime.minMinutes) }, overtimeDecision: null }] : []),
      ] }),
    };
    const scope = !can(req.ctx, 'attendance.manage') ? req.ctx.userId : q.userId;
    // Shifts that are over with nothing recorded are listed too (not saved): «لم يسجل الحضور», needing review.
    const virtual = !q.status || q.status === 'NO_RECORD' ? await missingShifts(scope, dateOnly(q.from), dateOnly(q.to)) : [];
    const [page, total, totals] = await Promise.all([
      virtual.length
        ? prisma.attendance.findMany({ where, orderBy: [{ date: 'desc' }], include: recordInclude, take: 5000 })
        : prisma.attendance.findMany({ where, ...paginate(q), orderBy: [{ date: 'desc' }], include: recordInclude }),
      prisma.attendance.count({ where }),
      prisma.attendance.aggregate({ where, _sum: { lateMinutes: true, earlyLeaveMinutes: true, workedMinutes: true, overtimeMinutes: true } }),
    ]);
    const items = page as (typeof page[number] | VirtualRow)[];
    if (virtual.length) {
      items.push(...virtual);
      items.sort((a, b) => b.date.getTime() - a.date.getTime() || a.user.fullName.localeCompare(b.user.fullName, 'ar'));
      items.splice(0, (q.page - 1) * q.pageSize);
      items.splice(q.pageSize);
    }
    const ids = [...new Set(items.map((r) => r.userId))];
    const [emp, jobs, editors] = await Promise.all([
      empPolicies(prisma, ids),
      prisma.salaryProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, jobTitle: true } }),
      prisma.user.findMany({ where: { id: { in: items.map((r) => r.editedById).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } }),
    ]);
    const now = new Date();
    res.json({
      ...paged(items.map((r) => ({
        ...r,
        jobTitle: jobs.find((j) => j.userId === r.userId)?.jobTitle ?? null,
        editedBy: editors.find((u) => u.id === r.editedById)?.fullName ?? null,
        ...('virtual' in r ? { state: 'NO_RECORD', review: 'NEEDS_REVIEW', pending: ['NO_RECORD'] } : display(r, policy, emp.get(r.userId) ?? {}, now)),
      })), total + virtual.length, q),
      totals: totals._sum,
    });
  }),
);

type VirtualRow = ReturnType<typeof virtualRow>;
const virtualRow = (a: Prisma.ShiftAssignmentGetPayload<{ include: { user: typeof userMini; shift: { select: { name: true } } } }>) => ({
  id: `shift:${a.id}`, virtual: true as const, userId: a.userId!, date: a.date, checkIn: null, checkOut: null, status: 'NO_RECORD' as const,
  lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, excused: false, lateDecision: null, lateExcuse: null, lateExcuseStatus: null,
  overtimeDecision: null, editReason: null, editedById: null as string | null, notes: null, user: a.user!,
  shiftAssignment: { id: a.id, date: a.date, startTime: a.startTime, endTime: a.endTime, shift: a.shift },
});

/** Shifts already over with no attendance record and no approved leave (one per employee and day). Nothing is saved. */
async function missingShifts(userId: string | undefined, from: Date, to: Date) {
  const now = new Date();
  const list = await prisma.shiftAssignment.findMany({
    where: { date: { gte: from, lte: to }, userId: userId ?? { not: null } },
    include: { user: userMini, shift: { select: { name: true } } }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
  const ended = list.filter((a) => a.user && shiftWindow(a).end < now);
  if (!ended.length) return [];
  const users = [...new Set(ended.map((a) => a.userId!))];
  const [recs, leaves] = await Promise.all([
    prisma.attendance.findMany({ where: { userId: { in: users }, date: { gte: from, lte: to } }, select: { userId: true, date: true } }),
    prisma.leave.findMany({ where: { userId: { in: users }, status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } }, select: { userId: true, startDate: true, endDate: true } }),
  ]);
  const seen = new Set(recs.map((r) => `${r.userId}|${dateOnlyStr(r.date)}`));
  const out: VirtualRow[] = [];
  for (const a of ended) {
    const key = `${a.userId}|${dateOnlyStr(a.date)}`;
    if (seen.has(key) || leaves.some((l) => l.userId === a.userId && l.startDate <= a.date && l.endDate >= a.date)) continue;
    seen.add(key);
    out.push(virtualRow(a));
  }
  return out;
}

// ── Manual overtime (recorded by a manager, with its reason) ──

staffRouter.get('/overtime', requireAnyPerm('attendance.overtime.approve', 'attendance.manage'), ah(async (req, res) => {
  const q = parse(z.object({ from: ymdStr, to: ymdStr, userId: z.string().uuid().optional() }), req.query);
  const rows = await prisma.overtimeEntry.findMany({ where: { date: { gte: dateOnly(q.from), lte: dateOnly(q.to) }, ...(q.userId && { userId: q.userId }) }, orderBy: [{ date: 'desc' }, { startAt: 'desc' }] });
  const users = await prisma.user.findMany({ where: { id: { in: [...rows.map((r) => r.userId), ...rows.map((r) => r.createdById).filter((x): x is string => !!x)] } }, select: { id: true, fullName: true } });
  res.json(rows.map((r) => ({ ...r, date: dateOnlyStr(r.date), user: users.find((u) => u.id === r.userId)?.fullName, createdBy: users.find((u) => u.id === r.createdById)?.fullName })));
}));

const overlaps = (a1: Date, a2: Date, b1: Date, b2: Date) => a1 < b2 && b1 < a2;

staffRouter.post('/overtime', requirePerm('attendance.overtime.approve'), ah(async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid('اختر الموظف'), date: ymdStr, start: hhmm, end: hhmm, reason: reasonStr }), req.body);
  const startAt = new Date(`${b.date}T${b.start}:00`);
  let endAt = new Date(`${b.date}T${b.end}:00`);
  if (endAt <= startAt) endAt = addDays(endAt, 1);
  const minutes = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
  if (minutes > 16 * 60) throw badRequest('مدة العمل الإضافي طويلة جداً');
  const row = await prisma.$transaction(async (tx) => {
    const day = dateOnly(b.date);
    await assertOpen(tx, [day]);
    // The same period is never paid twice: not inside a shift, the recorded overtime of a day, or another entry.
    const shifts = await tx.shiftAssignment.findMany({ where: { userId: b.userId, date: { gte: addDays(day, -1), lte: addDays(day, 1) } } });
    const s = shifts.find((x) => { const w = shiftWindow(x); return overlaps(startAt, endAt, w.start, w.end); });
    if (s) throw badRequest(`الفترة تتداخل مع شفت مجدول للموظف (${dateOnlyStr(s.date)} ${s.startTime}–${s.endTime})`);
    const att = await tx.attendance.findMany({ where: { userId: b.userId, date: { gte: addDays(day, -1), lte: addDays(day, 1) }, overtimeMinutes: { gt: 0 }, checkOut: { not: null } }, include: { shiftAssignment: true } });
    const a = att.find((x) => x.shiftAssignment && overlaps(startAt, endAt, shiftWindow(x.shiftAssignment).end, x.checkOut!));
    if (a) throw badRequest(`الفترة محسوبة عملاً إضافياً من سجل حضور ${dateOnlyStr(a.date)}`);
    const other = await tx.overtimeEntry.findFirst({ where: { userId: b.userId, startAt: { lt: endAt }, endAt: { gt: startAt } } });
    if (other) throw badRequest('يوجد عمل إضافي مسجل يدوياً في نفس الفترة');
    const e = await tx.overtimeEntry.create({ data: { userId: b.userId, date: day, startAt, endAt, minutes, reason: b.reason, createdById: req.ctx.userId } });
    await audit(tx, req.ctx, { action: 'overtime.create', entityType: 'overtime_entry', entityId: e.id, summary: `عمل إضافي يدوي ${b.date} ${b.start}–${b.end} — ${b.reason}`, after: e });
    return e;
  });
  res.status(201).json(row);
}));

staffRouter.post('/overtime/:id/delete', requirePerm('attendance.overtime.approve'), ah(async (req, res) => {
  const b = parse(z.object({ reason: reasonStr }), req.body);
  await prisma.$transaction(async (tx) => {
    const e = await tx.overtimeEntry.findUnique({ where: { id: req.params.id } });
    if (!e) throw notFound();
    await assertOpen(tx, [e.date]);
    await tx.overtimeEntry.delete({ where: { id: e.id } });
    await audit(tx, req.ctx, { action: 'overtime.delete', entityType: 'overtime_entry', entityId: e.id, summary: `حذف عمل إضافي يدوي — ${b.reason}`, before: e });
  });
  res.json({ ok: true });
}));

// ── Policy (read by the attendance and payroll screens) ──

staffRouter.get('/policy', requireAnyPerm('attendance.view', 'attendance.settings.view', 'attendance.settings.manage', 'accounting.payroll.view', 'accounting.payroll.manage'), ah(async (_req, res) => res.json(await getPolicy())));
