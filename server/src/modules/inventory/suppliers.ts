import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, optionalDate, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { nextCounter, pad } from '../../lib/counters';
import { D, num, r3 } from '../../lib/money';
import { dateOnly } from '../../lib/dates';
import { recordMovement } from './service';

export const suppliersRouter = Router();

const supplierBody = z.object({
  name: z.string().trim().min(2, 'اسم المورد مطلوب').max(150),
  phone: nullableStr(30),
  email: z.preprocess((v) => (v === '' ? null : v), z.string().email('بريد غير صالح').nullable().optional()),
  address: nullableStr(300),
  taxNumber: nullableStr(40),
  contactPerson: nullableStr(100),
  notes: nullableStr(1000),
  isActive: z.boolean().optional(),
});

/** Supplier balance = received purchase orders − non-voided supplier payments. */
async function balances(ids: string[]) {
  if (!ids.length) return new Map<string, { purchases: number; paid: number; balance: number }>();
  const [po, pay] = await Promise.all([
    prisma.purchaseOrder.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids }, status: 'RECEIVED' }, _sum: { total: true } }),
    prisma.supplierPayment.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids }, voidedAt: null }, _sum: { amount: true } }),
  ]);
  return new Map(
    ids.map((id) => {
      const purchases = num(po.find((p) => p.supplierId === id)?._sum.total);
      const paid = num(pay.find((p) => p.supplierId === id)?._sum.amount);
      return [id, { purchases, paid, balance: D(purchases).sub(paid).toNumber() }];
    }),
  );
}

suppliersRouter.get(
  '/',
  requirePerm('suppliers.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ all: z.enum(['true', 'false']).optional() }), req.query);
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(q.all !== 'true' && { isActive: true }),
      ...(q.q && { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }, { email: { contains: q.q, mode: 'insensitive' } }] }),
    };
    const [items, total] = await Promise.all([prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, ...paginate(q) }), prisma.supplier.count({ where })]);
    const b = await balances(items.map((i) => i.id));
    res.json(paged(items.map((i) => ({ ...i, ...b.get(i.id) })), total, q));
  }),
);

suppliersRouter.get(
  '/:id',
  requirePerm('suppliers.view'),
  ah(async (req, res) => {
    const s = await prisma.supplier.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        purchaseOrders: { orderBy: { orderDate: 'desc' }, take: 100, include: { _count: { select: { items: true } } } },
        payments: { orderBy: { paidAt: 'desc' }, take: 100, include: { method: { select: { name: true } }, purchaseOrder: { select: { poNumber: true } } } },
      },
    });
    if (!s) throw notFound();
    res.json({ ...s, ...(await balances([s.id])).get(s.id) });
  }),
);

suppliersRouter.post(
  '/',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    const data = parse(supplierBody, req.body);
    const s = await prisma.$transaction(async (tx) => {
      const row = await tx.supplier.create({ data });
      await audit(tx, req.ctx, { action: 'supplier.create', entityType: 'supplier', entityId: row.id, summary: row.name, after: row });
      return row;
    });
    res.status(201).json(s);
  }),
);

suppliersRouter.put(
  '/:id',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    const data = parse(supplierBody.partial(), req.body);
    const s = await prisma.$transaction(async (tx) => {
      const before = await tx.supplier.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!before) throw notFound();
      const row = await tx.supplier.update({ where: { id: before.id }, data });
      await audit(tx, req.ctx, { action: 'supplier.update', entityType: 'supplier', entityId: row.id, before, after: row });
      return row;
    });
    res.json(s);
  }),
);

// ── Purchase orders ──

const poBody = z.object({
  supplierId: z.string().uuid('اختر المورد'),
  orderDate: optionalDate,
  notes: nullableStr(1000),
  items: z
    .array(z.object({ itemId: z.string().uuid(), quantity: z.coerce.number().positive(), unitCost: z.coerce.number().min(0), batchNumber: nullableStr(60), expiryDate: optionalDate }))
    .min(1, 'أضف صنفاً واحداً على الأقل')
    .max(300),
});

const poItems = (items: z.infer<typeof poBody>['items']) =>
  items.map((i) => ({ ...i, expiryDate: i.expiryDate ? dateOnly(i.expiryDate) : null, lineTotal: r3(D(i.quantity).mul(i.unitCost)) }));

export const purchasesRouter = Router();

purchasesRouter.get(
  '/',
  requirePerm('suppliers.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ supplierId: z.string().uuid().optional(), status: z.enum(['DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED']).optional() }), req.query);
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(q.supplierId && { supplierId: q.supplierId }),
      ...(q.status && { status: q.status }),
      ...(q.q && { OR: [{ poNumber: { contains: q.q, mode: 'insensitive' } }, { supplier: { name: { contains: q.q, mode: 'insensitive' } } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.purchaseOrder.findMany({ where, ...paginate(q), orderBy: { orderDate: 'desc' }, include: { supplier: { select: { id: true, name: true } }, _count: { select: { items: true } } } }),
      prisma.purchaseOrder.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);

purchasesRouter.get(
  '/:id',
  requirePerm('suppliers.view'),
  ah(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { supplier: true, items: { include: { item: { select: { id: true, name: true, sku: true, unit: { select: { symbol: true } } } } } }, payments: { where: { voidedAt: null }, include: { method: { select: { name: true } } } } },
    });
    if (!po) throw notFound();
    res.json(po);
  }),
);

purchasesRouter.post(
  '/',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    const body = parse(poBody, req.body);
    const po = await prisma.$transaction(async (tx) => {
      const items = poItems(body.items);
      const n = await nextCounter(tx, 'purchase_order');
      const row = await tx.purchaseOrder.create({
        data: {
          poNumber: `PO-${pad(n, 5)}`, supplierId: body.supplierId, orderDate: body.orderDate ?? new Date(), notes: body.notes, createdById: req.ctx.userId,
          total: items.reduce((a, i) => a.add(i.lineTotal), D(0)), items: { create: items },
        },
      });
      await audit(tx, req.ctx, { action: 'purchase_order.create', entityType: 'purchase_order', entityId: row.id, summary: `${row.poNumber}: ${row.total}` });
      return row;
    });
    res.status(201).json(po);
  }),
);

purchasesRouter.put(
  '/:id',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    const body = parse(poBody, req.body);
    const po = await prisma.$transaction(async (tx) => {
      const before = await tx.purchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound();
      if (!['DRAFT', 'ORDERED'].includes(before.status)) throw badRequest('لا يمكن تعديل أمر شراء مستلم أو ملغى');
      const items = poItems(body.items);
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: before.id } });
      const row = await tx.purchaseOrder.update({
        where: { id: before.id },
        data: { supplierId: body.supplierId, orderDate: body.orderDate ?? before.orderDate, notes: body.notes, total: items.reduce((a, i) => a.add(i.lineTotal), D(0)), items: { create: items } },
      });
      await audit(tx, req.ctx, { action: 'purchase_order.update', entityType: 'purchase_order', entityId: row.id, before: { total: before.total }, after: { total: row.total } });
      return row;
    });
    res.json(po);
  }),
);

purchasesRouter.post(
  '/:id/status',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['ORDERED', 'RECEIVED', 'CANCELLED']) }), req.body);
    const po = await prisma.$transaction(async (tx) => {
      const before = await tx.purchaseOrder.findUnique({ where: { id: req.params.id }, include: { items: true } });
      if (!before) throw notFound();
      if (['RECEIVED', 'CANCELLED'].includes(before.status)) throw badRequest('أمر الشراء مغلق');
      if (status === 'ORDERED' && before.status !== 'DRAFT') throw badRequest('أمر الشراء مرسل مسبقاً');
      // Receiving is what puts stock on the shelf — one PURCHASE movement per line.
      if (status === 'RECEIVED') {
        for (const it of before.items) {
          await recordMovement(tx, req.ctx, {
            itemId: it.itemId, type: 'PURCHASE', quantity: it.quantity, unitCost: it.unitCost, reason: 'استلام أمر شراء',
            reference: before.poNumber, referenceType: 'purchase_order', referenceId: before.id, batchNumber: it.batchNumber, expiryDate: it.expiryDate,
          });
        }
      }
      const row = await tx.purchaseOrder.update({ where: { id: before.id }, data: { status, ...(status === 'RECEIVED' && { receivedAt: new Date() }) } });
      await audit(tx, req.ctx, { action: 'purchase_order.status', entityType: 'purchase_order', entityId: row.id, summary: `${row.poNumber}: ${before.status} → ${status}` });
      return row;
    });
    res.json(po);
  }),
);

// ── Supplier payments ──

suppliersRouter.post(
  '/:id/payments',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ amount: z.coerce.number().positive(), methodId: z.string().uuid('اختر طريقة الدفع'), purchaseOrderId: z.string().uuid().nullable().optional(), reference: nullableStr(100), notes: nullableStr(300), paidAt: optionalDate }),
      req.body,
    );
    const p = await prisma.$transaction(async (tx) => {
      const s = await tx.supplier.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!s) throw notFound();
      if (body.purchaseOrderId) {
        const po = await tx.purchaseOrder.findUnique({ where: { id: body.purchaseOrderId } });
        if (!po || po.supplierId !== s.id) throw badRequest('أمر الشراء لا يخص هذا المورد');
      }
      const row = await tx.supplierPayment.create({ data: { ...body, paidAt: body.paidAt ?? new Date(), supplierId: s.id, createdById: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'supplier_payment.create', entityType: 'supplier', entityId: s.id, summary: `دفعة ${body.amount} للمورد ${s.name}`, after: row });
      return row;
    });
    res.status(201).json(p);
  }),
);

suppliersRouter.post(
  '/payments/:paymentId/void',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const p = await tx.supplierPayment.findUnique({ where: { id: req.params.paymentId } });
      if (!p || p.voidedAt) throw notFound();
      await tx.supplierPayment.update({ where: { id: p.id }, data: { voidedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'supplier_payment.void', entityType: 'supplier', entityId: p.supplierId, summary: `إلغاء دفعة ${p.amount}` });
    });
    res.json({ ok: true });
  }),
);
