import { Router } from 'express';
import { z } from 'zod';
import { InventoryTxnType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, optionalDate, pageQuery, paged, paginate, sortBy } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { addDays, dateOnly, rangeFromQuery } from '../../lib/dates';
import { nextCounter, pad } from '../../lib/counters';
import { D } from '../../lib/money';
import { getSetting } from '../../lib/settings';
import { recordMovement } from './service';

export const inventoryRouter = Router();

const itemBody = z.object({
  name: z.string().trim().min(2, 'اسم الصنف مطلوب').max(150),
  sku: z.string().trim().toUpperCase().min(1, 'SKU مطلوب').max(40),
  barcode: nullableStr(60),
  categoryId: z.string().uuid().nullable().optional(),
  unitId: z.string().uuid().nullable().optional(),
  minQuantity: z.coerce.number().min(0).max(1_000_000).default(0),
  purchasePrice: z.coerce.number().min(0).max(1_000_000).default(0),
  salePrice: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().min(0).max(1_000_000).nullable().optional()),
  supplierId: z.string().uuid().nullable().optional(),
  expiryDate: optionalDate,
  batchNumber: nullableStr(60),
  location: nullableStr(100),
  notes: nullableStr(1000),
  isActive: z.boolean().optional(),
});

const itemInclude = {
  category: { select: { id: true, name: true } },
  unit: { select: { id: true, name: true, symbol: true } },
  supplier: { select: { id: true, name: true } },
} satisfies Prisma.InventoryItemInclude;

inventoryRouter.get(
  '/items',
  requirePerm('inventory.view'),
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({
        categoryId: z.string().uuid().optional(), supplierId: z.string().uuid().optional(),
        filter: z.enum(['all', 'low', 'out', 'expiring', 'expired', 'inactive']).default('all'),
      }),
      req.query,
    );
    const { expiryAlertDays } = await getSetting('inventory');
    const today = dateOnly();
    let idFilter: string[] | undefined;
    if (q.filter === 'low') {
      const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_items WHERE "deletedAt" IS NULL AND "isActive" AND quantity <= "minQuantity"`;
      idFilter = rows.map((r) => r.id);
    }
    const where: Prisma.InventoryItemWhereInput = {
      deletedAt: null,
      isActive: q.filter !== 'inactive',
      ...(idFilter && { id: { in: idFilter } }),
      ...(q.filter === 'out' && { quantity: { lte: 0 } }),
      ...(q.filter === 'expiring' && { expiryDate: { gte: today, lte: addDays(today, expiryAlertDays) } }),
      ...(q.filter === 'expired' && { expiryDate: { lt: today } }),
      ...(q.categoryId && { categoryId: q.categoryId }),
      ...(q.supplierId && { supplierId: q.supplierId }),
      ...(q.q && { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { sku: { contains: q.q, mode: 'insensitive' } }, { barcode: q.q }, { batchNumber: { contains: q.q, mode: 'insensitive' } }] }),
    };
    const [items, total, value] = await Promise.all([
      prisma.inventoryItem.findMany({ where, include: itemInclude, orderBy: sortBy(q.sort, ['name', 'quantity', 'expiryDate', 'sku', 'createdAt'] as const, 'name', q.sort ? q.order : 'asc'), ...paginate(q) }),
      prisma.inventoryItem.count({ where }),
      prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(quantity * "purchasePrice") AS v FROM inventory_items WHERE "deletedAt" IS NULL AND "isActive"`,
    ]);
    res.json({ ...paged(items, total, q), stockValue: D(value[0]?.v).toNumber() });
  }),
);

inventoryRouter.get(
  '/items/:id',
  requirePerm('inventory.view'),
  ah(async (req, res) => {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { ...itemInclude, transactions: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    if (!item) throw notFound('الصنف غير موجود');
    res.json(item);
  }),
);

inventoryRouter.post(
  '/items',
  requirePerm('inventory.manage'),
  ah(async (req, res) => {
    const body = parse(itemBody.extend({ openingQuantity: z.coerce.number().min(0).max(1_000_000).default(0) }), req.body);
    const { openingQuantity, ...data } = body;
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({ data: { ...data, expiryDate: data.expiryDate ? dateOnly(data.expiryDate) : data.expiryDate } });
      await audit(tx, req.ctx, { action: 'inventory_item.create', entityType: 'inventory_item', entityId: created.id, summary: created.name, after: created });
      if (openingQuantity > 0) {
        await recordMovement(tx, req.ctx, {
          itemId: created.id, type: 'RECEIPT', quantity: openingQuantity, unitCost: data.purchasePrice, reason: 'رصيد افتتاحي', batchNumber: data.batchNumber, expiryDate: created.expiryDate,
        });
      }
      return created;
    });
    res.status(201).json(item);
  }),
);

/** Item master data. Quantity is intentionally NOT editable here — only through movements. */
inventoryRouter.put(
  '/items/:id',
  requirePerm('inventory.manage'),
  ah(async (req, res) => {
    const data = parse(itemBody.partial(), req.body);
    const item = await prisma.$transaction(async (tx) => {
      const before = await tx.inventoryItem.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!before) throw notFound();
      const updated = await tx.inventoryItem.update({ where: { id: before.id }, data: { ...data, ...(data.expiryDate && { expiryDate: dateOnly(data.expiryDate) }) } });
      await audit(tx, req.ctx, { action: 'inventory_item.update', entityType: 'inventory_item', entityId: before.id, before, after: updated });
      return updated;
    });
    res.json(item);
  }),
);

inventoryRouter.delete(
  '/items/:id',
  requirePerm('inventory.manage'),
  ah(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!item) throw notFound();
      if (D(item.quantity).gt(0)) throw badRequest('لا يمكن أرشفة صنف له رصيد. قم بصرف أو تعديل الكمية أولاً');
      await tx.inventoryItem.update({ where: { id: item.id }, data: { deletedAt: new Date(), isActive: false } });
      await audit(tx, req.ctx, { action: 'inventory_item.archive', entityType: 'inventory_item', entityId: item.id, summary: item.name });
    });
    res.json({ ok: true });
  }),
);

// ── Movements ──

const MANUAL_TYPES = ['PURCHASE', 'RECEIPT', 'ISSUE', 'CONSUMPTION', 'RETURN', 'ADJUSTMENT'] as const;

inventoryRouter.post(
  '/transactions',
  requirePerm('inventory.transact'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        itemId: z.string().uuid('اختر الصنف'),
        type: z.enum(MANUAL_TYPES),
        quantity: z.coerce.number().refine((v) => v !== 0, 'الكمية مطلوبة').refine((v) => Math.abs(v) <= 1_000_000, 'الكمية كبيرة جداً'),
        unitCost: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().min(0).nullable().optional()),
        reason: z.string().trim().min(2, 'يرجى ذكر السبب').max(300),
        reference: nullableStr(100),
        batchNumber: nullableStr(60),
        expiryDate: optionalDate,
      }),
      req.body,
    );
    if (body.type !== 'ADJUSTMENT' && body.quantity < 0) throw badRequest('الكمية يجب أن تكون موجبة');
    const txn = await prisma.$transaction((tx) => recordMovement(tx, req.ctx, { ...body, expiryDate: body.expiryDate ? dateOnly(body.expiryDate) : null, referenceType: 'manual' }));
    res.status(201).json(txn);
  }),
);

inventoryRouter.get(
  '/transactions',
  requireAnyPerm('inventory.view', 'reports.inventory'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ itemId: z.string().uuid().optional(), type: z.nativeEnum(InventoryTxnType).optional(), from: z.string().optional(), to: z.string().optional() }), req.query);
    const where: Prisma.InventoryTransactionWhereInput = {
      ...(q.itemId && { itemId: q.itemId }),
      ...(q.type && { type: q.type }),
      ...(q.from && { createdAt: (({ from, to }) => ({ gte: from, lte: to }))(rangeFromQuery(q.from, q.to)) }),
      ...(q.q && { OR: [{ item: { name: { contains: q.q, mode: 'insensitive' } } }, { reference: { contains: q.q, mode: 'insensitive' } }, { reason: { contains: q.q, mode: 'insensitive' } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.inventoryTransaction.findMany({ where, ...paginate(q), orderBy: { createdAt: 'desc' }, include: { item: { select: { id: true, name: true, sku: true, unit: { select: { symbol: true, name: true } } } } } }),
      prisma.inventoryTransaction.count({ where }),
    ]);
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.userId).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } });
    const names = Object.fromEntries(users.map((u) => [u.id, u.fullName]));
    res.json(paged(items.map((i) => ({ ...i, userName: i.userId ? names[i.userId] : null })), total, q));
  }),
);

// ── Stock counts ──

inventoryRouter.get(
  '/stock-counts',
  requireAnyPerm('stockcount.manage', 'inventory.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery, req.query);
    const [items, total] = await Promise.all([
      prisma.stockCount.findMany({ ...paginate(q), orderBy: { createdAt: 'desc' }, include: { _count: { select: { items: true } } } }),
      prisma.stockCount.count(),
    ]);
    res.json(paged(items, total, q));
  }),
);

inventoryRouter.post(
  '/stock-counts',
  requirePerm('stockcount.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ title: nullableStr(120), notes: nullableStr(500), categoryId: z.string().uuid().nullable().optional(), itemIds: z.array(z.string().uuid()).max(5000).optional() }),
      req.body,
    );
    const sc = await prisma.$transaction(async (tx) => {
      const items = await tx.inventoryItem.findMany({
        where: { deletedAt: null, isActive: true, ...(body.itemIds?.length ? { id: { in: body.itemIds } } : {}), ...(body.categoryId && { categoryId: body.categoryId }) },
        select: { id: true, quantity: true },
      });
      if (!items.length) throw badRequest('لا توجد أصناف للجرد');
      const n = await nextCounter(tx, 'stock_count');
      const created = await tx.stockCount.create({
        data: {
          countNumber: `SC-${pad(n, 5)}`, title: body.title, notes: body.notes, createdById: req.ctx.userId,
          items: { create: items.map((i) => ({ itemId: i.id, systemQuantity: i.quantity })) },
        },
      });
      await audit(tx, req.ctx, { action: 'stock_count.create', entityType: 'stock_count', entityId: created.id, summary: `${created.countNumber} (${items.length} صنف)` });
      return created;
    });
    res.status(201).json(sc);
  }),
);

inventoryRouter.get(
  '/stock-counts/:id',
  requireAnyPerm('stockcount.manage', 'inventory.view'),
  ah(async (req, res) => {
    const sc = await prisma.stockCount.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { item: { select: { id: true, name: true, sku: true, location: true, quantity: true, purchasePrice: true, unit: { select: { symbol: true, name: true } } } } }, orderBy: { item: { name: 'asc' } } } },
    });
    if (!sc) throw notFound();
    res.json(sc);
  }),
);

inventoryRouter.put(
  '/stock-counts/:id/items',
  requirePerm('stockcount.manage'),
  ah(async (req, res) => {
    const body = parse(z.object({ items: z.array(z.object({ id: z.string().uuid(), countedQuantity: z.coerce.number().min(0).nullable(), notes: nullableStr(300) })).max(5000) }), req.body);
    await prisma.$transaction(async (tx) => {
      const sc = await tx.stockCount.findUnique({ where: { id: req.params.id } });
      if (!sc) throw notFound();
      if (sc.status !== 'IN_PROGRESS') throw badRequest('جلسة الجرد مغلقة');
      for (const it of body.items) {
        const row = await tx.stockCountItem.findFirst({ where: { id: it.id, stockCountId: sc.id } });
        if (!row) throw badRequest('بند غير موجود');
        await tx.stockCountItem.update({
          where: { id: row.id },
          data: { countedQuantity: it.countedQuantity, notes: it.notes, difference: it.countedQuantity == null ? null : D(it.countedQuantity).sub(row.systemQuantity) },
        });
      }
    });
    res.json({ ok: true });
  }),
);

/** Approval is the only moment the stock changes: one STOCK_COUNT movement per differing item. */
inventoryRouter.post(
  '/stock-counts/:id/approve',
  requirePerm('stockcount.approve'),
  ah(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      const sc = await tx.stockCount.findUnique({ where: { id: req.params.id }, include: { items: true } });
      if (!sc) throw notFound();
      if (sc.status !== 'IN_PROGRESS') throw badRequest('جلسة الجرد مغلقة');
      if (sc.items.some((i) => i.countedQuantity == null)) throw badRequest('أدخل الكمية الفعلية لجميع الأصناف قبل الاعتماد');
      let adjusted = 0;
      for (const i of sc.items) {
        const diff = D(i.countedQuantity).sub(i.systemQuantity);
        if (diff.eq(0)) continue;
        await recordMovement(tx, req.ctx, { itemId: i.itemId, type: 'STOCK_COUNT', quantity: diff, reason: `اعتماد جرد ${sc.countNumber}`, reference: sc.countNumber, referenceType: 'stock_count', referenceId: sc.id });
        adjusted++;
      }
      await tx.stockCount.update({ where: { id: sc.id }, data: { status: 'APPROVED', approvedById: req.ctx.userId, approvedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'stock_count.approve', entityType: 'stock_count', entityId: sc.id, summary: `اعتماد ${sc.countNumber}: تعديل ${adjusted} صنف` });
      return { adjusted };
    });
    res.json(result);
  }),
);

inventoryRouter.post(
  '/stock-counts/:id/cancel',
  requirePerm('stockcount.manage'),
  ah(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const sc = await tx.stockCount.findUnique({ where: { id: req.params.id } });
      if (!sc) throw notFound();
      if (sc.status !== 'IN_PROGRESS') throw badRequest('جلسة الجرد مغلقة');
      await tx.stockCount.update({ where: { id: sc.id }, data: { status: 'CANCELLED' } });
      await audit(tx, req.ctx, { action: 'stock_count.cancel', entityType: 'stock_count', entityId: sc.id, summary: sc.countNumber });
    });
    res.json({ ok: true });
  }),
);
