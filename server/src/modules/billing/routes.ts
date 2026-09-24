import { Router } from 'express';
import { z } from 'zod';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, optionalDate, pageQuery, paged, paginate, sortBy } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { ageFrom, rangeFromQuery } from '../../lib/dates';
import { addPayment, buildInvoice, cancelInvoice, issueInvoice, recomputeInvoice } from './service';

export const billingRouter = Router();

const itemSchema = z.object({
  serviceId: z.string().uuid(),
  quantity: z.coerce.number().positive('الكمية يجب أن تكون أكبر من صفر').max(10000),
  unitPrice: z.coerce.number().min(0).max(1_000_000).nullable().optional(),
  discount: z.coerce.number().min(0).max(1_000_000).nullable().optional(),
});
const invoiceBody = z.object({
  patientId: z.string().uuid('اختر المريض'),
  visitId: z.string().uuid().nullable().optional(),
  doctorId: z.string().uuid().nullable().optional(),
  templateId: z.string().uuid().nullable().optional(),
  items: z.array(itemSchema).max(100),
  invoiceDiscount: z.coerce.number().min(0).default(0),
  notes: nullableStr(1000),
  issue: z.boolean().default(true),
  payment: z
    .object({ amount: z.coerce.number().positive(), methodId: z.string().uuid(), reference: nullableStr(100), notes: nullableStr(300) })
    .nullable()
    .optional(),
});
const paymentBody = z.object({
  amount: z.coerce.number().positive('المبلغ يجب أن يكون أكبر من صفر').max(1_000_000),
  methodId: z.string().uuid('اختر طريقة الدفع'),
  reference: nullableStr(100),
  notes: nullableStr(300),
  paidAt: optionalDate,
});

const detailInclude = {
  patient: { select: { id: true, fullName: true, fileNumber: true, phone: true, gender: true, dateOfBirth: true, address: true } },
  doctor: { select: { id: true, fullName: true, specialty: true } },
  visit: { select: { id: true, visitNumber: true, arrivedAt: true, status: true } },
  template: { select: { id: true, name: true } },
  items: { orderBy: { sortOrder: 'asc' } },
  payments: { orderBy: { paidAt: 'asc' }, include: { method: { select: { id: true, name: true, code: true } } } },
} satisfies Prisma.InvoiceInclude;

async function loadInvoice(id: string) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: detailInclude });
  if (!inv) throw notFound('الفاتورة غير موجودة');
  const userIds = [inv.createdById, inv.cancelledById, ...inv.payments.flatMap((p) => [p.receivedById, p.voidedById])].filter(Boolean) as string[];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
  return { ...inv, patient: { ...inv.patient, age: ageFrom(inv.patient.dateOfBirth) }, userNames: Object.fromEntries(users.map((u) => [u.id, u.fullName])) };
}

// ── Invoices ──

billingRouter.get(
  '/invoices',
  requirePerm('invoices.view'),
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({
        status: z.nativeEnum(InvoiceStatus).optional(), patientId: z.string().uuid().optional(), doctorId: z.string().uuid().optional(),
        visitId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional(),
      }),
      req.query,
    );
    const where: Prisma.InvoiceWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.patientId && { patientId: q.patientId }),
      ...(q.doctorId && { doctorId: q.doctorId }),
      ...(q.visitId && { visitId: q.visitId }),
      ...(q.from && { createdAt: (({ from, to }) => ({ gte: from, lte: to }))(rangeFromQuery(q.from, q.to)) }),
      ...(q.q && { OR: [{ invoiceNumber: { contains: q.q, mode: 'insensitive' } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { patient: { phone: { contains: q.q } } }, { patient: { fileNumber: q.q } }] }),
    };
    const [items, total, sums] = await Promise.all([
      prisma.invoice.findMany({
        where, ...paginate(q),
        orderBy: sortBy(q.sort, ['createdAt', 'issuedAt', 'total', 'balance', 'invoiceNumber'] as const, 'createdAt', q.order),
        include: { patient: { select: { id: true, fullName: true, phone: true, fileNumber: true } }, doctor: { select: { fullName: true } }, template: { select: { name: true } } },
      }),
      prisma.invoice.count({ where }),
      prisma.invoice.aggregate({ where: { ...where, status: where.status ?? { notIn: ['CANCELLED', 'DRAFT'] } }, _sum: { total: true, paidAmount: true, balance: true } }),
    ]);
    res.json({ ...paged(items, total, q), sums: sums._sum });
  }),
);

/** Outstanding (unpaid / partially paid / overdue) invoices with debt age and last payment. */
billingRouter.get(
  '/invoices/outstanding',
  requirePerm('invoices.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ doctorId: z.string().uuid().optional(), minAgeDays: z.coerce.number().int().min(0).optional() }), req.query);
    const where: Prisma.InvoiceWhereInput = {
      status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
      balance: { gt: 0 },
      ...(q.doctorId && { doctorId: q.doctorId }),
      ...(q.minAgeDays && { issuedAt: { lte: new Date(Date.now() - q.minAgeDays * 86_400_000) } }),
      ...(q.q && { OR: [{ invoiceNumber: { contains: q.q, mode: 'insensitive' } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { patient: { phone: { contains: q.q } } }] }),
    };
    const [items, total, sums] = await Promise.all([
      prisma.invoice.findMany({
        where, ...paginate(q),
        orderBy: sortBy(q.sort, ['issuedAt', 'balance', 'total'] as const, 'issuedAt', q.sort ? q.order : 'asc'),
        include: {
          patient: { select: { id: true, fullName: true, phone: true, fileNumber: true } },
          doctor: { select: { fullName: true } },
          payments: { where: { voidedAt: null, type: 'PAYMENT' }, orderBy: { paidAt: 'desc' }, take: 1, select: { paidAt: true, amount: true } },
        },
      }),
      prisma.invoice.count({ where }),
      prisma.invoice.aggregate({ where, _sum: { total: true, paidAmount: true, balance: true } }),
    ]);
    const now = Date.now();
    res.json({
      ...paged(items.map((i) => ({ ...i, ageDays: i.issuedAt ? Math.floor((now - i.issuedAt.getTime()) / 86_400_000) : 0, lastPayment: i.payments[0] ?? null, payments: undefined })), total, q),
      sums: sums._sum,
    });
  }),
);

/** Suggested lines for a visit: template mandatory items + ordered lab tests (not yet billed). */
billingRouter.get(
  '/invoices/suggest',
  requirePerm('invoices.create'),
  ah(async (req, res) => {
    const q = parse(z.object({ visitId: z.string().uuid(), templateId: z.string().uuid().optional() }), req.query);
    const visit = await prisma.visit.findUnique({
      where: { id: q.visitId },
      include: { labOrders: { where: { status: { not: 'CANCELLED' } }, include: { items: { include: { labTest: { include: { service: true } } } } } } },
    });
    if (!visit) throw notFound();
    const billed = await prisma.invoiceItem.findMany({ where: { invoice: { visitId: visit.id, status: { not: 'CANCELLED' } } }, select: { serviceId: true } });
    const billedIds = new Set(billed.map((b) => b.serviceId));
    const labServices = visit.labOrders.flatMap((o) => o.items.map((i) => i.labTest.service).filter(Boolean)) as { id: string }[];
    const serviceIds = [...new Set(labServices.map((s) => s.id))].filter((id) => !billedIds.has(id));
    res.json({ patientId: visit.patientId, doctorId: visit.doctorId, alreadyInvoiced: billed.length > 0, items: serviceIds.map((serviceId) => ({ serviceId, quantity: 1 })) });
  }),
);

billingRouter.get(
  '/invoices/:id',
  requirePerm('invoices.view'),
  ah(async (req, res) => res.json(await loadInvoice(req.params.id))),
);

billingRouter.post(
  '/invoices',
  requirePerm('invoices.create'),
  ah(async (req, res) => {
    const body = parse(invoiceBody, req.body);
    if (body.payment && !body.issue) throw badRequest('لا يمكن الدفع على مسودة');
    if (body.payment && !req.ctx.perms.has('payments.create')) throw badRequest('لا تملك صلاحية تسجيل الدفع');
    const id = await prisma.$transaction(async (tx) => {
      const built = await buildInvoice(tx, req.ctx, body);
      const inv = await tx.invoice.create({
        data: { ...built.header, branchId: req.ctx.branchId, createdById: req.ctx.userId, items: { create: built.items } },
      });
      await audit(tx, req.ctx, { action: 'invoice.create', entityType: 'invoice', entityId: inv.id, summary: `فاتورة جديدة بقيمة ${inv.total}`, after: { ...built.header, items: built.items.map((i) => ({ d: i.description, q: i.quantity, p: i.unitPrice, t: i.lineTotal })) } });
      if (body.issue) await issueInvoice(tx, req.ctx, inv.id);
      if (body.payment) await addPayment(tx, req.ctx, inv.id, body.payment);
      return inv.id;
    });
    res.status(201).json(await loadInvoice(id));
  }),
);

billingRouter.put(
  '/invoices/:id',
  requirePerm('invoices.update'),
  ah(async (req, res) => {
    const body = parse(invoiceBody.omit({ payment: true }), req.body);
    await prisma.$transaction(async (tx) => {
      const before = await tx.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
      if (!before) throw notFound();
      if (before.status !== 'DRAFT') throw badRequest('لا يمكن تعديل فاتورة صادرة. يمكنك إلغاؤها وإصدار فاتورة جديدة');
      const built = await buildInvoice(tx, req.ctx, body);
      await tx.invoiceItem.deleteMany({ where: { invoiceId: before.id } });
      await tx.invoice.update({ where: { id: before.id }, data: { ...built.header, items: { create: built.items } } });
      await audit(tx, req.ctx, {
        action: 'invoice.update', entityType: 'invoice', entityId: before.id, summary: 'تعديل مسودة فاتورة',
        before: { total: before.total, items: before.items.map((i) => ({ d: i.description, q: i.quantity, p: i.unitPrice })) },
        after: { total: built.header.total, items: built.items.map((i) => ({ d: i.description, q: i.quantity, p: i.unitPrice })) },
      });
      if (body.issue) await issueInvoice(tx, req.ctx, before.id);
    });
    res.json(await loadInvoice(req.params.id));
  }),
);

billingRouter.post(
  '/invoices/:id/issue',
  requirePerm('invoices.create'),
  ah(async (req, res) => {
    await prisma.$transaction((tx) => issueInvoice(tx, req.ctx, req.params.id));
    res.json(await loadInvoice(req.params.id));
  }),
);

billingRouter.post(
  '/invoices/:id/cancel',
  requirePerm('invoices.cancel'),
  ah(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'يرجى ذكر سبب الإلغاء').max(300) }), req.body);
    await prisma.$transaction((tx) => cancelInvoice(tx, req.ctx, req.params.id, reason));
    res.json(await loadInvoice(req.params.id));
  }),
);

// ── Payments ──

billingRouter.post(
  '/invoices/:id/payments',
  requirePerm('payments.create'),
  ah(async (req, res) => {
    const body = parse(paymentBody, req.body);
    const result = await prisma.$transaction((tx) => addPayment(tx, req.ctx, req.params.id, { ...body, paidAt: body.paidAt ?? undefined }));
    res.status(201).json(result);
  }),
);

billingRouter.post(
  '/invoices/:id/refunds',
  requirePerm('payments.refund'),
  ah(async (req, res) => {
    const body = parse(paymentBody.extend({ notes: z.string().trim().min(3, 'يرجى ذكر سبب الإرجاع').max(300) }), req.body);
    const result = await prisma.$transaction((tx) => addPayment(tx, req.ctx, req.params.id, { ...body, paidAt: body.paidAt ?? undefined }, 'REFUND'));
    res.status(201).json(result);
  }),
);

billingRouter.post(
  '/payments/:id/void',
  requirePerm('payments.void'),
  ah(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'يرجى ذكر السبب').max(300) }), req.body);
    const inv = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.findUnique({ where: { id: req.params.id } });
      if (!p) throw notFound();
      if (p.voidedAt) throw badRequest('الدفعة ملغاة مسبقاً');
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${p.invoiceId} FOR UPDATE`;
      await tx.payment.update({ where: { id: p.id }, data: { voidedAt: new Date(), voidedById: req.ctx.userId, voidReason: reason } });
      const updated = await recomputeInvoice(tx, p.invoiceId);
      await audit(tx, req.ctx, { action: 'payment.void', entityType: 'invoice', entityId: p.invoiceId, summary: `إلغاء الإيصال ${p.receiptNumber} (${p.amount}): ${reason}`, before: { status: 'active' }, after: { status: 'voided', invoiceStatus: updated.status } });
      return updated;
    });
    res.json(inv);
  }),
);

billingRouter.get(
  '/payments',
  requireAnyPerm('cashier.view', 'payments.create'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ from: z.string().optional(), to: z.string().optional(), methodId: z.string().uuid().optional(), type: z.enum(['PAYMENT', 'REFUND']).optional(), mine: z.enum(['true', 'false']).optional() }), req.query);
    const { from, to } = rangeFromQuery(q.from, q.to);
    const where: Prisma.PaymentWhereInput = {
      paidAt: { gte: from, lte: to },
      ...(q.methodId && { methodId: q.methodId }),
      ...(q.type && { type: q.type }),
      ...((q.mine === 'true' || !req.ctx.perms.has('cashier.view')) && { receivedById: req.ctx.userId }),
      ...(q.q && { OR: [{ receiptNumber: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { invoice: { invoiceNumber: { contains: q.q, mode: 'insensitive' } } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where, ...paginate(q), orderBy: { paidAt: 'desc' },
        include: { method: { select: { name: true } }, patient: { select: { id: true, fullName: true } }, invoice: { select: { id: true, invoiceNumber: true } } },
      }),
      prisma.payment.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);

/** Receipt print payload. */
billingRouter.get(
  '/payments/:id',
  requireAnyPerm('invoices.view', 'payments.create'),
  ah(async (req, res) => {
    const p = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: {
        method: true,
        patient: { select: { fullName: true, fileNumber: true, phone: true } },
        invoice: { select: { id: true, invoiceNumber: true, total: true, paidAmount: true, balance: true, status: true } },
      },
    });
    if (!p) throw notFound();
    const receiver = p.receivedById ? await prisma.user.findUnique({ where: { id: p.receivedById }, select: { fullName: true } }) : null;
    res.json({ ...p, receivedBy: receiver?.fullName ?? null });
  }),
);
