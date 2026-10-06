import { Router } from 'express';
import { z } from 'zod';
import { ClaimStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, optionalDate, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { rangeFromQuery } from '../../lib/dates';
import { D, num } from '../../lib/money';
import {
  addNote, closeClaim, markReady, markResubmissionRequired, markUnderReview, recordCompanyPayment, recordDecision,
  resubmitClaim, submitClaim, transferToPatient, voidCompanyPayment, writeOff,
} from './claims';

export const claimsRouter = Router();
export const insurancePaymentsRouter = Router();
export const insuranceReportsRouter = Router();

const listInclude = {
  patient: { select: { id: true, fullName: true, phone: true, fileNumber: true } },
  company: { select: { id: true, nameAr: true } },
  contract: { select: { id: true, name: true } },
  invoice: { select: { id: true, invoiceNumber: true, issuedAt: true } },
} satisfies Prisma.InsuranceClaimInclude;

// ───────────── Claims ─────────────

claimsRouter.get(
  '/',
  requirePerm('insurance.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({
      status: z.string().optional(), companyId: z.string().uuid().optional(), patientId: z.string().uuid().optional(),
      open: z.enum(['true', 'false']).optional(), from: z.string().optional(), to: z.string().optional(),
    }), req.query);
    const statuses = q.status?.split(',').filter((s): s is ClaimStatus => (Object.values(ClaimStatus) as string[]).includes(s));
    const where: Prisma.InsuranceClaimWhereInput = {
      ...(statuses?.length && { status: { in: statuses } }),
      ...(q.companyId && { companyId: q.companyId }),
      ...(q.patientId && { patientId: q.patientId }),
      ...(q.open === 'true' && { status: { notIn: ['CANCELLED', 'CLOSED'] }, outstandingAmount: { gt: 0 } }),
      ...(q.from && { createdAt: (({ from, to }) => ({ gte: from, lte: to }))(rangeFromQuery(q.from, q.to)) }),
      ...(q.q && { OR: [{ claimNumber: { contains: q.q, mode: 'insensitive' } }, { memberId: { contains: q.q } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { invoice: { invoiceNumber: { contains: q.q, mode: 'insensitive' } } }] }),
    };
    const [items, total, sums] = await Promise.all([
      prisma.insuranceClaim.findMany({ where, include: listInclude, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
      prisma.insuranceClaim.count({ where }),
      prisma.insuranceClaim.aggregate({ where: { ...where, status: where.status ?? { not: 'CANCELLED' } }, _sum: { insuranceAmount: true, approvedAmount: true, rejectedAmount: true, paidAmount: true, outstandingAmount: true } }),
    ]);
    res.json({ ...paged(items, total, q), sums: sums._sum });
  }),
);

claimsRouter.get(
  '/:id',
  requirePerm('insurance.view'),
  ah(async (req, res) => {
    const c = await prisma.insuranceClaim.findUnique({
      where: { id: req.params.id },
      include: {
        ...listInclude,
        patientInsurance: { select: { id: true, memberId: true, cardNumber: true, policyNumber: true, subscriberName: true, relation: true, endDate: true } },
        visit: { select: { id: true, visitNumber: true, arrivedAt: true, medicalReports: { select: { id: true, title: true } }, prescriptions: { select: { id: true } } } },
        invoice: { select: { id: true, invoiceNumber: true, issuedAt: true, total: true, patientShare: true, insuranceShare: true, discountTotal: true, balance: true, status: true } },
        items: { include: { invoiceItem: { select: { coverageNote: true, coveragePercent: true, authorization: { select: { requestNumber: true, approvalNumber: true } } } }, service: { select: { insRequiresReport: true } } } },
        events: { orderBy: { createdAt: 'asc' } },
        allocations: { include: { payment: { select: { id: true, receiptNumber: true, paidAt: true, voidedAt: true, reference: true } } } },
        attachments: { where: { deletedAt: null } },
      },
    });
    if (!c) throw notFound('المطالبة غير موجودة');
    const doctor = c.doctorId ? await prisma.user.findUnique({ where: { id: c.doctorId }, select: { fullName: true, specialty: true } }) : null;
    // Documents the company may ask for.
    const rules = await prisma.insuranceCoverageRule.findMany({ where: { contractId: c.contractId, requiresReport: true } });
    const needsReport = c.items.some((i) => i.service.insRequiresReport || rules.some((r) => r.serviceId === i.serviceId));
    const checks = [
      { key: 'diagnosis', ok: !!c.diagnosis },
      ...(needsReport ? [{ key: 'report', ok: (c.visit?.medicalReports.length ?? 0) > 0 || (c.visit?.prescriptions.length ?? 0) > 0 }] : []),
    ];
    res.json({ ...c, doctor, checks });
  }),
);

const notes = z.object({ notes: nullableStr(1000) });
const amountReason = z.object({ amount: z.coerce.number().positive().nullable().optional(), reason: z.string().trim().min(3, 'اذكر السبب').max(500) });
const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn);

claimsRouter.post('/:id/ready', requirePerm('insurance.claim.create'), ah(async (req, res) => {
  const b = parse(notes, req.body); res.json(await run((tx) => markReady(tx, req.ctx, req.params.id, b.notes)));
}));
claimsRouter.post('/:id/submit', requirePerm('insurance.claim.submit'), ah(async (req, res) => {
  const b = parse(notes, req.body); res.json(await run((tx) => submitClaim(tx, req.ctx, req.params.id, b.notes)));
}));
/** Sends several claims at once (e.g. the month's claims of one company). */
claimsRouter.post('/submit-batch', requirePerm('insurance.claim.submit'), ah(async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), notes: nullableStr(1000) }), req.body);
  const done = await run(async (tx) => { const out = []; for (const id of b.ids) out.push(await submitClaim(tx, req.ctx, id, b.notes)); return out; });
  res.json({ submitted: done.length });
}));
claimsRouter.post('/:id/review', requirePerm('insurance.claim.submit'), ah(async (req, res) => {
  const b = parse(notes, req.body); res.json(await run((tx) => markUnderReview(tx, req.ctx, req.params.id, b.notes)));
}));
claimsRouter.post('/:id/decision', requireAnyPerm('insurance.claim.approve', 'insurance.claim.reject'), ah(async (req, res) => {
  const b = parse(z.object({
    items: z.array(z.object({ claimItemId: z.string().uuid(), approved: z.coerce.number().min(0), rejected: z.coerce.number().min(0), reason: nullableStr(500) })).min(1),
    approvalNumber: nullableStr(60), notes: nullableStr(1000),
  }), req.body);
  res.json(await run((tx) => recordDecision(tx, req.ctx, req.params.id, b)));
}));
claimsRouter.post('/:id/resubmission-required', requirePerm('insurance.claim.reject'), ah(async (req, res) => {
  const b = parse(notes, req.body); res.json(await run((tx) => markResubmissionRequired(tx, req.ctx, req.params.id, b.notes)));
}));
claimsRouter.post('/:id/resubmit', requirePerm('insurance.claim.resubmit'), ah(async (req, res) => {
  const b = parse(z.object({ amount: z.coerce.number().positive().nullable().optional(), notes: nullableStr(1000) }), req.body);
  res.json(await run((tx) => resubmitClaim(tx, req.ctx, req.params.id, b.amount, b.notes)));
}));
claimsRouter.post('/:id/transfer', requirePerm('insurance.claim.reject'), ah(async (req, res) => {
  const b = parse(amountReason, req.body); res.json(await run((tx) => transferToPatient(tx, req.ctx, req.params.id, b.amount, b.reason)));
}));
claimsRouter.post('/:id/write-off', requirePerm('insurance.claim.reject'), ah(async (req, res) => {
  const b = parse(amountReason.extend({ source: z.enum(['REJECTED', 'APPROVED_UNPAID']).default('REJECTED') }), req.body);
  res.json(await run((tx) => writeOff(tx, req.ctx, req.params.id, b.source, b.amount, b.reason)));
}));
claimsRouter.post('/:id/close', requireAnyPerm('insurance.claim.approve', 'insurance.claim.reject'), ah(async (req, res) => {
  const b = parse(notes, req.body); res.json(await run((tx) => closeClaim(tx, req.ctx, req.params.id, b.notes)));
}));
claimsRouter.post('/:id/notes', requireAnyPerm('insurance.claim.create', 'insurance.claim.submit', 'insurance.claim.approve', 'insurance.claim.reject'), ah(async (req, res) => {
  const b = parse(z.object({ notes: z.string().trim().min(2).max(1000) }), req.body);
  await run((tx) => addNote(tx, req.ctx, req.params.id, b.notes));
  res.status(201).json({ ok: true });
}));

// ───────────── Company payments ─────────────

insurancePaymentsRouter.get(
  '/',
  requirePerm('insurance.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ companyId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional() }), req.query);
    const where: Prisma.InsurancePaymentWhereInput = {
      ...(q.companyId && { companyId: q.companyId }),
      ...(q.from && { paidAt: (({ from, to }) => ({ gte: from, lte: to }))(rangeFromQuery(q.from, q.to)) }),
      ...(q.q && { OR: [{ receiptNumber: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q } }] }),
    };
    const [items, total, sum] = await Promise.all([
      prisma.insurancePayment.findMany({ where, orderBy: { paidAt: 'desc' }, ...paginate(q), include: { company: { select: { nameAr: true } }, method: { select: { name: true } }, _count: { select: { allocations: true } } } }),
      prisma.insurancePayment.count({ where }),
      prisma.insurancePayment.aggregate({ where: { ...where, voidedAt: null }, _sum: { amount: true } }),
    ]);
    res.json({ ...paged(items, total, q), sum: sum._sum.amount ?? 0 });
  }),
);

insurancePaymentsRouter.get(
  '/:id',
  requirePerm('insurance.view'),
  ah(async (req, res) => {
    const p = await prisma.insurancePayment.findUnique({
      where: { id: req.params.id },
      include: { company: true, method: true, allocations: { include: { claim: { select: { id: true, claimNumber: true, patient: { select: { fullName: true } }, invoice: { select: { invoiceNumber: true } } } } } } },
    });
    if (!p) throw notFound();
    const users = await prisma.user.findMany({ where: { id: { in: [p.receivedById, p.voidedById].filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
    res.json({ ...p, userNames: Object.fromEntries(users.map((u) => [u.id, u.fullName])) });
  }),
);

insurancePaymentsRouter.post(
  '/',
  requirePerm('insurance.payment.create'),
  ah(async (req, res) => {
    const b = parse(z.object({
      companyId: z.string().uuid('اختر شركة التأمين'), methodId: z.string().uuid('اختر طريقة الدفع'), reference: nullableStr(100), notes: nullableStr(1000), paidAt: optionalDate,
      allocations: z.array(z.object({ claimId: z.string().uuid(), amount: z.coerce.number().min(0) })).min(1).max(1000),
    }), req.body);
    const p = await run((tx) => recordCompanyPayment(tx, req.ctx, b));
    res.status(201).json(p);
  }),
);

insurancePaymentsRouter.post(
  '/:id/void',
  requirePerm('insurance.payment.void'),
  ah(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'اذكر السبب').max(300) }), req.body);
    await run((tx) => voidCompanyPayment(tx, req.ctx, req.params.id, reason));
    res.json({ ok: true });
  }),
);

// ───────────── Dashboard & reports ─────────────

const period = z.object({ from: z.string().optional(), to: z.string().optional(), companyId: z.string().uuid().optional() });
const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };

/** Totals for a period, used by the insurance dashboard and the financial reports. */
export async function insuranceTotals(from: Date, to: Date, companyId?: string) {
  const company = companyId ? Prisma.sql`AND c."companyId" = ${companyId}` : Prisma.empty;
  const [billed, events, received, outstanding] = await Promise.all([
    prisma.insuranceClaim.aggregate({ where: { createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' }, ...(companyId && { companyId }) }, _sum: { insuranceAmount: true }, _count: true }),
    prisma.$queryRaw<{ approved: Prisma.Decimal; rejected: Prisma.Decimal; transferred: Prisma.Decimal; written_off: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(e."dApproved"),0) AS approved, COALESCE(SUM(CASE WHEN e.type = 'DECISION' THEN e."dRejected" END),0) AS rejected,
             COALESCE(SUM(e."dTransferred"),0) AS transferred, COALESCE(SUM(e."dWrittenOff"),0) AS written_off
      FROM insurance_claim_events e JOIN insurance_claims c ON c.id = e."claimId"
      WHERE e."voidedAt" IS NULL AND e."createdAt" BETWEEN ${from} AND ${to} ${company}`,
    prisma.insurancePayment.aggregate({ where: { voidedAt: null, paidAt: { gte: from, lte: to }, ...(companyId && { companyId }) }, _sum: { amount: true }, _count: true }),
    prisma.insuranceClaim.aggregate({ where: { status: { not: 'CANCELLED' }, ...(companyId && { companyId }) }, _sum: { outstandingAmount: true } }),
  ]);
  const e = events[0];
  return {
    billed: num(billed._sum.insuranceAmount), claimsCount: billed._count,
    approved: num(e?.approved), rejected: num(e?.rejected), transferred: num(e?.transferred), writtenOff: num(e?.written_off),
    received: num(received._sum.amount), paymentsCount: received._count, outstanding: num(outstanding._sum.outstandingAmount),
  };
}

insuranceReportsRouter.get(
  '/dashboard',
  requirePerm('insurance.report.view'),
  ah(async (req, res) => {
    const q = parse(period, req.query);
    const { from, to } = rangeFromQuery(q.from ?? monthStart(), q.to ?? new Date().toISOString().slice(0, 10));
    const today = new Date(new Date().toISOString().slice(0, 10));
    const [totals, insured, visits, byStatus, collection, byCompany, expiring] = await Promise.all([
      insuranceTotals(from, to, q.companyId),
      prisma.patientInsurance.findMany({
        where: { deletedAt: null, status: 'ACTIVE', OR: [{ endDate: null }, { endDate: { gte: today } }], ...(q.companyId && { companyId: q.companyId }) },
        distinct: ['patientId'], select: { patientId: true },
      }),
      prisma.visit.count({ where: { payerType: 'INSURANCE', arrivedAt: { gte: from, lte: to }, status: { not: 'CANCELLED' }, ...(q.companyId && { insuranceCompanyId: q.companyId }) } }),
      prisma.insuranceClaim.groupBy({ by: ['status'], where: { ...(q.companyId && { companyId: q.companyId }) }, _count: true, _sum: { insuranceAmount: true, outstandingAmount: true } }),
      prisma.$queryRaw<{ days: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM (c."lastPaymentAt" - COALESCE(c."submittedAt", c."createdAt"))) / 86400)::float AS days
        FROM insurance_claims c WHERE c.status IN ('PAID','CLOSED') AND c."paidAmount" > 0 AND c."lastPaymentAt" BETWEEN ${from} AND ${to}
        ${q.companyId ? Prisma.sql`AND c."companyId" = ${q.companyId}` : Prisma.empty}`,
      prisma.insuranceClaim.groupBy({ by: ['companyId'], where: { status: { not: 'CANCELLED' } }, _sum: { outstandingAmount: true, insuranceAmount: true, paidAmount: true, rejectedAmount: true } }),
      prisma.patientInsurance.count({ where: { deletedAt: null, status: 'ACTIVE', endDate: { gte: today, lte: new Date(today.getTime() + 30 * 86_400_000) } } }),
    ]);
    const companies = await prisma.insuranceCompany.findMany({ where: { id: { in: byCompany.map((b) => b.companyId) } }, select: { id: true, nameAr: true } });
    const decided = totals.approved + totals.rejected;
    const count = (s: ClaimStatus[]) => byStatus.filter((b) => s.includes(b.status)).reduce((t, b) => t + b._count, 0);
    res.json({
      period: { from, to },
      insuredPatients: insured.length, insuredVisits: visits, expiringSoon: expiring,
      claims: {
        total: byStatus.filter((b) => b.status !== 'CANCELLED').reduce((t, b) => t + b._count, 0),
        pending: count(['DRAFT', 'READY', 'SUBMITTED', 'UNDER_REVIEW', 'RESUBMISSION_REQUIRED']),
        approved: count(['APPROVED', 'PARTIALLY_APPROVED', 'PARTIALLY_PAID']),
        rejected: count(['REJECTED']),
        paid: count(['PAID', 'CLOSED']),
        byStatus: byStatus.map((b) => ({ status: b.status, count: b._count, amount: num(b._sum.insuranceAmount), outstanding: num(b._sum.outstandingAmount) })),
      },
      totals,
      rejectionRate: decided > 0 ? Math.round((totals.rejected / decided) * 1000) / 10 : 0,
      avgCollectionDays: collection[0]?.days != null ? Math.round(collection[0].days * 10) / 10 : null,
      byCompany: byCompany.map((b) => ({ companyId: b.companyId, name: companies.find((c) => c.id === b.companyId)?.nameAr ?? '', outstanding: num(b._sum.outstandingAmount), billed: num(b._sum.insuranceAmount), paid: num(b._sum.paidAmount), rejected: num(b._sum.rejectedAmount) }))
        .sort((a, b) => b.outstanding - a.outstanding),
    });
  }),
);

const BUCKETS = [
  { key: 'current', min: 0, max: 29 }, { key: 'd30', min: 30, max: 59 }, { key: 'd60', min: 60, max: 89 }, { key: 'd90', min: 90, max: 119 }, { key: 'd120', min: 120, max: Infinity },
] as const;

/** Insurance receivables per claim, aged from the submission date (or the claim date if never submitted). */
insuranceReportsRouter.get(
  '/receivables',
  requirePerm('insurance.report.view'),
  ah(async (req, res) => {
    const q = parse(period.pick({ companyId: true }), req.query);
    const claims = await prisma.insuranceClaim.findMany({
      where: { status: { notIn: ['CANCELLED'] }, outstandingAmount: { gt: 0 }, ...(q.companyId && { companyId: q.companyId }) },
      orderBy: [{ companyId: 'asc' }, { createdAt: 'asc' }], include: listInclude,
    });
    const now = Date.now();
    const rows = claims.map((c) => {
      const since = c.submittedAt ?? c.createdAt;
      const age = Math.floor((now - since.getTime()) / 86_400_000);
      return {
        id: c.id, claimNumber: c.claimNumber, status: c.status, company: c.company, patient: c.patient, invoice: c.invoice, claimDate: c.createdAt, submittedAt: c.submittedAt,
        amount: num(c.insuranceAmount), approved: num(c.approvedAmount), paid: num(c.paidAmount), rejected: num(c.rejectedAmount), outstanding: num(c.outstandingAmount),
        ageDays: age, bucket: BUCKETS.find((b) => age >= b.min && age <= b.max)!.key,
      };
    });
    const buckets = Object.fromEntries(BUCKETS.map((b) => [b.key, rows.filter((r) => r.bucket === b.key).reduce((t, r) => t + r.outstanding, 0)]));
    res.json({ rows, buckets, total: rows.reduce((t, r) => t + r.outstanding, 0) });
  }),
);

/** Every rejection the companies made, with reason, date, who recorded it, and whether it was resubmitted. */
insuranceReportsRouter.get(
  '/rejected',
  requirePerm('insurance.report.view'),
  ah(async (req, res) => {
    const q = parse(period, req.query);
    const { from, to } = rangeFromQuery(q.from ?? monthStart(), q.to ?? new Date().toISOString().slice(0, 10));
    const events = await prisma.insuranceClaimEvent.findMany({
      where: { type: 'DECISION', dRejected: { gt: 0 }, voidedAt: null, createdAt: { gte: from, lte: to }, ...(q.companyId && { claim: { companyId: q.companyId } }) },
      orderBy: { createdAt: 'desc' },
      include: { claim: { include: { ...listInclude, events: { where: { type: { in: ['RESUBMITTED', 'TRANSFER_TO_PATIENT', 'WRITE_OFF'] }, voidedAt: null }, select: { type: true, createdAt: true, dTransferred: true, dWrittenOff: true, dSubmitted: true } } } } },
    });
    const rows = events.map((e) => {
      const later = e.claim.events.filter((x) => x.createdAt > e.createdAt);
      const resolution = later.some((x) => x.type === 'RESUBMITTED') ? 'RESUBMITTED' : later.some((x) => x.type === 'TRANSFER_TO_PATIENT') ? 'TRANSFERRED' : later.some((x) => x.type === 'WRITE_OFF') ? 'WRITTEN_OFF' : 'OPEN';
      return {
        id: e.id, claimId: e.claimId, claimNumber: e.claim.claimNumber, company: e.claim.company, patient: e.claim.patient, claimAmount: num(e.claim.insuranceAmount),
        rejected: num(e.dRejected), reason: e.reason, notes: e.notes, rejectedAt: e.createdAt, userName: e.userName, claimStatus: e.claim.status, resolution,
      };
    });
    res.json({ rows, total: rows.reduce((t, r) => t + r.rejected, 0) });
  }),
);

/**
 * Statement of a company's account for a period:
 * opening balance + claims − rejected (+ resubmitted) − written off − cancelled − payments = closing balance.
 * Transfers to the patient move an already-rejected amount and do not change the balance.
 */
insuranceReportsRouter.get(
  '/companies/:id/account',
  requirePerm('insurance.report.view'),
  ah(async (req, res) => {
    const q = parse(period.pick({ from: true, to: true }), req.query);
    const company = await prisma.insuranceCompany.findUnique({ where: { id: req.params.id } });
    if (!company) throw notFound();
    const { from, to } = rangeFromQuery(q.from ?? monthStart(), q.to ?? new Date().toISOString().slice(0, 10));
    const sumClaims = async (gte?: Date, lte?: Date) => D((await prisma.insuranceClaim.aggregate({ where: { companyId: company.id, createdAt: { ...(gte && { gte }), ...(lte && { lte }) } }, _sum: { insuranceAmount: true } }))._sum.insuranceAmount);
    const sumEvents = async (gte?: Date, lte?: Date) => (await prisma.insuranceClaimEvent.aggregate({
      where: { voidedAt: null, claim: { companyId: company.id }, createdAt: { ...(gte && { gte }), ...(lte && { lte }) } },
      _sum: { dApproved: true, dRejected: true, dTransferred: true, dWrittenOff: true, dPaid: true, dCancelled: true, dSubmitted: true },
    }))._sum;
    const decisionsRejected = async (gte: Date, lte: Date) => D((await prisma.insuranceClaimEvent.aggregate({ where: { voidedAt: null, type: 'DECISION', claim: { companyId: company.id }, createdAt: { gte, lte } }, _sum: { dRejected: true } }))._sum.dRejected);
    const resubmitted = async (gte: Date, lte: Date) => D((await prisma.insuranceClaimEvent.aggregate({ where: { voidedAt: null, type: 'RESUBMITTED', claim: { companyId: company.id }, createdAt: { gte, lte } }, _sum: { dSubmitted: true } }))._sum.dSubmitted);
    const effect = (s: Awaited<ReturnType<typeof sumEvents>>) => D(s.dRejected).add(D(s.dTransferred)).add(D(s.dWrittenOff)).add(D(s.dPaid)).add(D(s.dCancelled)).neg();

    const beforeClaims = await sumClaims(undefined, new Date(from.getTime() - 1));
    const beforeEvents = await sumEvents(undefined, new Date(from.getTime() - 1));
    const opening = D(company.openingBalance).add(beforeClaims).add(effect(beforeEvents));
    const claims = await sumClaims(from, to);
    const ev = await sumEvents(from, to);
    const rejected = await decisionsRejected(from, to);
    const resub = await resubmitted(from, to);
    const writtenOffFromApproved = D((await prisma.insuranceClaimEvent.aggregate({ where: { voidedAt: null, type: 'WRITE_OFF', dApproved: { lt: 0 }, claim: { companyId: company.id }, createdAt: { gte: from, lte: to } }, _sum: { dWrittenOff: true } }))._sum.dWrittenOff);
    const closing = opening.add(claims).add(effect(ev));

    const ledger = await prisma.insuranceClaimEvent.findMany({
      where: { voidedAt: null, claim: { companyId: company.id }, createdAt: { gte: from, lte: to }, type: { in: ['CREATED', 'DECISION', 'RESUBMITTED', 'PAYMENT', 'WRITE_OFF', 'CANCELLED', 'TRANSFER_TO_PATIENT'] } },
      orderBy: { createdAt: 'asc' },
      include: { claim: { select: { id: true, claimNumber: true, insuranceAmount: true, patient: { select: { fullName: true } } } } },
    });
    res.json({
      company: { id: company.id, nameAr: company.nameAr, nameEn: company.nameEn },
      period: { from, to },
      openingBalance: opening.toNumber(),
      claimsSubmitted: claims.toNumber(),
      approved: num(ev.dApproved),
      rejected: rejected.toNumber(),
      resubmitted: resub.toNumber(),
      transferredToPatients: num(ev.dTransferred),
      writtenOff: D(ev.dWrittenOff).toNumber(),
      writtenOffFromApproved: writtenOffFromApproved.toNumber(),
      cancelled: num(ev.dCancelled),
      payments: num(ev.dPaid),
      closingBalance: closing.toNumber(),
      ledger: ledger.map((e) => ({
        id: e.id, date: e.createdAt, type: e.type, claimId: e.claim.id, claimNumber: e.claim.claimNumber, patient: e.claim.patient.fullName, notes: e.notes, reason: e.reason,
        effect: e.type === 'CREATED' ? num(e.claim.insuranceAmount) : D(e.dRejected).add(e.dTransferred).add(e.dWrittenOff).add(e.dPaid).add(e.dCancelled).neg().toNumber(),
        approved: num(e.dApproved),
      })).filter((r) => r.effect !== 0 || r.approved !== 0),
    });
  }),
);

