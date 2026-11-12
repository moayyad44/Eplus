import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { requirePerm } from '../../middleware/auth';
import { dateOnly, rangeFromQuery, ymd } from '../../lib/dates';
import { num } from '../../lib/money';

/** More clinic reports: services, collections, unpaid invoices, control (cancellations/discounts), appointments, waiting & peak hours, lab activity, expenses. */
export const extraReportsRouter = Router();
const q0 = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), doctorId: z.string().uuid().optional(), category: z.string().optional() });
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const LOCAL = (col: Prisma.Sql) => Prisma.sql`(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Amman')`;
const names = async (ids: (string | null | undefined)[]) => {
  const u = await prisma.user.findMany({ where: { id: { in: [...new Set(ids.filter(Boolean) as string[])] } }, select: { id: true, fullName: true } });
  return (id: string | null | undefined) => u.find((x) => x.id === id)?.fullName ?? '—';
};

// ── Services: what was done and what it brought in ──
extraReportsRouter.get('/services', requirePerm('reports.financial'), ah(async (req, res) => {
  const q = parse(q0, req.query);
  const { from, to } = rangeFromQuery(q.from, q.to);
  const rows = await prisma.$queryRaw<{ serviceId: string; code: string; name: string; category: string; qty: Prisma.Decimal; invoices: bigint; gross: Prisma.Decimal; discount: Prisma.Decimal; net: Prisma.Decimal; insurance: Prisma.Decimal; patient: Prisma.Decimal }[]>`
    SELECT s.id AS "serviceId", s.code, s.name, ii.category::text AS category, SUM(ii.quantity) AS qty, COUNT(DISTINCT i.id) AS invoices,
           SUM(ii.quantity * ii."unitPrice") AS gross, SUM(ii.discount) AS discount, SUM(ii."lineTotal") AS net, SUM(ii."insuranceShare") AS insurance, SUM(ii."patientShare") AS patient
    FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId" JOIN services s ON s.id = ii."serviceId"
    WHERE i.status NOT IN ('DRAFT','CANCELLED') AND i."issuedAt" BETWEEN ${from} AND ${to}
      ${q.doctorId ? Prisma.sql`AND i."doctorId" = ${q.doctorId}` : Prisma.empty} ${q.category ? Prisma.sql`AND ii.category::text = ${q.category}` : Prisma.empty}
    GROUP BY s.id, s.code, s.name, ii.category ORDER BY net DESC`;
  const out = rows.map((r) => ({ serviceId: r.serviceId, code: r.code, name: r.name, category: r.category, quantity: num(r.qty), invoices: Number(r.invoices), gross: num(r.gross), discount: num(r.discount), net: num(r.net), insurance: num(r.insurance), patient: num(r.patient), avgPrice: num(r.qty) ? r3(num(r.net) / num(r.qty)) : 0 }));
  const total = out.reduce((t, r) => t + r.net, 0);
  const byCategory = new Map<string, number>();
  for (const r of out) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.net);
  res.json({ rows: out.map((r) => ({ ...r, share: total ? Math.round((r.net / total) * 1000) / 10 : 0 })), totals: { quantity: out.reduce((t, r) => t + r.quantity, 0), net: r3(total), discount: r3(out.reduce((t, r) => t + r.discount, 0)), services: out.length }, byCategory: [...byCategory].map(([category, amount]) => ({ category, amount: r3(amount) })).sort((a, b) => b.amount - a.amount) });
}));

// ── Collections: money received by day, method and the employee who received it ──
extraReportsRouter.get('/collections', requirePerm('reports.financial'), ah(async (req, res) => {
  const q = parse(q0, req.query);
  const { from, to } = rangeFromQuery(q.from, q.to);
  const pays = await prisma.payment.findMany({ where: { paidAt: { gte: from, lte: to } }, include: { method: { select: { name: true } }, invoice: { select: { invoiceNumber: true } }, patient: { select: { fullName: true } } }, orderBy: { paidAt: 'asc' } });
  const who = await names(pays.flatMap((p) => [p.receivedById, p.voidedById]));
  const live = pays.filter((p) => !p.voidedAt);
  const sign = (p: (typeof pays)[number]) => (p.type === 'REFUND' ? -1 : 1) * num(p.amount);
  const methods = [...new Set(live.map((p) => p.method.name))];
  const days = new Map<string, Record<string, number>>();
  for (const p of live) { const d = ymd(p.paidAt); const r = days.get(d) ?? {}; r[p.method.name] = r3((r[p.method.name] ?? 0) + sign(p)); days.set(d, r); }
  const cashiers = new Map<string, { name: string; payments: number; refunds: number; count: number }>();
  for (const p of live) { const k = p.receivedById ?? '-'; const c = cashiers.get(k) ?? { name: who(p.receivedById), payments: 0, refunds: 0, count: 0 }; if (p.type === 'REFUND') c.refunds += num(p.amount); else c.payments += num(p.amount); c.count++; cashiers.set(k, c); }
  res.json({
    methods,
    byDay: [...days].sort().map(([day, m]) => ({ day, ...m, total: r3(Object.values(m).reduce((a, b) => a + b, 0)) })),
    byCashier: [...cashiers.values()].map((c) => ({ ...c, payments: r3(c.payments), refunds: r3(c.refunds), net: r3(c.payments - c.refunds) })).sort((a, b) => b.net - a.net),
    totals: { payments: r3(live.filter((p) => p.type !== 'REFUND').reduce((t, p) => t + num(p.amount), 0)), refunds: r3(live.filter((p) => p.type === 'REFUND').reduce((t, p) => t + num(p.amount), 0)), count: live.length, voided: pays.length - live.length },
    refunds: live.filter((p) => p.type === 'REFUND').map((p) => ({ id: p.id, receiptNumber: p.receiptNumber, paidAt: p.paidAt, amount: num(p.amount), method: p.method.name, invoiceNumber: p.invoice.invoiceNumber, patient: p.patient.fullName, by: who(p.receivedById), notes: p.notes })),
  });
}));

// ── Unpaid invoices (to follow up with patients), with age ──
extraReportsRouter.get('/receivables', requirePerm('reports.financial'), ah(async (req, res) => {
  const q = parse(q0.partial().extend({ payer: z.enum(['patient', 'insurance', 'all']).default('patient') }), req.query);
  const now = Date.now();
  const inv = await prisma.invoice.findMany({
    where: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] }, balance: { gt: 0 }, ...(q.doctorId && { doctorId: q.doctorId }), ...(q.to && { issuedAt: { lte: rangeFromQuery(q.to, q.to).to } }) },
    select: { id: true, invoiceNumber: true, issuedAt: true, dueDate: true, total: true, paidAmount: true, balance: true, payerType: true, patient: { select: { id: true, fullName: true, phone: true, fileNumber: true } }, doctor: { select: { fullName: true } } },
    orderBy: { issuedAt: 'asc' }, take: 5000,
  });
  const rows = inv.map((i) => ({ ...i, total: num(i.total), paidAmount: num(i.paidAmount), balance: num(i.balance), days: i.issuedAt ? Math.floor((now - i.issuedAt.getTime()) / 86_400_000) : 0 }));
  const b = (d: number) => (d <= 30 ? 'b0_30' : d <= 60 ? 'b31_60' : d <= 90 ? 'b61_90' : 'b90');
  const buckets = { b0_30: 0, b31_60: 0, b61_90: 0, b90: 0 };
  for (const r of rows) buckets[b(r.days)] = r3(buckets[b(r.days)] + r.balance);
  const byPatient = new Map<string, { patientId: string; name: string; phone: string; fileNumber: string; invoices: number; balance: number; oldest: number }>();
  for (const r of rows) { const p = byPatient.get(r.patient.id) ?? { patientId: r.patient.id, name: r.patient.fullName, phone: r.patient.phone, fileNumber: r.patient.fileNumber, invoices: 0, balance: 0, oldest: 0 }; p.invoices++; p.balance = r3(p.balance + r.balance); p.oldest = Math.max(p.oldest, r.days); byPatient.set(r.patient.id, p); }
  res.json({ rows, buckets, total: r3(rows.reduce((t, r) => t + r.balance, 0)), byPatient: [...byPatient.values()].sort((a, b2) => b2.balance - a.balance) });
}));

// ── Control: cancelled invoices, voided payments, discounts by employee, back-dated invoices ──
extraReportsRouter.get('/control', requirePerm('reports.financial'), ah(async (req, res) => {
  const q = parse(q0, req.query);
  const { from, to } = rangeFromQuery(q.from, q.to);
  const [cancelled, voided, discounted, backdated] = await Promise.all([
    prisma.invoice.findMany({ where: { status: 'CANCELLED', cancelledAt: { gte: from, lte: to } }, select: { id: true, invoiceNumber: true, issuedAt: true, cancelledAt: true, cancelledById: true, cancelReason: true, total: true, createdById: true, patient: { select: { fullName: true } } }, orderBy: { cancelledAt: 'desc' } }),
    prisma.payment.findMany({ where: { voidedAt: { gte: from, lte: to } }, select: { id: true, receiptNumber: true, type: true, amount: true, paidAt: true, voidedAt: true, voidedById: true, voidReason: true, receivedById: true, method: { select: { name: true } }, patient: { select: { fullName: true } }, invoice: { select: { invoiceNumber: true } } }, orderBy: { voidedAt: 'desc' } }),
    prisma.invoice.findMany({ where: { status: { notIn: ['DRAFT', 'CANCELLED'] }, issuedAt: { gte: from, lte: to }, discountTotal: { gt: 0 } }, select: { id: true, invoiceNumber: true, issuedAt: true, subtotal: true, discountTotal: true, createdById: true, patient: { select: { fullName: true } } }, orderBy: { discountTotal: 'desc' } }),
    prisma.$queryRaw<{ id: string; invoiceNumber: string; issuedAt: Date; issuedRecordedAt: Date; total: Prisma.Decimal; createdById: string | null; patient: string }[]>`
      SELECT i.id, i."invoiceNumber", i."issuedAt", i."issuedRecordedAt", i.total, i."createdById", p."fullName" AS patient FROM invoices i JOIN patients p ON p.id = i."patientId"
      WHERE i."issuedRecordedAt" BETWEEN ${from} AND ${to} AND i."issuedAt" IS NOT NULL AND ${LOCAL(Prisma.sql`i."issuedAt"`)}::date < ${LOCAL(Prisma.sql`i."issuedRecordedAt"`)}::date ORDER BY i."issuedRecordedAt" DESC`,
  ]);
  const who = await names([...cancelled.flatMap((c) => [c.cancelledById, c.createdById]), ...voided.flatMap((v) => [v.voidedById, v.receivedById]), ...discounted.map((d) => d.createdById), ...backdated.map((b) => b.createdById)]);
  const byUser = new Map<string, { name: string; invoices: number; discount: number; subtotal: number }>();
  for (const d of discounted) { const k = d.createdById ?? '-'; const u = byUser.get(k) ?? { name: who(d.createdById), invoices: 0, discount: 0, subtotal: 0 }; u.invoices++; u.discount = r3(u.discount + num(d.discountTotal)); u.subtotal = r3(u.subtotal + num(d.subtotal)); byUser.set(k, u); }
  res.json({
    cancelled: cancelled.map((c) => ({ ...c, total: num(c.total), patient: c.patient.fullName, cancelledBy: who(c.cancelledById), createdBy: who(c.createdById) })),
    voided: voided.map((v) => ({ ...v, amount: num(v.amount), method: v.method.name, patient: v.patient.fullName, invoiceNumber: v.invoice.invoiceNumber, voidedBy: who(v.voidedById), receivedBy: who(v.receivedById) })),
    discountsByUser: [...byUser.values()].map((u) => ({ ...u, percent: u.subtotal ? Math.round((u.discount / u.subtotal) * 1000) / 10 : 0 })).sort((a, b) => b.discount - a.discount),
    discounts: discounted.slice(0, 300).map((d) => ({ ...d, subtotal: num(d.subtotal), discountTotal: num(d.discountTotal), patient: d.patient.fullName, by: who(d.createdById) })),
    backdated: backdated.map((b) => ({ ...b, total: num(b.total), by: who(b.createdById), days: Math.round((new Date(ymd(b.issuedRecordedAt)).getTime() - new Date(ymd(b.issuedAt)).getTime()) / 86_400_000) })),
    totals: { cancelled: cancelled.length, cancelledAmount: r3(cancelled.reduce((t, c) => t + num(c.total), 0)), voided: voided.length, voidedAmount: r3(voided.reduce((t, v) => t + num(v.amount), 0)), discount: r3(discounted.reduce((t, d) => t + num(d.discountTotal), 0)), backdated: backdated.length },
  });
}));

// ── Appointments: kept, missed, cancelled ──
extraReportsRouter.get('/appointments', requirePerm('reports.patients'), ah(async (req, res) => {
  const q = parse(q0, req.query);
  const { from, to } = rangeFromQuery(q.from, q.to);
  const appts = await prisma.appointment.findMany({ where: { startAt: { gte: from, lte: to }, ...(q.doctorId && { doctorId: q.doctorId }) }, select: { status: true, startAt: true, doctorId: true, doctor: { select: { fullName: true } } } });
  const byStatus: Record<string, number> = {};
  const byDoctor = new Map<string, { name: string; total: number; attended: number; noShow: number; cancelled: number }>();
  const byDay = new Map<string, { day: string; total: number; attended: number; noShow: number }>();
  const attended = (s: string) => s === 'ARRIVED' || s === 'COMPLETED';
  for (const a of appts) {
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const d = byDoctor.get(a.doctorId) ?? { name: a.doctor.fullName, total: 0, attended: 0, noShow: 0, cancelled: 0 };
    d.total++; if (attended(a.status)) d.attended++; if (a.status === 'NO_SHOW') d.noShow++; if (a.status === 'CANCELLED') d.cancelled++;
    byDoctor.set(a.doctorId, d);
    const k = ymd(a.startAt); const x = byDay.get(k) ?? { day: k, total: 0, attended: 0, noShow: 0 };
    x.total++; if (attended(a.status)) x.attended++; if (a.status === 'NO_SHOW') x.noShow++; byDay.set(k, x);
  }
  const past = appts.filter((a) => a.status !== 'CANCELLED' && a.startAt.getTime() < Date.now());
  res.json({
    total: appts.length, byStatus,
    attendanceRate: past.length ? Math.round((past.filter((a) => attended(a.status)).length / past.length) * 1000) / 10 : null,
    noShowRate: past.length ? Math.round((past.filter((a) => a.status === 'NO_SHOW').length / past.length) * 1000) / 10 : null,
    byDoctor: [...byDoctor.values()].sort((a, b) => b.total - a.total), byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  });
}));

// ── Waiting times and busy hours ──
extraReportsRouter.get('/operations', requirePerm('reports.patients'), ah(async (req, res) => {
  const q = parse(q0, req.query);
  const where = Prisma.sql`v."queueDate" BETWEEN ${dateOnly(q.from)} AND ${dateOnly(q.to)} AND v.status NOT IN ('CANCELLED','NO_SHOW') ${q.doctorId ? Prisma.sql`AND v."doctorId" = ${q.doctorId}` : Prisma.empty}`;
  const mins = (a: string, b: string) => Prisma.sql`AVG(EXTRACT(EPOCH FROM (v.${Prisma.raw(`"${b}"`)} - v.${Prisma.raw(`"${a}"`)})) / 60) FILTER (WHERE v.${Prisma.raw(`"${b}"`)} IS NOT NULL AND v.${Prisma.raw(`"${b}"`)} >= v.${Prisma.raw(`"${a}"`)})`;
  const [[avg], heat, byDoctor] = await Promise.all([
    prisma.$queryRaw<{ visits: bigint; toCall: number | null; toDoctor: number | null; withDoctor: number | null; total: number | null }[]>`
      SELECT COUNT(*) AS visits, ${mins('arrivedAt', 'calledAt')} AS "toCall", ${mins('arrivedAt', 'doctorStartedAt')} AS "toDoctor", ${mins('doctorStartedAt', 'completedAt')} AS "withDoctor", ${mins('arrivedAt', 'completedAt')} AS total FROM visits v WHERE ${where}`,
    prisma.$queryRaw<{ dow: number; hour: number; n: bigint }[]>`
      SELECT EXTRACT(DOW FROM ${LOCAL(Prisma.sql`v."arrivedAt"`)})::int AS dow, EXTRACT(HOUR FROM ${LOCAL(Prisma.sql`v."arrivedAt"`)})::int AS hour, COUNT(*) AS n FROM visits v WHERE ${where} GROUP BY 1, 2`,
    prisma.$queryRaw<{ name: string | null; visits: bigint; toDoctor: number | null; withDoctor: number | null }[]>`
      SELECT u."fullName" AS name, COUNT(*) AS visits, ${mins('arrivedAt', 'doctorStartedAt')} AS "toDoctor", ${mins('doctorStartedAt', 'completedAt')} AS "withDoctor" FROM visits v LEFT JOIN users u ON u.id = v."doctorId" WHERE ${where} GROUP BY u."fullName" ORDER BY visits DESC`,
  ]);
  const m = (v: number | null) => (v == null ? null : Math.round(Number(v)));
  const hours = new Map<number, number>(), days = new Map<number, number>();
  for (const h of heat) { hours.set(h.hour, (hours.get(h.hour) ?? 0) + Number(h.n)); days.set(h.dow, (days.get(h.dow) ?? 0) + Number(h.n)); }
  res.json({
    visits: Number(avg?.visits ?? 0), avg: { toCall: m(avg?.toCall ?? null), toDoctor: m(avg?.toDoctor ?? null), withDoctor: m(avg?.withDoctor ?? null), total: m(avg?.total ?? null) },
    heat: heat.map((h) => ({ dow: h.dow, hour: h.hour, n: Number(h.n) })),
    byHour: [...hours].sort((a, b) => a[0] - b[0]).map(([hour, n]) => ({ hour: `${String(hour).padStart(2, '0')}:00`, n })),
    byWeekday: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dow: d, n: days.get(d) ?? 0 })),
    byDoctor: byDoctor.map((d) => ({ name: d.name ?? '—', visits: Number(d.visits), toDoctor: m(d.toDoctor), withDoctor: m(d.withDoctor) })),
  });
}));

// ── Lab activity: volume, most requested tests, turnaround ──
extraReportsRouter.get('/lab', requirePerm('reports.patients'), ah(async (req, res) => {
  const q = parse(q0, req.query);
  const { from, to } = rangeFromQuery(q.from, q.to);
  const orders = await prisma.labOrder.findMany({ where: { requestedAt: { gte: from, lte: to }, ...(q.doctorId && { doctorId: q.doctorId }) }, select: { status: true, priority: true, requestedAt: true, collectedAt: true, completedAt: true, doctorId: true, doctor: { select: { fullName: true } }, items: { select: { testName: true, labTestId: true, results: { select: { flag: true } } } } } });
  const byStatus: Record<string, number> = {};
  const tests = new Map<string, { name: string; count: number; abnormal: number }>();
  const doctors = new Map<string, { name: string; orders: number; tests: number }>();
  const tat: number[] = [];
  let critical = 0;
  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    if (o.completedAt) tat.push((o.completedAt.getTime() - o.requestedAt.getTime()) / 3_600_000);
    const d = doctors.get(o.doctorId) ?? { name: o.doctor.fullName, orders: 0, tests: 0 }; d.orders++; d.tests += o.items.length; doctors.set(o.doctorId, d);
    if (o.status === 'CANCELLED') continue;
    for (const i of o.items) {
      const t = tests.get(i.labTestId) ?? { name: i.testName, count: 0, abnormal: 0 }; t.count++;
      if (i.results.some((r) => r.flag && r.flag !== 'NORMAL')) t.abnormal++;
      if (i.results.some((r) => r.flag === 'CRITICAL')) critical++;
      tests.set(i.labTestId, t);
    }
  }
  tat.sort((a, b) => a - b);
  res.json({
    orders: orders.length, tests: [...tests.values()].reduce((t, x) => t + x.count, 0), byStatus, critical,
    turnaroundHours: tat.length ? { avg: Math.round((tat.reduce((a, b) => a + b, 0) / tat.length) * 10) / 10, median: Math.round(tat[Math.floor(tat.length / 2)] * 10) / 10, max: Math.round(tat[tat.length - 1] * 10) / 10 } : null,
    urgent: orders.filter((o) => o.priority !== 'NORMAL').length,
    topTests: [...tests.values()].sort((a, b) => b.count - a.count).slice(0, 30), byDoctor: [...doctors.values()].sort((a, b) => b.tests - a.tests),
  });
}));

// ── Expenses in detail ──
extraReportsRouter.get('/expenses', requirePerm('reports.financial'), ah(async (req, res) => {
  const q = parse(q0.extend({ categoryId: z.string().uuid().optional() }), req.query);
  const [rows, supplierPays] = await Promise.all([
    prisma.expense.findMany({ where: { voidedAt: null, expenseDate: { gte: dateOnly(q.from), lte: dateOnly(q.to) }, ...(q.categoryId && { categoryId: q.categoryId }) }, include: { category: { select: { name: true } }, paymentMethod: { select: { name: true } }, supplier: { select: { name: true } } }, orderBy: { expenseDate: 'asc' }, take: 5000 }),
    q.categoryId ? Promise.resolve([]) : prisma.supplierPayment.findMany({ where: { voidedAt: null, paidAt: { gte: rangeFromQuery(q.from, q.to).from, lte: rangeFromQuery(q.from, q.to).to } }, include: { supplier: { select: { name: true } }, method: { select: { name: true } } }, orderBy: { paidAt: 'asc' } }),
  ]);
  const who = await names(rows.map((r) => r.createdById));
  const byCat = new Map<string, number>(), byMonth = new Map<string, number>(), byMethod = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, r3((m.get(k) ?? 0) + v));
  for (const e of rows) { add(byCat, e.category.name, num(e.amount)); add(byMonth, ymd(e.expenseDate).slice(0, 7), num(e.amount)); add(byMethod, e.paymentMethod?.name ?? '—', num(e.amount)); }
  for (const p of supplierPays) { add(byCat, 'دفعات الموردين', num(p.amount)); add(byMonth, ymd(p.paidAt).slice(0, 7), num(p.amount)); add(byMethod, p.method?.name ?? '—', num(p.amount)); }
  const list = [
    ...rows.map((e) => ({ id: e.id, date: ymd(e.expenseDate), category: e.category.name, description: e.description, amount: num(e.amount), method: e.paymentMethod?.name ?? '—', supplier: e.supplier?.name ?? null, reference: e.reference, by: who(e.createdById) })),
    ...supplierPays.map((p) => ({ id: p.id, date: ymd(p.paidAt), category: 'دفعات الموردين', description: p.notes ?? `دفعة للمورد ${p.supplier.name}`, amount: num(p.amount), method: p.method?.name ?? '—', supplier: p.supplier.name, reference: p.reference, by: '—' })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const sorted = (m: Map<string, number>) => [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  res.json({ rows: list, total: r3(list.reduce((t, r) => t + r.amount, 0)), byCategory: sorted(byCat), byMethod: sorted(byMethod), byMonth: [...byMonth].sort().map(([month, amount]) => ({ month, amount })) });
}));
