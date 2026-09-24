import { Router } from 'express';
import { z } from 'zod';
import { LabOrderStatus, Priority, Prisma, ResultFlag } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { nextCounter, pad } from '../../lib/counters';
import { notifyPermission, notifyUsers } from '../../lib/notify';
import { ageFrom, rangeFromQuery } from '../../lib/dates';
import { can } from '../../auth/context';

export const labRouter = Router();

const orderInclude = {
  patient: { select: { id: true, fullName: true, fileNumber: true, phone: true, gender: true, dateOfBirth: true } },
  doctor: { select: { id: true, fullName: true } },
  visit: { select: { id: true, visitNumber: true } },
  items: { include: { results: { orderBy: { enteredAt: 'asc' } }, labTest: { select: { code: true, unit: true, referenceRange: true, parameters: true, sampleType: true, category: true } } } },
} satisfies Prisma.LabOrderInclude;

labRouter.post(
  '/orders',
  requirePerm('lab.order'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        visitId: z.string().uuid().nullable().optional(),
        patientId: z.string().uuid(),
        testIds: z.array(z.string().uuid()).min(1, 'اختر تحليلاً واحداً على الأقل').max(50),
        priority: z.nativeEnum(Priority).default('NORMAL'),
        clinicalNotes: nullableStr(1000),
      }),
      req.body,
    );
    const order = await prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: body.patientId, deletedAt: null } });
      if (!patient) throw notFound('المريض غير موجود');
      if (body.visitId) {
        const v = await tx.visit.findUnique({ where: { id: body.visitId } });
        if (!v || v.patientId !== patient.id) throw badRequest('الزيارة لا تخص هذا المريض');
      }
      const tests = await tx.labTest.findMany({ where: { id: { in: body.testIds }, isActive: true } });
      if (tests.length !== new Set(body.testIds).size) throw badRequest('بعض التحاليل غير متاحة');
      const n = await nextCounter(tx, 'lab_order');
      const created = await tx.labOrder.create({
        data: {
          orderNumber: `LAB-${pad(n, 6)}`,
          visitId: body.visitId ?? null,
          patientId: patient.id,
          doctorId: req.ctx.userId,
          priority: body.priority,
          clinicalNotes: body.clinicalNotes,
          items: { create: tests.map((t) => ({ labTestId: t.id, testName: t.name })) },
        },
        include: orderInclude,
      });
      await audit(tx, req.ctx, { action: 'lab_order.create', entityType: 'lab_order', entityId: created.id, summary: `${created.orderNumber}: ${tests.map((t) => t.name).join('، ')}` });
      await notifyPermission('lab.process', {
        type: 'LAB_REQUESTED', title: `طلب تحليل جديد ${created.orderNumber}`,
        body: `${patient.fullName} — ${tests.map((t) => t.name).join('، ')}`, link: `/lab/${created.id}`,
      }, tx, req.ctx.userId);
      return created;
    });
    res.status(201).json(order);
  }),
);

labRouter.get(
  '/orders',
  requirePerm('lab.view'),
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({ status: z.union([z.nativeEnum(LabOrderStatus), z.literal('PENDING')]).optional(), patientId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional(), mine: z.enum(['true', 'false']).optional() }),
      req.query,
    );
    const where: Prisma.LabOrderWhereInput = {
      ...(q.status === 'PENDING' ? { status: { in: ['REQUESTED', 'SAMPLE_COLLECTED', 'PROCESSING'] } } : q.status ? { status: q.status } : {}),
      ...(q.patientId && { patientId: q.patientId }),
      ...(q.mine === 'true' && { doctorId: req.ctx.userId }),
      ...(q.from && { requestedAt: (({ from, to }) => ({ gte: from, lte: to }))(rangeFromQuery(q.from, q.to)) }),
      ...(q.q && { OR: [{ orderNumber: { contains: q.q, mode: 'insensitive' } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { patient: { phone: { contains: q.q } } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.labOrder.findMany({
        where, ...paginate(q),
        orderBy: [{ requestedAt: 'desc' }],
        include: { patient: { select: { id: true, fullName: true, fileNumber: true, phone: true } }, doctor: { select: { fullName: true } }, items: { select: { id: true, testName: true, _count: { select: { results: true } } } } },
      }),
      prisma.labOrder.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);

labRouter.get(
  '/orders/:id',
  requirePerm('lab.view'),
  ah(async (req, res) => {
    const o = await prisma.labOrder.findUnique({ where: { id: req.params.id }, include: { ...orderInclude, attachments: { where: { deletedAt: null } } } });
    if (!o) throw notFound();
    res.json({ ...o, patient: { ...o.patient, age: ageFrom(o.patient.dateOfBirth) } });
  }),
);

const NEXT: Record<LabOrderStatus, LabOrderStatus[]> = {
  REQUESTED: ['SAMPLE_COLLECTED', 'PROCESSING', 'CANCELLED'],
  SAMPLE_COLLECTED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

labRouter.post(
  '/orders/:id/status',
  requirePerm('lab.view'),
  ah(async (req, res) => {
    const body = parse(z.object({ status: z.enum(['SAMPLE_COLLECTED', 'PROCESSING', 'CANCELLED']), reason: nullableStr(300) }), req.body);
    const updated = await prisma.$transaction(async (tx) => {
      const o = await tx.labOrder.findUnique({ where: { id: req.params.id } });
      if (!o) throw notFound();
      const canCancelOwn = body.status === 'CANCELLED' && o.doctorId === req.ctx.userId && can(req.ctx, 'lab.order');
      if (!can(req.ctx, 'lab.process') && !canCancelOwn) throw forbidden();
      if (!NEXT[o.status].includes(body.status)) throw badRequest('لا يمكن تغيير حالة الطلب إلى هذه الحالة');
      if (body.status === 'CANCELLED' && !body.reason) throw badRequest('يرجى ذكر سبب الإلغاء');
      const u = await tx.labOrder.update({
        where: { id: o.id },
        data: {
          status: body.status,
          ...(body.status === 'SAMPLE_COLLECTED' && { collectedAt: new Date() }),
          ...(body.status === 'PROCESSING' && !o.collectedAt && { collectedAt: new Date() }),
          ...(body.status === 'CANCELLED' && { cancelledAt: new Date(), cancelReason: body.reason }),
        },
      });
      await audit(tx, req.ctx, { action: 'lab_order.status', entityType: 'lab_order', entityId: o.id, summary: `${o.orderNumber}: ${o.status} → ${body.status}`, before: { status: o.status }, after: { status: body.status, reason: body.reason } });
      return u;
    });
    res.json(updated);
  }),
);

/** Enter/replace results. `complete: true` finalises the order and notifies the requesting doctor. */
labRouter.put(
  '/orders/:id/results',
  requirePerm('lab.process'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        complete: z.boolean().default(false),
        items: z.array(
          z.object({
            itemId: z.string().uuid(),
            notes: nullableStr(500),
            results: z.array(
              z.object({
                parameterName: z.string().trim().min(1).max(80), value: z.string().trim().min(1, 'أدخل النتيجة').max(200),
                unit: nullableStr(30), referenceRange: nullableStr(120), flag: z.nativeEnum(ResultFlag).nullable().optional(), notes: nullableStr(500),
              }),
            ).max(60),
          }),
        ).min(1),
      }),
      req.body,
    );
    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.labOrder.findUnique({ where: { id: req.params.id }, include: { items: { include: { results: true } }, patient: { select: { fullName: true } } } });
      if (!o) throw notFound();
      if (o.status === 'CANCELLED') throw badRequest('الطلب ملغى');
      const itemIds = new Set(o.items.map((i) => i.id));
      for (const it of body.items) if (!itemIds.has(it.itemId)) throw badRequest('بند غير موجود في الطلب');
      for (const it of body.items) {
        await tx.labResult.deleteMany({ where: { labOrderItemId: it.itemId } });
        if (it.results.length) await tx.labResult.createMany({ data: it.results.map((r) => ({ ...r, labOrderItemId: it.itemId, enteredById: req.ctx.userId })) });
        await tx.labOrderItem.update({ where: { id: it.itemId }, data: { notes: it.notes } });
      }
      if (body.complete) {
        const counts = await tx.labResult.groupBy({ by: ['labOrderItemId'], where: { labOrderItemId: { in: [...itemIds] } }, _count: true });
        if (counts.length < itemIds.size) throw badRequest('أدخل نتائج جميع التحاليل قبل الاعتماد');
      }
      const wasCompleted = o.status === 'COMPLETED';
      const status: LabOrderStatus = body.complete || wasCompleted ? 'COMPLETED' : 'PROCESSING';
      await tx.labOrder.update({
        where: { id: o.id },
        data: { status, ...(status === 'COMPLETED' && !o.completedAt && { completedAt: new Date() }), ...(!o.collectedAt && { collectedAt: new Date() }) },
      });
      await audit(tx, req.ctx, {
        action: wasCompleted ? 'lab_result.amend' : 'lab_result.enter', entityType: 'lab_order', entityId: o.id, summary: `نتائج ${o.orderNumber}`,
        before: { results: o.items.flatMap((i) => i.results.map((r) => ({ item: i.testName, p: r.parameterName, v: r.value }))) },
        after: { results: body.items.flatMap((i) => i.results.map((r) => ({ item: o.items.find((x) => x.id === i.itemId)?.testName, p: r.parameterName, v: r.value }))) },
      });
      if (status === 'COMPLETED') {
        await notifyUsers([o.doctorId], {
          type: 'LAB_RESULT_READY', title: `${wasCompleted ? 'تعديل' : 'نتيجة'} تحليل جاهزة ${o.orderNumber}`, body: o.patient.fullName, link: `/lab/${o.id}`,
          dedupeKey: wasCompleted ? undefined : `lab-ready:${o.id}`,
        }, tx);
      }
      return tx.labOrder.findUniqueOrThrow({ where: { id: o.id }, include: orderInclude });
    });
    res.json(order);
  }),
);
