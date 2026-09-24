import { Router } from 'express';
import { z } from 'zod';
import { Priority, Prisma, VisitStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { dateOnly, rangeFromQuery } from '../../lib/dates';
import { ageFrom } from '../../lib/dates';
import { can } from '../../auth/context';
import { ACTIVE_STATUSES } from './stateMachine';
import { changeVisitStatus, createVisit, positionFor } from './service';

export const visitsRouter = Router();

const createBody = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid().nullable().optional(),
  visitTypeId: z.string().uuid().nullable().optional(),
  priority: z.nativeEnum(Priority).default('NORMAL'),
  chiefComplaint: nullableStr(500),
  notes: nullableStr(1000),
  appointmentId: z.string().uuid().nullable().optional(),
  allowDuplicate: z.boolean().optional(),
});

visitsRouter.post(
  '/',
  requirePerm('queue.manage'),
  ah(async (req, res) => {
    const body = parse(createBody, req.body);
    const visit = await prisma.$transaction((tx) => createVisit(tx, req.ctx, body));
    res.status(201).json(visit);
  }),
);

/** Queue board: visits of a day, ordered by queue position. Doctors see only their own patients. */
visitsRouter.get(
  '/queue',
  requirePerm('queue.view'),
  ah(async (req, res) => {
    const q = parse(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        doctorId: z.string().uuid().optional(),
        status: z.union([z.nativeEnum(VisitStatus), z.literal('ACTIVE'), z.literal('ALL')]).default('ALL'),
      }),
      req.query,
    );
    let doctorId = q.doctorId;
    if (!can(req.ctx, 'queue.view_all')) doctorId = req.ctx.userId;
    const where: Prisma.VisitWhereInput = {
      queueDate: dateOnly(q.date ?? new Date()),
      ...(req.ctx.branchId && { branchId: req.ctx.branchId }),
      ...(doctorId && (can(req.ctx, 'queue.view_all') ? { doctorId } : { OR: [{ doctorId }, { doctorId: null }] })),
      ...(q.status === 'ACTIVE' ? { status: { in: ACTIVE_STATUSES } } : q.status !== 'ALL' ? { status: q.status } : {}),
    };
    const visits = await prisma.visit.findMany({
      where,
      orderBy: [{ queuePosition: 'asc' }],
      select: {
        id: true, visitNumber: true, queueNumber: true, queuePosition: true, status: true, priority: true,
        arrivedAt: true, calledAt: true, nurseStartedAt: true, doctorStartedAt: true, completedAt: true, cancelReason: true,
        chiefComplaint: true, notes: true, appointmentId: true,
        patient: { select: { id: true, fullName: true, phone: true, fileNumber: true, gender: true, dateOfBirth: true } },
        doctor: { select: { id: true, fullName: true } },
        visitType: { select: { id: true, name: true, color: true } },
        _count: { select: { vitalSigns: true, labOrders: true, invoices: true } },
        invoices: { where: { status: { not: 'CANCELLED' } }, select: { id: true, status: true, balance: true, total: true } },
      },
    });
    const items = visits.map((v) => ({ ...v, patient: { ...v.patient, age: ageFrom(v.patient.dateOfBirth) } }));
    const counts = await prisma.visit.groupBy({ by: ['status'], where: { ...where, status: undefined }, _count: true });
    res.json({ items, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) });
  }),
);

/** Visit list (history / search) — non-clinical. */
visitsRouter.get(
  '/',
  requireAnyPerm('queue.view', 'patients.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ from: z.string().optional(), to: z.string().optional(), doctorId: z.string().uuid().optional(), status: z.nativeEnum(VisitStatus).optional(), patientId: z.string().uuid().optional() }), req.query);
    const { from, to } = rangeFromQuery(q.from, q.to ?? q.from);
    const where: Prisma.VisitWhereInput = {
      ...(q.patientId ? { patientId: q.patientId } : { arrivedAt: { gte: from, lte: to } }),
      ...(q.doctorId && { doctorId: q.doctorId }),
      ...(q.status && { status: q.status }),
      ...(q.q && { OR: [{ visitNumber: { contains: q.q } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { patient: { phone: { contains: q.q } } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.visit.findMany({
        where, orderBy: { arrivedAt: 'desc' }, ...paginate(q),
        select: {
          id: true, visitNumber: true, status: true, priority: true, arrivedAt: true, completedAt: true, queueNumber: true,
          patient: { select: { id: true, fullName: true, phone: true, fileNumber: true } },
          doctor: { select: { id: true, fullName: true } }, visitType: { select: { name: true } },
        },
      }),
      prisma.visit.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);

visitsRouter.get(
  '/:id',
  requireAnyPerm('queue.view', 'patients.view', 'medical.view'),
  ah(async (req, res) => {
    const medical = can(req.ctx, 'medical.view');
    const visit = await prisma.visit.findUnique({
      where: { id: req.params.id },
      include: {
        patient: {
          include: medical
            ? { allergies: true, histories: { where: { isActive: true } }, medications: { where: { isActive: true } } }
            : undefined,
        },
        doctor: { select: { id: true, fullName: true, specialty: true } },
        visitType: true,
        appointment: { select: { id: true, startAt: true } },
        statusLogs: { orderBy: { createdAt: 'asc' } },
        invoices: { select: { id: true, invoiceNumber: true, status: true, total: true, balance: true } },
        ...(medical && {
          vitalSigns: { orderBy: { recordedAt: 'desc' } },
          nursingNotes: { orderBy: { performedAt: 'desc' } },
          consultation: true,
          diagnoses: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
          prescriptions: { include: { items: { orderBy: { sortOrder: 'asc' } } }, orderBy: { createdAt: 'desc' } },
          labOrders: { include: { items: { include: { results: true } } }, orderBy: { requestedAt: 'desc' } },
          medicalReports: { orderBy: { createdAt: 'desc' } },
          attachments: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
        }),
      },
    });
    if (!visit) throw notFound('الزيارة غير موجودة');
    if (!medical) (visit as { chiefComplaint?: string | null }).chiefComplaint = undefined;
    const userIds = [...new Set(visit.statusLogs.map((l) => l.userId).filter(Boolean) as string[])];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    res.json({ ...visit, patient: { ...visit.patient, age: ageFrom(visit.patient.dateOfBirth) }, userNames: Object.fromEntries(users.map((u) => [u.id, u.fullName])), canViewMedical: medical });
  }),
);

visitsRouter.put(
  '/:id',
  requirePerm('queue.manage'),
  ah(async (req, res) => {
    const body = parse(createBody.pick({ doctorId: true, visitTypeId: true, priority: true, chiefComplaint: true, notes: true }).partial(), req.body);
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.visit.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound();
      if (body.doctorId) {
        const doc = await tx.user.findFirst({ where: { id: body.doctorId, staffType: 'DOCTOR', isActive: true, deletedAt: null } });
        if (!doc) throw badRequest('الطبيب المحدد غير متاح');
      }
      const data: Prisma.VisitUncheckedUpdateInput = { ...body };
      if (body.priority && body.priority !== before.priority && before.status === 'WAITING') {
        data.queuePosition = await positionFor(tx, before.queueDate, before.branchId, body.priority, before.id);
      }
      const v = await tx.visit.update({ where: { id: before.id }, data });
      await audit(tx, req.ctx, { action: 'visit.update', entityType: 'visit', entityId: v.id, before, after: v });
      return v;
    });
    res.json(updated);
  }),
);

visitsRouter.post(
  '/:id/status',
  requirePerm('queue.view'),
  ah(async (req, res) => {
    const body = parse(z.object({ status: z.nativeEnum(VisitStatus), note: nullableStr(500) }), req.body);
    const v = await prisma.$transaction((tx) => changeVisitStatus(tx, req.ctx, req.params.id, body.status, body.note));
    res.json(v);
  }),
);

/** Move a visit up/down in the active queue (swaps with its neighbour). */
visitsRouter.post(
  '/:id/move',
  requirePerm('queue.reorder'),
  ah(async (req, res) => {
    const { direction } = parse(z.object({ direction: z.enum(['up', 'down', 'top']) }), req.body);
    await prisma.$transaction(async (tx) => {
      const v = await tx.visit.findUnique({ where: { id: req.params.id } });
      if (!v) throw notFound();
      if (!ACTIVE_STATUSES.includes(v.status)) throw badRequest('لا يمكن تحريك زيارة منتهية');
      const list = await tx.visit.findMany({
        where: { queueDate: v.queueDate, branchId: v.branchId, status: { in: ACTIVE_STATUSES } },
        orderBy: { queuePosition: 'asc' },
        select: { id: true, queuePosition: true },
      });
      const i = list.findIndex((x) => x.id === v.id);
      if (direction === 'top') {
        if (i > 0) await tx.visit.update({ where: { id: v.id }, data: { queuePosition: list[0].queuePosition - 1000 } });
      } else {
        const j = direction === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        await tx.visit.update({ where: { id: v.id }, data: { queuePosition: list[j].queuePosition } });
        await tx.visit.update({ where: { id: list[j].id }, data: { queuePosition: list[i].queuePosition } });
      }
      await audit(tx, req.ctx, { action: 'visit.reorder', entityType: 'visit', entityId: v.id, summary: `تحريك ${v.visitNumber} (${direction})` });
    });
    res.json({ ok: true });
  }),
);

/** Doctor finishes the consultation → patient goes to payment. */
visitsRouter.post(
  '/:id/finish',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    const v = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({ where: { id: req.params.id }, include: { diagnoses: { where: { deletedAt: null } } } });
      if (!visit) throw notFound();
      if (visit.doctorId && visit.doctorId !== req.ctx.userId && !can(req.ctx, 'queue.view_all')) throw forbidden('هذه الزيارة ليست ضمن قائمتك');
      if (!visit.diagnoses.length) throw badRequest('يرجى إضافة تشخيص واحد على الأقل قبل إنهاء الزيارة');
      if (['WAITING_PAYMENT', 'COMPLETED'].includes(visit.status)) return visit;
      return changeVisitStatus(tx, req.ctx, visit.id, 'WAITING_PAYMENT', 'إنهاء الكشف', { system: true });
    });
    res.json(v);
  }),
);
