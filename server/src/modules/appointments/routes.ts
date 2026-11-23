import { Router } from 'express';
import { z } from 'zod';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, requiredDate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { getSetting } from '../../lib/settings';
import { createVisit } from '../visits/service';
import { Priority } from '@prisma/client';

export const appointmentsRouter = Router();

const include = {
  patient: { select: { id: true, fullName: true, phone: true, fileNumber: true } },
  doctor: { select: { id: true, fullName: true } },
  visitType: { select: { id: true, name: true, color: true } },
  visit: { select: { id: true, status: true, queueNumber: true } },
} satisfies Prisma.AppointmentInclude;

const baseBody = z.object({
  patientId: z.string().uuid('اختر المريض'),
  doctorId: z.string().uuid('اختر الطبيب'),
  visitTypeId: z.string().uuid().nullable().optional(),
  startAt: requiredDate,
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  reason: nullableStr(500),
  notes: nullableStr(1000),
  force: z.boolean().optional(),
});

async function assertNoConflict(doctorId: string, startAt: Date, endAt: Date, excludeId?: string) {
  const clash = await prisma.appointment.findFirst({
    where: {
      doctorId, status: { in: ['SCHEDULED', 'CONFIRMED', 'ARRIVED'] }, startAt: { lt: endAt }, endAt: { gt: startAt },
      ...(excludeId && { id: { not: excludeId } }),
    },
    include: { patient: { select: { fullName: true } } },
  });
  if (clash) {
    const t = clash.startAt.toLocaleTimeString('ar-JO', { hour: '2-digit', minute: '2-digit' });
    throw new AppError(409, 'APPOINTMENT_CONFLICT', `يوجد موعد متعارض للطبيب الساعة ${t} (${clash.patient.fullName})`);
  }
}

appointmentsRouter.get(
  '/',
  requirePerm('appointments.view'),
  ah(async (req, res) => {
    const q = parse(
      z.object({
        from: requiredDate, to: requiredDate, doctorId: z.string().uuid().optional(), status: z.nativeEnum(AppointmentStatus).optional(),
        patientId: z.string().uuid().optional(), q: z.string().trim().optional(),
      }),
      req.query,
    );
    if (q.to.getTime() - q.from.getTime() > 1000 * 86_400_000) throw badRequest('الفترة طويلة جداً');
    const items = await prisma.appointment.findMany({
      where: {
        startAt: { gte: q.from, lt: q.to },
        ...(q.doctorId && { doctorId: q.doctorId }),
        ...(q.status && { status: q.status }),
        ...(q.patientId && { patientId: q.patientId }),
        ...(q.q && { OR: [{ patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { patient: { phone: { contains: q.q } } }, { reason: { contains: q.q, mode: 'insensitive' } }] }),
      },
      include,
      orderBy: { startAt: 'asc' },
      take: 2000,
    });
    res.json(items);
  }),
);

appointmentsRouter.get(
  '/:id',
  requirePerm('appointments.view'),
  ah(async (req, res) => {
    const a = await prisma.appointment.findUnique({ where: { id: req.params.id }, include });
    if (!a) throw notFound();
    res.json(a);
  }),
);

appointmentsRouter.post(
  '/',
  requirePerm('appointments.manage'),
  ah(async (req, res) => {
    const body = parse(baseBody, req.body);
    const { defaultAppointmentMinutes } = await getSetting('medical');
    let duration = body.durationMin;
    if (!duration && body.visitTypeId) duration = (await prisma.visitType.findUnique({ where: { id: body.visitTypeId } }))?.durationMin;
    const endAt = new Date(body.startAt.getTime() + (duration ?? defaultAppointmentMinutes) * 60_000);
    const doctor = await prisma.user.findFirst({ where: { id: body.doctorId, staffType: 'DOCTOR', isActive: true, deletedAt: null } });
    if (!doctor) throw badRequest('الطبيب المحدد غير متاح');
    if (!body.force) await assertNoConflict(body.doctorId, body.startAt, endAt);
    const appt = await prisma.$transaction(async (tx) => {
      const a = await tx.appointment.create({
        data: { patientId: body.patientId, doctorId: body.doctorId, visitTypeId: body.visitTypeId, startAt: body.startAt, endAt, reason: body.reason, notes: body.notes, branchId: req.ctx.branchId, createdById: req.ctx.userId },
        include,
      });
      await audit(tx, req.ctx, { action: 'appointment.create', entityType: 'appointment', entityId: a.id, summary: `موعد ${a.patient.fullName} مع ${a.doctor.fullName}`, after: a });
      return a;
    });
    res.status(201).json(appt);
  }),
);

/** Edit / reschedule. */
appointmentsRouter.put(
  '/:id',
  requirePerm('appointments.manage'),
  ah(async (req, res) => {
    const body = parse(baseBody.partial(), req.body);
    const before = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    if (!['SCHEDULED', 'CONFIRMED'].includes(before.status)) throw badRequest('لا يمكن تعديل موعد منتهٍ أو ملغى');
    const startAt = body.startAt ?? before.startAt;
    const duration = body.durationMin ?? (before.endAt.getTime() - before.startAt.getTime()) / 60_000;
    const endAt = new Date(startAt.getTime() + duration * 60_000);
    const doctorId = body.doctorId ?? before.doctorId;
    if (!body.force) await assertNoConflict(doctorId, startAt, endAt, before.id);
    const rescheduled = startAt.getTime() !== before.startAt.getTime();
    const appt = await prisma.$transaction(async (tx) => {
      const a = await tx.appointment.update({
        where: { id: before.id },
        data: {
          patientId: body.patientId, doctorId, visitTypeId: body.visitTypeId, startAt, endAt, reason: body.reason, notes: body.notes,
          ...(rescheduled && { status: 'SCHEDULED' }),
        },
        include,
      });
      await audit(tx, req.ctx, { action: rescheduled ? 'appointment.reschedule' : 'appointment.update', entityType: 'appointment', entityId: a.id, before, after: a });
      return a;
    });
    res.json(appt);
  }),
);

appointmentsRouter.post(
  '/:id/status',
  requirePerm('appointments.manage'),
  ah(async (req, res) => {
    const body = parse(z.object({ status: z.enum(['SCHEDULED', 'CONFIRMED', 'CANCELLED', 'NO_SHOW']), reason: nullableStr(300) }), req.body);
    const appt = await prisma.$transaction(async (tx) => {
      const a = await tx.appointment.findUnique({ where: { id: req.params.id } });
      if (!a) throw notFound();
      if (['COMPLETED', 'ARRIVED'].includes(a.status)) throw badRequest('المريض حضر بالفعل لهذا الموعد');
      if (body.status === 'CANCELLED' && !body.reason) throw badRequest('يرجى ذكر سبب الإلغاء');
      const u = await tx.appointment.update({ where: { id: a.id }, data: { status: body.status, ...(body.status === 'CANCELLED' && { cancelReason: body.reason }) }, include });
      await audit(tx, req.ctx, { action: 'appointment.status', entityType: 'appointment', entityId: a.id, before: { status: a.status }, after: { status: body.status, reason: body.reason } });
      return u;
    });
    res.json(appt);
  }),
);

/** Patient arrived → creates the visit and puts them in the queue. */
appointmentsRouter.post(
  '/:id/check-in',
  requirePerm('queue.manage'),
  ah(async (req, res) => {
    const body = parse(z.object({ priority: z.nativeEnum(Priority).default('NORMAL'), chiefComplaint: nullableStr(500) }), req.body ?? {});
    const visit = await prisma.$transaction(async (tx) => {
      const a = await tx.appointment.findUnique({ where: { id: req.params.id }, include: { visit: true } });
      if (!a) throw notFound();
      if (a.visit) throw badRequest('تم تسجيل حضور هذا الموعد مسبقاً');
      if (!['SCHEDULED', 'CONFIRMED'].includes(a.status)) throw badRequest('الموعد ملغى أو منتهٍ');
      return createVisit(tx, req.ctx, {
        patientId: a.patientId, doctorId: a.doctorId, visitTypeId: a.visitTypeId, appointmentId: a.id, priority: body.priority,
        chiefComplaint: body.chiefComplaint ?? a.reason,
      });
    });
    res.status(201).json(visit);
  }),
);
