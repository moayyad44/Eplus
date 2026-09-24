import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate, requiredDate, sortBy } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { dateOnly } from '../../lib/dates';

export const expensesRouter = Router();

const body = z.object({
  categoryId: z.string().uuid('اختر التصنيف'),
  amount: z.coerce.number().positive('المبلغ يجب أن يكون أكبر من صفر').max(10_000_000),
  expenseDate: requiredDate,
  paymentMethodId: z.string().uuid().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(2, 'الوصف مطلوب').max(500),
  reference: nullableStr(100),
});

expensesRouter.get(
  '/',
  requirePerm('expenses.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ from: z.string().optional(), to: z.string().optional(), categoryId: z.string().uuid().optional(), includeVoided: z.enum(['true', 'false']).optional() }), req.query);
    const where: Prisma.ExpenseWhereInput = {
      ...(q.includeVoided !== 'true' && { voidedAt: null }),
      ...(q.categoryId && { categoryId: q.categoryId }),
      ...((q.from || q.to) && { expenseDate: { ...(q.from && { gte: dateOnly(q.from) }), ...(q.to && { lte: dateOnly(q.to) }) } }),
      ...(q.q && { OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q } }] }),
    };
    const [items, total, sum] = await Promise.all([
      prisma.expense.findMany({
        where, ...paginate(q), orderBy: [sortBy(q.sort, ['expenseDate', 'amount', 'createdAt'] as const, 'expenseDate', q.order), { createdAt: 'desc' }],
        include: { category: { select: { name: true } }, paymentMethod: { select: { name: true } }, supplier: { select: { id: true, name: true } }, _count: { select: { attachments: { where: { deletedAt: null } } } } },
      }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where: { ...where, voidedAt: null }, _sum: { amount: true } }),
    ]);
    const userIds = [...new Set(items.map((i) => i.createdById).filter(Boolean) as string[])];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    const names = Object.fromEntries(users.map((u) => [u.id, u.fullName]));
    res.json({ ...paged(items.map((i) => ({ ...i, createdByName: i.createdById ? names[i.createdById] : null })), total, q), sum: sum._sum.amount ?? 0 });
  }),
);

expensesRouter.post(
  '/',
  requirePerm('expenses.manage'),
  ah(async (req, res) => {
    const data = parse(body, req.body);
    const e = await prisma.$transaction(async (tx) => {
      const row = await tx.expense.create({ data: { ...data, expenseDate: dateOnly(data.expenseDate), branchId: req.ctx.branchId, createdById: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'expense.create', entityType: 'expense', entityId: row.id, summary: `${data.description}: ${data.amount}`, after: row });
      return row;
    });
    res.status(201).json(e);
  }),
);

expensesRouter.put(
  '/:id',
  requirePerm('expenses.manage'),
  ah(async (req, res) => {
    const data = parse(body.partial(), req.body);
    const e = await prisma.$transaction(async (tx) => {
      const before = await tx.expense.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound();
      if (before.voidedAt) throw badRequest('المصروف ملغى');
      const row = await tx.expense.update({ where: { id: before.id }, data: { ...data, ...(data.expenseDate && { expenseDate: dateOnly(data.expenseDate) }) } });
      await audit(tx, req.ctx, { action: 'expense.update', entityType: 'expense', entityId: row.id, before, after: row });
      return row;
    });
    res.json(e);
  }),
);

expensesRouter.post(
  '/:id/void',
  requirePerm('expenses.manage'),
  ah(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'يرجى ذكر السبب').max(300) }), req.body);
    await prisma.$transaction(async (tx) => {
      const before = await tx.expense.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound();
      if (before.voidedAt) throw badRequest('المصروف ملغى مسبقاً');
      await tx.expense.update({ where: { id: before.id }, data: { voidedAt: new Date(), voidedById: req.ctx.userId, voidReason: reason } });
      await audit(tx, req.ctx, { action: 'expense.void', entityType: 'expense', entityId: before.id, summary: `إلغاء مصروف ${before.description}: ${reason}` });
    });
    res.json({ ok: true });
  }),
);
