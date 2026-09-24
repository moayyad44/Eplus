import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { requirePerm } from '../../middleware/auth';
import { rangeFromQuery } from '../../lib/dates';
import { D, num } from '../../lib/money';
import { env } from '../../config/env';

export const cashierRouter = Router();

/** Financial summary for any period: sales, collections by method, refunds, discounts, unpaid, expenses, net. */
export async function financialSummary(from: Date, to: Date, branchId?: string | null) {
  const branch = branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty;
  const [sales, byMethod, expenses, outstanding, daily] = await Promise.all([
    prisma.invoice.aggregate({
      where: { status: { notIn: ['DRAFT', 'CANCELLED'] }, issuedAt: { gte: from, lte: to }, ...(branchId && { branchId }) },
      _sum: { subtotal: true, discountTotal: true, taxTotal: true, total: true, balance: true },
      _count: true,
    }),
    prisma.$queryRaw<{ methodId: string; name: string; code: string; type: string; amount: Prisma.Decimal; count: bigint }[]>`
      SELECT m.id AS "methodId", m.name, m.code, p.type, SUM(p.amount) AS amount, COUNT(*) AS count
      FROM payments p JOIN payment_methods m ON m.id = p."methodId" JOIN invoices i ON i.id = p."invoiceId"
      WHERE p."voidedAt" IS NULL AND p."paidAt" BETWEEN ${from} AND ${to} ${branch}
      GROUP BY m.id, m.name, m.code, p.type ORDER BY m.name`,
    prisma.expense.aggregate({ where: { voidedAt: null, expenseDate: { gte: new Date(from.toISOString().slice(0, 10)), lte: to }, ...(branchId && { branchId }) }, _sum: { amount: true }, _count: true }),
    prisma.invoice.aggregate({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] }, balance: { gt: 0 }, ...(branchId && { branchId }) }, _sum: { balance: true }, _count: true }),
    prisma.$queryRaw<{ day: string; collected: Prisma.Decimal; refunded: Prisma.Decimal }[]>`
      SELECT to_char(p."paidAt" AT TIME ZONE 'UTC' AT TIME ZONE ${env.TZ}, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(CASE WHEN p.type = 'PAYMENT' THEN p.amount END), 0) AS collected,
             COALESCE(SUM(CASE WHEN p.type = 'REFUND' THEN p.amount END), 0) AS refunded
      FROM payments p JOIN invoices i ON i.id = p."invoiceId"
      WHERE p."voidedAt" IS NULL AND p."paidAt" BETWEEN ${from} AND ${to} ${branch}
      GROUP BY 1 ORDER BY 1`,
  ]);

  const methods = new Map<string, { methodId: string; name: string; code: string; collected: number; refunded: number; count: number }>();
  for (const r of byMethod) {
    const m = methods.get(r.methodId) ?? { methodId: r.methodId, name: r.name, code: r.code, collected: 0, refunded: 0, count: 0 };
    if (r.type === 'PAYMENT') { m.collected += num(r.amount); m.count += Number(r.count); } else m.refunded += num(r.amount);
    methods.set(r.methodId, m);
  }
  const collected = [...methods.values()].reduce((a, m) => a + m.collected, 0);
  const refunded = [...methods.values()].reduce((a, m) => a + m.refunded, 0);
  const expenseTotal = num(expenses._sum.amount);
  const netReceipts = D(collected).sub(refunded).toNumber();
  return {
    period: { from, to },
    invoiceCount: sales._count,
    grossSales: num(sales._sum.subtotal),
    discounts: num(sales._sum.discountTotal),
    tax: num(sales._sum.taxTotal),
    netSales: num(sales._sum.total),
    unpaidFromPeriod: num(sales._sum.balance),
    collected,
    refunded,
    netReceipts,
    byMethod: [...methods.values()],
    expenses: expenseTotal,
    expenseCount: expenses._count,
    netIncome: D(netReceipts).sub(expenseTotal).toNumber(),
    outstandingTotal: num(outstanding._sum.balance),
    outstandingCount: outstanding._count,
    daily: daily.map((d) => ({ day: d.day, collected: num(d.collected), refunded: num(d.refunded) })),
  };
}

cashierRouter.get(
  '/summary',
  requirePerm('cashier.view'),
  ah(async (req, res) => {
    const q = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query);
    const { from, to } = rangeFromQuery(q.from, q.to);
    res.json(await financialSummary(from, to));
  }),
);
