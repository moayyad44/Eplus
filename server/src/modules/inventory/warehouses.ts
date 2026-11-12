import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { rangeFromQuery } from '../../lib/dates';
import { nextCounter, pad } from '../../lib/counters';
import { D } from '../../lib/money';
import { getSetting } from '../../lib/settings';
import { recordMovement, resolveWarehouse } from './service';
import { ensureActiveItems } from './routes';

/** Warehouses and transfers of goods between them. Mounted under /inventory. */
export const warehousesRouter = Router();

const whBody = z.object({
  name: z.string().trim().min(2, 'اسم المستودع مطلوب').max(100),
  code: z.string().trim().toUpperCase().min(1, 'الرمز مطلوب').max(20).regex(/^[A-Z0-9_-]+$/, 'الرمز: أحرف إنجليزية وأرقام فقط'),
  location: nullableStr(200),
  notes: nullableStr(500),
});

/** Every warehouse with how many items it holds and their value. */
warehousesRouter.get(
  '/warehouses',
  requireAnyPerm('inventory.view', 'inventory.transfer', 'suppliers.manage', 'stockcount.manage'),
  ah(async (_req, res) => {
    const [rows, sums, cfg] = await Promise.all([
      prisma.warehouse.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
      prisma.$queryRaw<{ warehouseId: string; items: bigint; value: Prisma.Decimal | null }[]>`
        SELECT s."warehouseId", COUNT(*) FILTER (WHERE s.quantity > 0) AS items, SUM(s.quantity * i."purchasePrice") AS value
        FROM warehouse_stock s JOIN inventory_items i ON i.id = s."itemId" WHERE i."deletedAt" IS NULL GROUP BY s."warehouseId"`,
      getSetting('inventory'),
    ]);
    res.json(rows.map((w) => {
      const s = sums.find((x) => x.warehouseId === w.id);
      return { ...w, items: Number(s?.items ?? 0), value: D(s?.value).toNumber(), isSaleWarehouse: cfg.saleWarehouseId ? cfg.saleWarehouseId === w.id : w.isDefault };
    }));
  }),
);

warehousesRouter.post(
  '/warehouses',
  requirePerm('inventory.manage'),
  ah(async (req, res) => {
    const data = parse(whBody, req.body);
    const w = await prisma.$transaction(async (tx) => {
      if (await tx.warehouse.findUnique({ where: { code: data.code } })) throw badRequest('الرمز مستخدم لمستودع آخر');
      const created = await tx.warehouse.create({ data });
      await audit(tx, req.ctx, { action: 'warehouse.create', entityType: 'warehouse', entityId: created.id, summary: created.name, after: created });
      return created;
    });
    res.status(201).json(w);
  }),
);

warehousesRouter.put(
  '/warehouses/:id',
  requirePerm('inventory.manage'),
  ah(async (req, res) => {
    const data = parse(whBody.partial().extend({ isActive: z.boolean().optional(), isDefault: z.literal(true).optional() }), req.body);
    const w = await prisma.$transaction(async (tx) => {
      const before = await tx.warehouse.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound('المستودع غير موجود');
      if (data.code && data.code !== before.code && (await tx.warehouse.findUnique({ where: { code: data.code } }))) throw badRequest('الرمز مستخدم لمستودع آخر');
      if (data.isActive === false) {
        if (before.isDefault) throw badRequest('لا يمكن إيقاف المستودع الافتراضي. اجعل مستودعاً آخر افتراضياً أولاً');
        const left = await tx.warehouseStock.count({ where: { warehouseId: before.id, quantity: { gt: 0 } } });
        if (left) throw badRequest(`لا يمكن إيقاف مستودع فيه بضاعة (${left} صنف). انقلها لمستودع آخر أولاً`);
        const { saleWarehouseId } = await getSetting('inventory', tx);
        if (saleWarehouseId === before.id) throw badRequest('هذا مستودع صرف الفواتير. غيّره من الإعدادات أولاً');
      }
      if (data.isDefault) {
        if (!(data.isActive ?? before.isActive)) throw badRequest('المستودع الافتراضي يجب أن يكون فعّالاً');
        await tx.warehouse.updateMany({ where: { isDefault: true, id: { not: before.id } }, data: { isDefault: false } });
      }
      const updated = await tx.warehouse.update({ where: { id: before.id }, data });
      await audit(tx, req.ctx, { action: 'warehouse.update', entityType: 'warehouse', entityId: before.id, summary: updated.name, before, after: updated });
      return updated;
    });
    res.json(w);
  }),
);

// ── Transfers ──

const transferInclude = {
  fromWarehouse: { select: { id: true, name: true, code: true } },
  toWarehouse: { select: { id: true, name: true, code: true } },
} satisfies Prisma.StockTransferInclude;

warehousesRouter.get(
  '/transfers',
  requireAnyPerm('inventory.view', 'inventory.transfer'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ warehouseId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional() }), req.query);
    const where: Prisma.StockTransferWhereInput = {
      ...(q.warehouseId && { OR: [{ fromWarehouseId: q.warehouseId }, { toWarehouseId: q.warehouseId }] }),
      ...(q.from && { createdAt: (({ from, to }) => ({ gte: from, lte: to }))(rangeFromQuery(q.from, q.to)) }),
      ...(q.q && { OR: [{ transferNumber: { contains: q.q, mode: 'insensitive' } }, { items: { some: { item: { name: { contains: q.q, mode: 'insensitive' } } } } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.stockTransfer.findMany({ where, include: { ...transferInclude, _count: { select: { items: true } } }, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
      prisma.stockTransfer.count({ where }),
    ]);
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.createdById).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } });
    res.json(paged(items.map((t) => ({ ...t, createdBy: users.find((u) => u.id === t.createdById)?.fullName ?? null })), total, q));
  }),
);

warehousesRouter.get(
  '/transfers/:id',
  requireAnyPerm('inventory.view', 'inventory.transfer'),
  ah(async (req, res) => {
    const t = await prisma.stockTransfer.findUnique({
      where: { id: req.params.id },
      include: { ...transferInclude, items: { include: { item: { select: { id: true, name: true, sku: true, unit: { select: { name: true, symbol: true } } } } }, orderBy: { item: { name: 'asc' } } } },
    });
    if (!t) throw notFound('سند النقل غير موجود');
    const by = t.createdById ? await prisma.user.findUnique({ where: { id: t.createdById }, select: { fullName: true } }) : null;
    res.json({ ...t, createdBy: by?.fullName ?? null });
  }),
);

/** Moves goods now: all lines or none (any shortage cancels the whole transfer). */
warehousesRouter.post(
  '/transfers',
  requirePerm('inventory.transfer'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        fromWarehouseId: z.string().uuid('اختر المستودع المصدر'),
        toWarehouseId: z.string().uuid('اختر المستودع المستلم'),
        notes: nullableStr(500),
        items: z.array(z.object({ itemId: z.string().uuid(), quantity: z.coerce.number().positive('الكمية يجب أن تكون أكبر من صفر').max(1_000_000) })).min(1, 'أضف صنفاً واحداً على الأقل').max(500),
      }),
      req.body,
    );
    if (body.fromWarehouseId === body.toWarehouseId) throw badRequest('المستودع المصدر والمستلم متطابقان');
    if (new Set(body.items.map((i) => i.itemId)).size !== body.items.length) throw badRequest('الصنف مكرر في سند النقل');
    await ensureActiveItems(body.items.map((i) => i.itemId));
    const t = await prisma.$transaction(async (tx) => {
      const from = await resolveWarehouse(tx, body.fromWarehouseId);
      const to = await resolveWarehouse(tx, body.toWarehouseId);
      const n = await nextCounter(tx, 'stock_transfer');
      const created = await tx.stockTransfer.create({
        data: { transferNumber: `TR-${pad(n, 5)}`, fromWarehouseId: from.id, toWarehouseId: to.id, notes: body.notes, createdById: req.ctx.userId, items: { create: body.items } },
      });
      // Lines in a fixed order so two transfers of the same items never wait on each other in a loop.
      for (const it of [...body.items].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
        const common = { itemId: it.itemId, quantity: it.quantity, reference: created.transferNumber, referenceType: 'stock_transfer', referenceId: created.id };
        await recordMovement(tx, req.ctx, { ...common, type: 'TRANSFER_OUT', warehouseId: from.id, reason: `نقل إلى ${to.name}` });
        await recordMovement(tx, req.ctx, { ...common, type: 'TRANSFER_IN', warehouseId: to.id, reason: `نقل من ${from.name}` });
      }
      await audit(tx, req.ctx, { action: 'stock_transfer.create', entityType: 'stock_transfer', entityId: created.id, summary: `${created.transferNumber}: ${from.name} → ${to.name} (${body.items.length} صنف)`, after: body });
      return created;
    });
    res.status(201).json(t);
  }),
);
