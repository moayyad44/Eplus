import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { requirePerm } from '../../middleware/auth';
import { dateOnly, rangeFromQuery } from '../../lib/dates';
import { D, num } from '../../lib/money';
import { env } from '../../config/env';
import { insuranceTotals } from '../insurance/claimRoutes';
import { getSetting } from '../../lib/settings';
import { loadMapping } from '../accounting/link';
import { dayOf } from '../accounting/journal';

export const cashierRouter = Router();

/** Financial summary for any period: sales, collections by method, refunds, discounts, unpaid, expenses, net. */
export async function financialSummary(from: Date, to: Date, branchId?: string | null) {
  const branch = branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty;
  const [sales, byMethod, expenses, outstanding, daily, supplierPaid] = await Promise.all([
    prisma.invoice.aggregate({
      where: { status: { notIn: ['DRAFT', 'CANCELLED'] }, issuedAt: { gte: from, lte: to }, ...(branchId && { branchId }) },
      _sum: { subtotal: true, discountTotal: true, taxTotal: true, total: true, balance: true, patientShare: true, insuranceShare: true },
      _count: true,
    }),
    prisma.$queryRaw<{ methodId: string; name: string; code: string; type: string; amount: Prisma.Decimal; count: bigint }[]>`
      SELECT m.id AS "methodId", m.name, m.code, p.type, SUM(p.amount) AS amount, COUNT(*) AS count
      FROM payments p JOIN payment_methods m ON m.id = p."methodId" JOIN invoices i ON i.id = p."invoiceId"
      WHERE p."voidedAt" IS NULL AND p."paidAt" BETWEEN ${from} AND ${to} ${branch}
      GROUP BY m.id, m.name, m.code, p.type ORDER BY m.name`,
    prisma.expense.aggregate({ where: { voidedAt: null, expenseDate: { gte: dateOnly(from), lte: dateOnly(to) }, ...(branchId && { branchId }) }, _sum: { amount: true }, _count: true }),
    prisma.invoice.aggregate({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] }, balance: { gt: 0 }, ...(branchId && { branchId }) }, _sum: { balance: true }, _count: true }),
    prisma.$queryRaw<{ day: string; collected: Prisma.Decimal; refunded: Prisma.Decimal }[]>`
      SELECT to_char(p."paidAt" AT TIME ZONE 'UTC' AT TIME ZONE ${env.TZ}, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(CASE WHEN p.type = 'PAYMENT' THEN p.amount END), 0) AS collected,
             COALESCE(SUM(CASE WHEN p.type = 'REFUND' THEN p.amount END), 0) AS refunded
      FROM payments p JOIN invoices i ON i.id = p."invoiceId"
      WHERE p."voidedAt" IS NULL AND p."paidAt" BETWEEN ${from} AND ${to} ${branch}
      GROUP BY 1 ORDER BY 1`,
    // Money paid to suppliers leaves the clinic too: it counts with the expenses.
    prisma.supplierPayment.aggregate({ where: { voidedAt: null, paidAt: { gte: from, lte: to } }, _sum: { amount: true }, _count: true }),
  ]);

  const methods = new Map<string, { methodId: string; name: string; code: string; collected: number; refunded: number; count: number }>();
  for (const r of byMethod) {
    const m = methods.get(r.methodId) ?? { methodId: r.methodId, name: r.name, code: r.code, collected: 0, refunded: 0, count: 0 };
    if (r.type === 'PAYMENT') { m.collected += num(r.amount); m.count += Number(r.count); } else m.refunded += num(r.amount);
    methods.set(r.methodId, m);
  }
  const collected = [...methods.values()].reduce((a, m) => a + m.collected, 0);
  const refunded = [...methods.values()].reduce((a, m) => a + m.refunded, 0);
  const generalExpenses = num(expenses._sum.amount);
  const supplierPayments = num(supplierPaid._sum.amount);
  const expenseTotal = D(generalExpenses).add(supplierPayments).toNumber();
  const netReceipts = D(collected).sub(refunded).toNumber();
  // Insurance money only counts as collected when the company actually pays it.
  const ins = await insuranceTotals(from, to);
  const cashCollected = D(netReceipts).add(ins.received).toNumber();
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
    expenseCount: expenses._count + supplierPaid._count,
    generalExpenses,
    supplierPayments,
    supplierPaymentCount: supplierPaid._count,
    netIncome: D(cashCollected).sub(expenseTotal).toNumber(),
    outstandingTotal: num(outstanding._sum.balance),
    outstandingCount: outstanding._count,
    // Insurance, kept apart from patient money and from discounts.
    patientBilled: num(sales._sum.patientShare),
    insuranceBilled: num(sales._sum.insuranceShare),
    insuranceReceived: ins.received,
    cashCollected,
    patientReceivables: num(outstanding._sum.balance),
    insuranceReceivables: ins.outstanding,
    insuranceApproved: ins.approved,
    insuranceRejected: ins.rejected,
    insuranceWrittenOff: ins.writtenOff,
    insuranceTransferred: ins.transferred,
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

/**
 * What is actually in each cash box and still waiting in Visa right now — from the accounting books, so deposits to the
 * bank, cash expenses, vouchers and count differences are all counted (the period summary above only adds up the day's
 * payments). Before the accounting link is started the books do not hold the clinic's payments yet.
 */
cashierRouter.get(
  '/balances',
  requirePerm('cashier.view'),
  ah(async (_req, res) => {
    const cfg = await getSetting('accounting');
    if (!cfg.startDate) return res.json({ started: false, cash: [], visa: null });
    const today = dayOf(new Date().toLocaleDateString('en-CA', { timeZone: env.TZ }));
    const m = await loadMapping();
    const safe = (f: () => string) => { try { return f(); } catch { return null; } };
    const visaAcc = safe(() => m.role('VISA_CLEARING'));
    // Every cash box: the registered ones, plus the accounts the clinic's cash payments are posted to.
    const cashMethods = await prisma.paymentMethod.findMany({ where: { code: 'CASH' }, select: { id: true } });
    const mapped = [safe(() => m.role('CASH_MAIN')), ...cashMethods.map((x) => safe(() => m.method(x.id)))].filter(Boolean) as string[];
    const treasuries = await prisma.treasury.findMany({ where: { kind: 'CASH', isActive: true } });
    const cashIds = [...new Set([...mapped, ...treasuries.map((t) => t.accountId)])];
    const accounts = await prisma.account.findMany({ where: { id: { in: cashIds } }, select: { id: true, name: true, code: true } });
    const boxes = cashIds.map((id) => ({ id, accountId: id, name: treasuries.find((t) => t.accountId === id)?.name ?? accounts.find((a) => a.id === id)?.name ?? '', code: accounts.find((a) => a.id === id)?.code ?? '' }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const ids = [...boxes.map((b) => b.accountId), ...(visaAcc ? [visaAcc] : [])];
    const sums = ids.length ? await prisma.$queryRaw<{ accountId: string; bal: Prisma.Decimal; din: Prisma.Decimal; dout: Prisma.Decimal }[]>`
      SELECT l."accountId", SUM(l.debit - l.credit) bal,
        SUM(CASE WHEN e.date = ${today} THEN l.debit ELSE 0 END) din, SUM(CASE WHEN e.date = ${today} THEN l.credit ELSE 0 END) dout
      FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId"
      WHERE e.status = 'POSTED' AND l."accountId" IN (${Prisma.join(ids)}) GROUP BY 1` : [];
    const of = (id: string) => sums.find((s) => s.accountId === id);
    const pending = await prisma.visaTransaction.aggregate({ where: { status: { in: ['PENDING', 'PARTIAL'] } }, _count: true });
    res.json({
      started: true, startDate: cfg.startDate,
      cash: boxes.map((b) => ({ id: b.id, name: b.name, balance: D(of(b.accountId)?.bal).toNumber(), todayIn: D(of(b.accountId)?.din).toNumber(), todayOut: D(of(b.accountId)?.dout).toNumber() })),
      visa: visaAcc ? { balance: D(of(visaAcc)?.bal).toNumber(), todayIn: D(of(visaAcc)?.din).toNumber(), todayOut: D(of(visaAcc)?.dout).toNumber(), pendingCount: pending._count } : null,
    });
  }),
);
