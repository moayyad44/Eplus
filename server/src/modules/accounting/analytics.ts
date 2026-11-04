import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { getSetting } from '../../lib/settings';
import { D } from '../../lib/money';
import { addDays, dateOnlyStr, ymd } from '../../lib/dates';
import { dayOf } from './journal';
import { postDoc } from './link';
import { accountBalances } from './ledger';
import { addSheet } from './xlsx';

/** Aging, revenue analysis, cash flow, dashboard figures and alerts, Excel export, fiscal year closing. */
export const analyticsRouter = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toLocaleDateString('en-CA');
const BUCKETS = ['b0_30', 'b31_60', 'b61_90', 'b90'] as const;
const bucket = (days: number) => (days <= 30 ? 'b0_30' : days <= 60 ? 'b31_60' : days <= 90 ? 'b61_90' : 'b90');

/** Aging of receivables (patients / insurance companies) and payables (suppliers): < 30, 30–60, 60–90, > 90 days. */
analyticsRouter.get('/reports/aging', requirePerm('accounting.reports.view'), ah(async (req, res) => {
  const q = parse(z.object({ type: z.enum(['patients', 'insurance', 'suppliers']), asOf: day.optional() }), req.query);
  const asOf = new Date(`${q.asOf ?? today()}T23:59:59`);
  const rows = new Map<string, { id: string; name: string; total: number; b0_30: number; b31_60: number; b61_90: number; b90: number; items: { ref: string; date: string; amount: number; days: number }[] }>();
  const add = (id: string, name: string, ref: string, date: Date, amount: number) => {
    if (amount <= 0.0005) return;
    const days = Math.floor((asOf.getTime() - date.getTime()) / 86_400_000);
    const r = rows.get(id) ?? { id, name, total: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90: 0, items: [] };
    r.total += amount; r[bucket(days)] += amount; r.items.push({ ref, date: ymd(date), amount, days });
    rows.set(id, r);
  };
  if (q.type === 'patients') {
    const inv = await prisma.invoice.findMany({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] }, balance: { gt: 0 }, issuedAt: { lte: asOf } }, include: { patient: { select: { fullName: true, fileNumber: true } } } });
    for (const i of inv) add(i.patientId, `${i.patient.fullName} (${i.patient.fileNumber})`, i.invoiceNumber ?? '', i.issuedAt!, D(i.balance).toNumber());
  } else if (q.type === 'insurance') {
    const claims = await prisma.insuranceClaim.findMany({ where: { workflowStatus: { not: 'CANCELLED' }, createdAt: { lte: asOf } }, include: { company: { select: { nameAr: true } } } });
    for (const c of claims) add(c.companyId, c.company.nameAr, c.claimNumber, c.submittedAt ?? c.createdAt, D(c.insuranceAmount).sub(c.paidAmount).sub(c.transferredAmount).sub(c.writtenOffAmount).toNumber());
  } else {
    const [pos, pays] = await Promise.all([
      prisma.purchaseOrder.findMany({ where: { status: 'RECEIVED', receivedAt: { lte: asOf } }, include: { supplier: { select: { name: true } } }, orderBy: { receivedAt: 'asc' } }),
      prisma.supplierPayment.groupBy({ by: ['supplierId'], where: { voidedAt: null, paidAt: { lte: asOf } }, _sum: { amount: true } }),
    ]);
    const paid = new Map(pays.map((p) => [p.supplierId, D(p._sum.amount).toNumber()]));
    for (const po of pos) { // payments settle the oldest orders first
      let left = D(po.total).toNumber();
      const p = paid.get(po.supplierId) ?? 0;
      const used = Math.min(p, left);
      paid.set(po.supplierId, p - used); left -= used;
      add(po.supplierId, po.supplier.name, po.poNumber, po.receivedAt!, Number(left.toFixed(3)));
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, total: Number(r.total.toFixed(3)), ...Object.fromEntries(BUCKETS.map((b) => [b, Number(r[b].toFixed(3))])) })).sort((a, b) => b.total - a.total);
  const totals = Object.fromEntries(['total', ...BUCKETS].map((k) => [k, Number(list.reduce((s, r) => s + (r as never as Record<string, number>)[k], 0).toFixed(3))]));
  res.json({ asOf: q.asOf ?? today(), rows: list, totals });
}));

/** Revenue from EmergencyPlus invoices (issued, not cancelled) by doctor, service type, payment method, day or month. */
analyticsRouter.get('/reports/revenue', requirePerm('accounting.reports.view'), ah(async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional(), by: z.enum(['doctor', 'category', 'method', 'day', 'month', 'payer']).default('category'), doctorId: z.string().uuid().optional() }), req.query);
  const from = new Date(`${q.from ?? `${today().slice(0, 8)}01`}T00:00:00`), to = new Date(`${q.to ?? today()}T23:59:59.999`);
  const doc = q.doctorId ? Prisma.sql`AND i."doctorId" = ${q.doctorId}` : Prisma.empty;
  let rows: { key: string | null; label: string | null; amount: Prisma.Decimal; count: bigint; paid?: Prisma.Decimal; outstanding?: Prisma.Decimal }[];
  if (q.by === 'method') {
    rows = await prisma.$queryRaw`SELECT m.code AS key, m.name AS label, SUM(CASE WHEN p.type = 'PAYMENT' THEN p.amount ELSE -p.amount END) AS amount, COUNT(*) AS count
      FROM payments p JOIN payment_methods m ON m.id = p."methodId" JOIN invoices i ON i.id = p."invoiceId" WHERE p."voidedAt" IS NULL AND p."paidAt" BETWEEN ${from} AND ${to} ${doc} GROUP BY 1, 2 ORDER BY 3 DESC`;
  } else if (q.by === 'category') {
    rows = await prisma.$queryRaw`SELECT ii.category::text AS key, ii.category::text AS label, SUM(ii."lineTotal") AS amount, COUNT(DISTINCT i.id) AS count
      FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId" WHERE i.status NOT IN ('DRAFT','CANCELLED') AND i."issuedAt" BETWEEN ${from} AND ${to} ${doc} GROUP BY 1, 2 ORDER BY 3 DESC`;
  } else {
    const key = q.by === 'doctor' ? Prisma.sql`i."doctorId"` : q.by === 'payer' ? Prisma.sql`i."payerType"::text` : q.by === 'day' ? Prisma.sql`to_char(i."issuedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Amman', 'YYYY-MM-DD')` : Prisma.sql`to_char(i."issuedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Amman', 'YYYY-MM')`;
    rows = await prisma.$queryRaw`SELECT ${key} AS key, ${key} AS label, SUM(i.total) AS amount, COUNT(*) AS count, SUM(i."paidAmount" - i."refundedAmount") AS paid, SUM(i.balance) AS outstanding
      FROM invoices i WHERE i.status NOT IN ('DRAFT','CANCELLED') AND i."issuedAt" BETWEEN ${from} AND ${to} ${doc} GROUP BY 1 ORDER BY ${q.by === 'day' || q.by === 'month' ? Prisma.sql`1` : Prisma.sql`3 DESC`}`;
    if (q.by === 'doctor') {
      const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.key).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
      rows = rows.map((r) => ({ ...r, label: users.find((u) => u.id === r.key)?.fullName ?? 'بدون طبيب' }));
    }
  }
  const out = rows.map((r) => ({ key: r.key, label: r.label, amount: D(r.amount).toNumber(), count: Number(r.count), paid: r.paid != null ? D(r.paid).toNumber() : undefined, outstanding: r.outstanding != null ? D(r.outstanding).toNumber() : undefined }));
  res.json({ from: ymd(from), to: ymd(to), by: q.by, rows: out, total: Number(out.reduce((s, r) => s + r.amount, 0).toFixed(3)) });
}));

/** Cash flow (direct method): money in / out of boxes and banks, classified by what was on the other side of each entry. */
analyticsRouter.get('/reports/cash-flow', requirePerm('accounting.reports.view'), ah(async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional() }), req.query);
  const from = dayOf(q.from ?? `${today().slice(0, 8)}01`), to = dayOf(q.to ?? today());
  const accounts = await prisma.account.findMany();
  const groups = accounts.filter((a) => a.systemKey === 'CASH_GROUP' || a.systemKey === 'BANK_GROUP').map((a) => a.id);
  const cash = new Set<string>();
  for (let grew = true; grew;) { grew = false; for (const a of accounts) if (!cash.has(a.id) && (groups.includes(a.parentId ?? '') || cash.has(a.parentId ?? ''))) { cash.add(a.id); grew = true; } }
  if (!cash.size) return res.json({ opening: 0, closing: 0, sections: [] });
  const ids = [...cash];
  const [op] = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(l.debit - l.credit) v FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId" WHERE e.status = 'POSTED' AND e.date < ${from} AND l."accountId" IN (${Prisma.join(ids)})`;
  const entries = await prisma.journalEntry.findMany({ where: { status: 'POSTED', date: { gte: from, lte: to }, lines: { some: { accountId: { in: ids } } } }, include: { lines: true } });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const section = (accId: string) => {
    const a = byId.get(accId);
    if (!a) return 'operating';
    let cur: typeof a | undefined = a;
    while (cur) { if (cur.systemKey === 'FIXED_ASSETS_GROUP') return 'investing'; cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    if (a.type === 'EQUITY') return 'financing';
    return 'operating';
  };
  const lines = new Map<string, { section: string; accountId: string; name: string; inflow: number; outflow: number }>();
  let transfers = 0;
  for (const e of entries) {
    const cashNet = e.lines.filter((l) => cash.has(l.accountId)).reduce((t, l) => t + D(l.debit).sub(l.credit).toNumber(), 0);
    const others = e.lines.filter((l) => !cash.has(l.accountId));
    if (!others.length) { transfers++; continue; } // between boxes / banks
    const totalOther = others.reduce((t, l) => t + D(l.debit).add(l.credit).toNumber(), 0) || 1;
    for (const o of others) {
      const share = cashNet * (D(o.debit).add(o.credit).toNumber() / totalOther);
      const a = byId.get(o.accountId)!;
      const k = o.accountId;
      const r = lines.get(k) ?? { section: section(o.accountId), accountId: k, name: `${a.code} ${a.name}`, inflow: 0, outflow: 0 };
      if (share >= 0) r.inflow += share; else r.outflow -= share;
      lines.set(k, r);
    }
  }
  const all = [...lines.values()].map((r) => ({ ...r, inflow: Number(r.inflow.toFixed(3)), outflow: Number(r.outflow.toFixed(3)), net: Number((r.inflow - r.outflow).toFixed(3)) }));
  const sections = ['operating', 'investing', 'financing'].map((s) => { const rs = all.filter((r) => r.section === s).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)); return { key: s, rows: rs, net: Number(rs.reduce((t, r) => t + r.net, 0).toFixed(3)) }; });
  const opening = D(op?.v).toNumber();
  const change = sections.reduce((t, s) => t + s.net, 0);
  res.json({ from: dateOnlyStr(from), to: dateOnlyStr(to), opening, sections, change: Number(change.toFixed(3)), closing: Number((opening + change).toFixed(3)), internalTransfers: transfers });
}));

/** Everything the accounting dashboard shows: figures, charts and alerts — all from real data. */
analyticsRouter.get('/dashboard', requirePerm('accounting.access'), ah(async (_req, res) => {
  const cfg = await getSetting('accounting');
  const t = today(), y = t.slice(0, 4), ms = `${t.slice(0, 8)}01`;
  const rowsY = await accountBalances(dayOf(`${y}-01-01`), dayOf(t));
  const rowsD = await accountBalances(dayOf(t), dayOf(t));
  const rowsM = await accountBalances(dayOf(ms), dayOf(t));
  const k = (rows: typeof rowsY, key: string) => rows.find((r) => r.systemKey === key);
  const pl = (rows: typeof rowsY, type: string) => { const r = rows.find((x) => x.type === type && x.level === 0); return r ? (type === 'REVENUE' ? r.credit - r.debit : r.debit - r.credit) : 0; };
  const monthly = await prisma.$queryRaw<{ m: string; type: string; v: Prisma.Decimal }[]>`
    SELECT to_char(e.date, 'YYYY-MM') m, a.type::text type, SUM(l.credit - l.debit) v FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId" JOIN acc_accounts a ON a.id = l."accountId"
    WHERE e.status = 'POSTED' AND a.type IN ('REVENUE','EXPENSE') AND e.date >= ${dayOf(`${Number(y) - 1}-${t.slice(5, 7)}-01`)} AND e.type <> 'CLOSING' GROUP BY 1, 2 ORDER BY 1`;
  const months = [...new Set(monthly.map((r) => r.m))].sort().slice(-12).map((m) => {
    const rev = D(monthly.find((r) => r.m === m && r.type === 'REVENUE')?.v).toNumber(), exp = -D(monthly.find((r) => r.m === m && r.type === 'EXPENSE')?.v).toNumber();
    return { month: m, revenue: rev, expense: exp, profit: Number((rev - exp).toFixed(3)) };
  });
  const from = new Date(`${ms}T00:00:00`);
  const [byMethod, byDoctor, byCat] = await Promise.all([
    prisma.$queryRaw<{ label: string; v: Prisma.Decimal }[]>`SELECT m.name label, SUM(CASE WHEN p.type='PAYMENT' THEN p.amount ELSE -p.amount END) v FROM payments p JOIN payment_methods m ON m.id = p."methodId" WHERE p."voidedAt" IS NULL AND p."paidAt" >= ${from} GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ id: string | null; v: Prisma.Decimal }[]>`SELECT "doctorId" id, SUM(total) v FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED') AND "issuedAt" >= ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.$queryRaw<{ label: string; v: Prisma.Decimal }[]>`SELECT ii.category::text label, SUM(ii."lineTotal") v FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId" WHERE i.status NOT IN ('DRAFT','CANCELLED') AND i."issuedAt" >= ${from} GROUP BY 1 ORDER BY 2 DESC`,
  ]);
  const docs = await prisma.user.findMany({ where: { id: { in: byDoctor.map((d) => d.id).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
  const late = addDays(new Date(), -cfg.visaLateDays);
  const todayD = dayOf(t);
  const [visaOpen, visaLate, visaFees, chq, chqDue, chqOver, chqCollect, failed, waiting, countsPending, overdueInv, payable, vis] = await Promise.all([
    prisma.visaTransaction.aggregate({ where: { status: { in: ['PENDING', 'PARTIAL'] } }, _sum: { amount: true, settled: true }, _count: true }),
    prisma.visaTransaction.count({ where: { status: { in: ['PENDING', 'PARTIAL'] }, date: { lt: late } } }),
    prisma.visaSettlement.aggregate({ where: { status: 'ACTIVE', date: { gte: dayOf(`${y}-01-01`) } }, _sum: { fee: true, net: true } }),
    prisma.cheque.groupBy({ by: ['direction', 'status'], _sum: { amount: true }, _count: true }),
    prisma.cheque.count({ where: { OR: [{ direction: 'IN', status: { in: ['RECEIVED', 'IN_SAFE', 'READY'] } }, { direction: 'OUT', status: { in: ['ISSUED', 'DELIVERED', 'DUE'] } }], dueDate: { gte: todayD, lte: addDays(todayD, cfg.chequeDueDays) } } }),
    prisma.cheque.count({ where: { OR: [{ direction: 'IN', status: { in: ['RECEIVED', 'IN_SAFE', 'READY'] } }, { direction: 'OUT', status: { in: ['ISSUED', 'DELIVERED', 'DUE'] } }], dueDate: { lt: todayD } } }),
    prisma.cheque.count({ where: { status: 'UNDER_COLLECTION', updatedAt: { lt: addDays(new Date(), -cfg.collectionLateDays) } } }),
    prisma.accountingEvent.count({ where: { status: 'FAILED' } }),
    prisma.journalEntry.count({ where: { status: 'DRAFT' } }),
    prisma.cashCount.count({ where: { status: 'PENDING' } }),
    prisma.invoice.count({ where: { status: 'OVERDUE' } }),
    prisma.payrollRun.count({ where: { status: 'APPROVED' } }),
    prisma.visaTransaction.count({ where: { status: 'REVIEW' } }),
  ]);
  const cs = (dir: string, st: string[]) => chq.filter((c) => c.direction === dir && st.includes(c.status)).reduce((t, c) => t + D(c._sum.amount).toNumber(), 0);
  const bounced = chq.filter((c) => c.status === 'BOUNCED').reduce((t, c) => t + c._count, 0);
  const alerts = [
    visaLate && { level: 'warning', key: 'visaLate', n: visaLate, link: '/accounting/visa?late=true' },
    vis && { level: 'warning', key: 'visaReview', n: vis, link: '/accounting/visa' },
    chqDue && { level: 'info', key: 'chequesDue', n: chqDue, link: '/accounting/cheques?alert=due' },
    chqOver && { level: 'danger', key: 'chequesOverdue', n: chqOver, link: '/accounting/cheques?alert=overdue' },
    chqCollect && { level: 'warning', key: 'chequesCollecting', n: chqCollect, link: '/accounting/cheques?alert=collecting' },
    bounced && { level: 'danger', key: 'chequesBounced', n: bounced, link: '/accounting/cheques?alert=bounced' },
    countsPending && { level: 'warning', key: 'cashCounts', n: countsPending, link: '/accounting/cash' },
    overdueInv && { level: 'info', key: 'overdueInvoices', n: overdueInv, link: '/accounting/aging?type=patients' },
    failed && { level: 'danger', key: 'linkFailed', n: failed, link: '/accounting/integration?status=FAILED' },
    waiting && { level: 'warning', key: 'draftEntries', n: waiting, link: '/accounting/journal?status=DRAFT' },
    payable && { level: 'info', key: 'payrollUnpaid', n: payable, link: '/accounting/payroll' },
    !cfg.startDate && { level: 'info', key: 'notStarted', n: 0, link: '/accounting/settings' },
  ].filter(Boolean);
  const fixedNet = (k(rowsY, 'FIXED_ASSETS_GROUP')?.closing ?? 0);
  res.json({
    revenue: { today: pl(rowsD, 'REVENUE'), month: pl(rowsM, 'REVENUE'), year: pl(rowsY, 'REVENUE') },
    expense: { today: pl(rowsD, 'EXPENSE'), month: pl(rowsM, 'EXPENSE'), year: pl(rowsY, 'EXPENSE') },
    balances: {
      cash: k(rowsY, 'CASH_GROUP')?.closing ?? 0, banks: k(rowsY, 'BANK_GROUP')?.closing ?? 0, visaClearing: k(rowsY, 'VISA_CLEARING')?.closing ?? 0,
      arPatients: k(rowsY, 'AR_PATIENTS')?.closing ?? 0, arInsurance: k(rowsY, 'AR_INSURANCE')?.closing ?? 0, ap: k(rowsY, 'AP_SUPPLIERS')?.closing ?? 0,
      salariesPayable: k(rowsY, 'SALARIES_PAYABLE')?.closing ?? 0, inventory: k(rowsY, 'INVENTORY')?.closing ?? 0, fixedAssets: fixedNet,
      chequesOnHand: k(rowsY, 'CHEQUES_ON_HAND')?.closing ?? 0, chequesCollecting: k(rowsY, 'CHEQUES_UNDER_COLLECTION')?.closing ?? 0, chequesIssued: k(rowsY, 'CHEQUES_ISSUED')?.closing ?? 0,
    },
    visa: { notReached: D(visaOpen._sum.amount).sub(D(visaOpen._sum.settled)).toNumber(), count: visaOpen._count, fees: D(visaFees._sum.fee).toNumber(), reached: D(visaFees._sum.net).toNumber() },
    cheques: {
      inReceived: cs('IN', ['RECEIVED', 'IN_SAFE', 'READY', 'UNDER_COLLECTION', 'COLLECTED', 'BOUNCED']), inSafe: cs('IN', ['RECEIVED', 'IN_SAFE', 'READY']), collecting: cs('IN', ['UNDER_COLLECTION']),
      collected: cs('IN', ['COLLECTED']), bounced: cs('IN', ['BOUNCED']), outUnpaid: cs('OUT', ['ISSUED', 'DELIVERED', 'DUE']),
    },
    charts: {
      months, byMethod: byMethod.map((r) => ({ label: r.label, value: D(r.v).toNumber() })), byCategory: byCat.map((r) => ({ label: r.label, value: D(r.v).toNumber() })),
      byDoctor: byDoctor.map((r) => ({ label: docs.find((d) => d.id === r.id)?.fullName ?? 'بدون طبيب', value: D(r.v).toNumber() })),
    },
    alerts, startDate: cfg.startDate,
  });
}));

/** Any table on screen as a real Excel file: Arabic, right to left, frozen header, filters, JOD amounts, totals. */
analyticsRouter.post('/export/xlsx', requirePerm('accounting.export'), ah(async (req, res) => {
  const b = parse(z.object({
    title: z.string().max(150), sheet: z.string().max(31).optional(), fileName: z.string().max(80).optional(),
    columns: z.array(z.object({ header: z.string().max(80), key: z.string().max(40), money: z.boolean().optional(), date: z.boolean().optional(), width: z.number().optional() })).min(1).max(40),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null(), z.boolean()]))).max(50_000),
    totals: z.array(z.string()).optional(),
  }), req.body);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EmergencyPlus Accounting';
  addSheet(wb, (b.sheet ?? 'تقرير').replace(/[\\/?*[\]:]/g, ' '), b.columns, b.rows, { title: `${b.title} — ${today()}`, totals: b.totals });
  await audit(prisma, req.ctx, { action: 'accounting.export', entityType: 'report', entityId: b.fileName ?? 'export', summary: `تصدير Excel: ${b.title} (${b.rows.length} صف)` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent((b.fileName ?? 'report').replace(/[^\w.-]/g, '_'))}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

// ───── Fiscal year closing ─────

/** Close a year: revenues and expenses are closed into retained earnings (closing entry dated the last day), then every period is closed. */
analyticsRouter.post('/fiscal-years/:id/close', requirePerm('accounting.periods.manage'), ah(async (req, res) => {
  const r = await prisma.$transaction(async (tx) => {
    const y = await tx.fiscalYear.findUnique({ where: { id: req.params.id }, include: { periods: true } });
    if (!y) throw notFound('السنة غير موجودة');
    if (y.status === 'CLOSED') throw badRequest('السنة مقفلة مسبقاً');
    if (await tx.journalEntry.count({ where: { status: 'DRAFT', date: { gte: y.startDate, lte: y.endDate } } })) throw badRequest('في السنة قيود بانتظار الاعتماد');
    const last = y.periods.find((p) => p.endDate.getTime() === y.endDate.getTime());
    if (last?.status === 'CLOSED') await tx.fiscalPeriod.update({ where: { id: last.id }, data: { status: 'OPEN' } });
    await tx.fiscalYear.update({ where: { id: y.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: req.ctx.userId } });
    const done = await postDoc(tx, 'year-close', y.id);
    await tx.fiscalPeriod.updateMany({ where: { fiscalYearId: y.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: req.ctx.userId } });
    await audit(tx, req.ctx, { action: 'fiscal_year.close', entityType: 'fiscal_year', entityId: y.id, summary: `إقفال ${y.name}` });
    return done;
  });
  res.json(r);
}));

analyticsRouter.post('/fiscal-years/:id/reopen', requirePerm('accounting.periods.reopen'), ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'سبب إعادة الفتح مطلوب').max(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const y = await tx.fiscalYear.findUnique({ where: { id: req.params.id }, include: { periods: true } });
    if (!y || y.status !== 'CLOSED') throw badRequest('السنة غير مقفلة');
    const last = y.periods.find((p) => p.endDate.getTime() === y.endDate.getTime());
    if (last) await tx.fiscalPeriod.update({ where: { id: last.id }, data: { status: 'OPEN', reopenedAt: new Date(), reopenedById: req.ctx.userId, reopenReason: reason } });
    await tx.fiscalYear.update({ where: { id: y.id }, data: { status: 'OPEN', closedAt: null } });
    await postDoc(tx, 'year-close', y.id); // removes the closing entry
    await audit(tx, req.ctx, { action: 'fiscal_year.reopen', entityType: 'fiscal_year', entityId: y.id, summary: `إعادة فتح ${y.name}: ${reason}` });
  });
  res.json({ ok: true });
}));

// Accounting-only view of the audit log.
analyticsRouter.get('/audit', requirePerm('accounting.settings'), ah(async (req, res) => {
  const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), q: z.string().optional(), from: day.optional(), to: day.optional() }), req.query);
  const types = ['journal_entry', 'account', 'voucher', 'treasury', 'treasury_transfer', 'cash_count', 'visa_settlement', 'visa_transaction', 'cheque', 'cheque_count', 'salary_profile', 'payroll_run', 'employee_advance', 'fixed_asset', 'fiscal_year', 'fiscal_period', 'bank_reconciliation', 'report', 'setting'];
  const where: Prisma.AuditLogWhereInput = {
    entityType: { in: types }, ...(q.q && { summary: { contains: q.q, mode: 'insensitive' } }),
    ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(`${q.from}T00:00:00`) }), ...(q.to && { lte: new Date(`${q.to}T23:59:59.999`) }) } }),
  };
  const [items, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * 50, take: 50 }), prisma.auditLog.count({ where })]);
  res.json({ items, total, page: q.page, pageSize: 50, pageCount: Math.max(1, Math.ceil(total / 50)) });
}));

