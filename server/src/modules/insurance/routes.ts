import { Router } from 'express';
import { z } from 'zod';
import { AuthorizationStatus, InsurancePriority, InsuranceStatus, PayerType, Prisma, ServiceCategory } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, optionalDate, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { nextCounter, pad } from '../../lib/counters';
import { dateOnly } from '../../lib/dates';
import { D } from '../../lib/money';
import type { Ctx } from '../../auth/context';
import { annualUsage, daysToExpiry, effectiveStatus, usableMembership } from './coverage';

export const insuranceRouter = Router();

const money = (max = 1_000_000) => z.coerce.number().min(0).max(max);
const pct = z.coerce.number().min(0, 'النسبة بين 0 و 100').max(100, 'النسبة بين 0 و 100');
const optMoney = z.preprocess((v) => (v === '' || v === undefined ? null : v), money().nullable());
const optPct = z.preprocess((v) => (v === '' || v === undefined ? null : v), pct.nullable());
const dateOnlyOpt = optionalDate.transform((v) => (v ? dateOnly(v) : v));

// ───────────── Companies ─────────────

const companyBody = z.object({
  code: nullableStr(20),
  nameAr: z.string().trim().min(2, 'اسم الشركة مطلوب').max(150),
  nameEn: nullableStr(150),
  phone: nullableStr(40),
  email: nullableStr(120),
  address: nullableStr(300),
  contactPerson: nullableStr(120),
  contractNumber: nullableStr(60),
  contractStart: dateOnlyOpt,
  contractEnd: dateOnlyOpt,
  openingBalance: money().default(0),
  isActive: z.boolean().default(true),
  notes: nullableStr(1000),
});

insuranceRouter.get(
  '/companies',
  requireAnyPerm('insurance.view', 'insurance.create', 'insurance.update', 'invoices.create', 'queue.manage'),
  ah(async (req, res) => {
    const q = parse(z.object({ active: z.enum(['true', 'false']).optional() }), req.query);
    const companies = await prisma.insuranceCompany.findMany({
      where: q.active === 'true' ? { isActive: true } : {},
      orderBy: { nameAr: 'asc' },
      include: {
        contracts: { orderBy: { name: 'asc' }, select: { id: true, name: true, contractNumber: true, isActive: true, startDate: true, endDate: true, coveragePercent: true, annualLimit: true } },
        _count: { select: { memberships: { where: { deletedAt: null } }, claims: true } },
      },
    });
    const outstanding = await prisma.insuranceClaim.groupBy({ by: ['companyId'], where: { status: { not: 'CANCELLED' } }, _sum: { outstandingAmount: true } });
    res.json(companies.map((c) => ({ ...c, outstanding: D(outstanding.find((o) => o.companyId === c.id)?._sum.outstandingAmount).add(c.openingBalance).toNumber() })));
  }),
);

insuranceRouter.get(
  '/companies/:id',
  requirePerm('insurance.view'),
  ah(async (req, res) => {
    const c = await prisma.insuranceCompany.findUnique({
      where: { id: req.params.id },
      include: { contracts: { orderBy: { name: 'asc' }, include: { rules: { include: { service: { select: { id: true, name: true, code: true, category: true, price: true } } } }, _count: { select: { memberships: { where: { deletedAt: null } } } } } } },
    });
    if (!c) throw notFound('شركة التأمين غير موجودة');
    res.json(c);
  }),
);

insuranceRouter.post(
  '/companies',
  requirePerm('insurance.company.manage'),
  ah(async (req, res) => {
    const body = parse(companyBody, req.body);
    const c = await prisma.$transaction(async (tx) => {
      const code = body.code || `IC-${pad(await nextCounter(tx, 'insurance-company'), 3)}`;
      if (await tx.insuranceCompany.findUnique({ where: { code } })) throw badRequest('رمز الشركة مستخدم');
      const created = await tx.insuranceCompany.create({ data: { ...body, code } });
      await audit(tx, req.ctx, { action: 'insurance.company.create', entityType: 'insurance_company', entityId: created.id, summary: `إضافة شركة التأمين ${created.nameAr}`, after: created });
      return created;
    });
    res.status(201).json(c);
  }),
);

insuranceRouter.put(
  '/companies/:id',
  requirePerm('insurance.company.manage'),
  ah(async (req, res) => {
    const body = parse(companyBody, req.body);
    const c = await prisma.$transaction(async (tx) => {
      const before = await tx.insuranceCompany.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound();
      const code = body.code || before.code;
      if (code !== before.code && (await tx.insuranceCompany.findUnique({ where: { code } }))) throw badRequest('رمز الشركة مستخدم');
      const updated = await tx.insuranceCompany.update({ where: { id: before.id }, data: { ...body, code } });
      await audit(tx, req.ctx, { action: 'insurance.company.update', entityType: 'insurance_company', entityId: before.id, summary: `تعديل شركة التأمين ${updated.nameAr}`, before, after: updated });
      return updated;
    });
    res.json(c);
  }),
);

// ───────────── Contracts & coverage rules ─────────────

const ruleSchema = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  category: z.nativeEnum(ServiceCategory).nullable().optional(),
  covered: z.boolean().default(true),
  coveragePercent: optPct.optional(),
  patientFixed: optMoney.optional(),
  maxAmount: optMoney.optional(),
  price: optMoney.optional(),
  requiresApproval: z.boolean().default(false),
  requiresReport: z.boolean().default(false),
  notes: nullableStr(300),
}).refine((r) => !!r.serviceId !== !!r.category, 'كل قاعدة تخص خدمة واحدة أو تصنيفاً واحداً');

const contractBody = z.object({
  name: z.string().trim().min(2, 'اسم العقد / البرنامج مطلوب').max(150),
  contractNumber: nullableStr(60),
  startDate: dateOnlyOpt,
  endDate: dateOnlyOpt,
  isActive: z.boolean().default(true),
  terms: nullableStr(4000),
  coveragePercent: pct.default(80),
  annualLimit: optMoney.optional(),
  coveredServices: nullableStr(2000),
  excludedServices: nullableStr(2000),
  notes: nullableStr(1000),
  rules: z.array(ruleSchema).max(500).default([]),
}).refine((c) => !c.startDate || !c.endDate || c.endDate >= c.startDate, { message: 'تاريخ النهاية قبل تاريخ البداية', path: ['endDate'] });

function checkRules(rules: z.infer<typeof ruleSchema>[]) {
  const keys = rules.map((r) => r.serviceId ?? `cat:${r.category}`);
  if (new Set(keys).size !== keys.length) throw badRequest('توجد قاعدة تغطية مكررة لنفس الخدمة أو التصنيف');
}

const contractInclude = { rules: { include: { service: { select: { id: true, name: true, code: true, category: true, price: true } } } }, company: { select: { id: true, nameAr: true } } } satisfies Prisma.InsuranceContractInclude;

insuranceRouter.get(
  '/contracts/:id',
  requireAnyPerm('insurance.view', 'insurance.contract.manage'),
  ah(async (req, res) => {
    const c = await prisma.insuranceContract.findUnique({ where: { id: req.params.id }, include: contractInclude });
    if (!c) throw notFound('العقد غير موجود');
    res.json(c);
  }),
);

insuranceRouter.post(
  '/companies/:id/contracts',
  requirePerm('insurance.contract.manage'),
  ah(async (req, res) => {
    const { rules, ...body } = parse(contractBody, req.body);
    checkRules(rules);
    const c = await prisma.$transaction(async (tx) => {
      const company = await tx.insuranceCompany.findUnique({ where: { id: req.params.id } });
      if (!company) throw notFound('شركة التأمين غير موجودة');
      const created = await tx.insuranceContract.create({ data: { ...body, companyId: company.id, rules: { create: rules } }, include: contractInclude });
      await audit(tx, req.ctx, { action: 'insurance.contract.create', entityType: 'insurance_contract', entityId: created.id, summary: `عقد جديد "${created.name}" لشركة ${company.nameAr}`, after: { ...body, rules } });
      return created;
    });
    res.status(201).json(c);
  }),
);

insuranceRouter.put(
  '/contracts/:id',
  requirePerm('insurance.contract.manage'),
  ah(async (req, res) => {
    const { rules, ...body } = parse(contractBody, req.body);
    checkRules(rules);
    const c = await prisma.$transaction(async (tx) => {
      const before = await tx.insuranceContract.findUnique({ where: { id: req.params.id }, include: { rules: true } });
      if (!before) throw notFound();
      await tx.insuranceCoverageRule.deleteMany({ where: { contractId: before.id } });
      const updated = await tx.insuranceContract.update({ where: { id: before.id }, data: { ...body, rules: { create: rules } }, include: contractInclude });
      const plain = (r: { serviceId?: string | null; category?: string | null; covered: boolean; coveragePercent?: unknown; patientFixed?: unknown; maxAmount?: unknown; price?: unknown; requiresApproval: boolean }) =>
        ({ target: r.serviceId ?? r.category, covered: r.covered, pct: r.coveragePercent == null ? null : Number(r.coveragePercent), fixed: r.patientFixed == null ? null : Number(r.patientFixed), max: r.maxAmount == null ? null : Number(r.maxAmount), price: r.price == null ? null : Number(r.price), approval: r.requiresApproval });
      const { rules: oldRules, ...oldContract } = before;
      await audit(tx, req.ctx, {
        action: 'insurance.contract.update', entityType: 'insurance_contract', entityId: before.id, summary: `تعديل العقد "${updated.name}" (${rules.length} قاعدة تغطية)`,
        before: { ...oldContract, rules: oldRules.map(plain) }, after: { ...body, rules: rules.map(plain) },
      });
      return updated;
    });
    res.json(c);
  }),
);

// ───────────── Patient insurance (memberships) ─────────────

const membershipBody = z.object({
  contractId: z.string().uuid('اختر العقد / البرنامج'),
  priority: z.nativeEnum(InsurancePriority).default('PRIMARY'),
  cardNumber: nullableStr(60),
  policyNumber: nullableStr(60),
  memberId: z.string().trim().min(1, 'رقم العضوية مطلوب').max(60),
  subscriberName: nullableStr(150),
  relation: z.enum(['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'OTHER']).default('SELF'),
  startDate: dateOnlyOpt,
  endDate: dateOnlyOpt,
  status: z.nativeEnum(InsuranceStatus).default('ACTIVE'),
  coveragePercent: optPct.optional(),
  annualLimit: optMoney.optional(),
  network: nullableStr(120),
  notes: nullableStr(1000),
}).refine((m) => !m.startDate || !m.endDate || m.endDate >= m.startDate, { message: 'تاريخ الانتهاء قبل تاريخ البداية', path: ['endDate'] });

/** Everything reception needs at a glance about a patient's insurance. */
export async function patientInsuranceSummary(patientId: string) {
  const today = dateOnly();
  const [patient, memberships] = await Promise.all([
    prisma.patient.findFirst({ where: { id: patientId, deletedAt: null }, select: { id: true, fullName: true, payerType: true } }),
    prisma.patientInsurance.findMany({
      where: { patientId, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      include: {
        company: { select: { id: true, nameAr: true, nameEn: true, isActive: true } },
        contract: { select: { id: true, name: true, contractNumber: true, coveragePercent: true, annualLimit: true, isActive: true, endDate: true, coveredServices: true, excludedServices: true } },
        attachments: { where: { deletedAt: null }, select: { id: true, fileName: true, mimeType: true, description: true, createdAt: true } },
      },
    }),
  ]);
  if (!patient) throw notFound('المريض غير موجود');
  const verifierIds = memberships.map((m) => m.verifiedById).filter(Boolean) as string[];
  const verifiers = await prisma.user.findMany({ where: { id: { in: verifierIds } }, select: { id: true, fullName: true } });
  const items = await Promise.all(memberships.map(async (m) => {
    const [usage, lastClaim, lastVisit] = await Promise.all([
      annualUsage(prisma, m),
      prisma.insuranceClaim.findFirst({ where: { patientInsuranceId: m.id }, orderBy: { createdAt: 'desc' }, select: { id: true, claimNumber: true, status: true, insuranceAmount: true, createdAt: true } }),
      prisma.visit.findFirst({ where: { patientInsuranceId: m.id, status: { not: 'CANCELLED' } }, orderBy: { arrivedAt: 'desc' }, select: { id: true, visitNumber: true, arrivedAt: true } }),
    ]);
    const coverage = D(m.coveragePercent ?? m.contract.coveragePercent);
    return {
      ...m, effectiveStatus: effectiveStatus(m, today), daysToExpiry: daysToExpiry(m.endDate, today),
      // Stored overrides (null → the contract's values), for editing.
      ownCoveragePercent: m.coveragePercent, ownAnnualLimit: m.annualLimit,
      coveragePercent: coverage.toNumber(), patientPercent: D(100).sub(coverage).toNumber(),
      annualLimit: usage.limit, used: usage.used, remaining: usage.remaining, periodStart: usage.periodStart,
      lastClaim, lastVisit, verifiedByName: verifiers.find((u) => u.id === m.verifiedById)?.fullName ?? null,
    };
  }));
  const primary = items.find((m) => m.priority === 'PRIMARY') ?? null;
  return { patientId: patient.id, payerType: patient.payerType, memberships: items, primary, active: items.find((m) => m.effectiveStatus === 'ACTIVE') ?? null };
}

insuranceRouter.get(
  '/patients/:patientId',
  requireAnyPerm('insurance.view', 'insurance.create', 'insurance.update'),
  ah(async (req, res) => res.json(await patientInsuranceSummary(req.params.patientId))),
);

insuranceRouter.put(
  '/patients/:patientId/payer-type',
  requirePerm('insurance.update'),
  ah(async (req, res) => {
    const { payerType } = parse(z.object({ payerType: z.nativeEnum(PayerType) }), req.body);
    await prisma.$transaction(async (tx) => {
      const p = await tx.patient.findFirst({ where: { id: req.params.patientId, deletedAt: null } });
      if (!p) throw notFound('المريض غير موجود');
      await tx.patient.update({ where: { id: p.id }, data: { payerType } });
      await audit(tx, req.ctx, { action: 'insurance.patient.payer_type', entityType: 'patient', entityId: p.id, summary: `حالة الدفع للمريض ${p.fullName}`, before: { payerType: p.payerType }, after: { payerType } });
    });
    res.json(await patientInsuranceSummary(req.params.patientId));
  }),
);

/** Only one primary insurance per patient: making one primary turns the others into secondary. */
async function keepSinglePrimary(tx: Prisma.TransactionClient, patientId: string, keepId: string) {
  await tx.patientInsurance.updateMany({ where: { patientId, deletedAt: null, priority: 'PRIMARY', id: { not: keepId } }, data: { priority: 'SECONDARY' } });
}

insuranceRouter.post(
  '/patients/:patientId/memberships',
  requirePerm('insurance.create'),
  ah(async (req, res) => {
    const body = parse(membershipBody, req.body);
    await prisma.$transaction(async (tx) => {
      const p = await tx.patient.findFirst({ where: { id: req.params.patientId, deletedAt: null } });
      if (!p) throw notFound('المريض غير موجود');
      const contract = await tx.insuranceContract.findUnique({ where: { id: body.contractId }, include: { company: true } });
      if (!contract) throw badRequest('العقد غير موجود');
      const count = await tx.patientInsurance.count({ where: { patientId: p.id, deletedAt: null } });
      const m = await tx.patientInsurance.create({ data: { ...body, priority: count === 0 ? 'PRIMARY' : body.priority, patientId: p.id, companyId: contract.companyId, createdById: req.ctx.userId } });
      if (m.priority === 'PRIMARY') await keepSinglePrimary(tx, p.id, m.id);
      if (p.payerType === 'SELF_PAY') await tx.patient.update({ where: { id: p.id }, data: { payerType: 'INSURANCE' } });
      await audit(tx, req.ctx, { action: 'insurance.membership.create', entityType: 'patient_insurance', entityId: m.id, summary: `إضافة تأمين ${contract.company.nameAr} (${contract.name}) للمريض ${p.fullName} — عضوية ${m.memberId}`, after: m });
    });
    res.status(201).json(await patientInsuranceSummary(req.params.patientId));
  }),
);

insuranceRouter.put(
  '/memberships/:id',
  requirePerm('insurance.update'),
  ah(async (req, res) => {
    const body = parse(membershipBody, req.body);
    const patientId = await prisma.$transaction(async (tx) => {
      const before = await tx.patientInsurance.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!before) throw notFound('التأمين غير موجود');
      const contract = await tx.insuranceContract.findUnique({ where: { id: body.contractId } });
      if (!contract) throw badRequest('العقد غير موجود');
      const m = await tx.patientInsurance.update({ where: { id: before.id }, data: { ...body, companyId: contract.companyId } });
      if (m.priority === 'PRIMARY') await keepSinglePrimary(tx, m.patientId, m.id);
      await audit(tx, req.ctx, { action: 'insurance.membership.update', entityType: 'patient_insurance', entityId: m.id, summary: `تعديل تأمين المريض (عضوية ${m.memberId})`, before, after: m });
      return m.patientId;
    });
    res.json(await patientInsuranceSummary(patientId));
  }),
);

/** Records that staff checked the membership with the company today. Returns why it is not usable, if so. */
insuranceRouter.post(
  '/memberships/:id/verify',
  requirePerm('insurance.verify'),
  ah(async (req, res) => {
    const { notes } = parse(z.object({ notes: nullableStr(300) }), req.body);
    const m = await prisma.patientInsurance.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!m) throw notFound('التأمين غير موجود');
    let problem: string | null = null;
    try { await usableMembership(prisma, m.patientId, m.id); } catch (e) { problem = (e as Error).message; }
    await prisma.$transaction(async (tx) => {
      await tx.patientInsurance.update({ where: { id: m.id }, data: { verifiedAt: new Date(), verifiedById: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'insurance.membership.verify', entityType: 'patient_insurance', entityId: m.id, summary: `التحقق من التأمين (عضوية ${m.memberId}): ${problem ?? 'ساري'}${notes ? ` — ${notes}` : ''}` });
    });
    res.json({ valid: !problem, problem, summary: await patientInsuranceSummary(m.patientId) });
  }),
);

insuranceRouter.delete(
  '/memberships/:id',
  requirePerm('insurance.delete'),
  ah(async (req, res) => {
    const patientId = await prisma.$transaction(async (tx) => {
      const m = await tx.patientInsurance.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!m) throw notFound('التأمين غير موجود');
      await tx.patientInsurance.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
      // The next membership becomes primary.
      if (m.priority === 'PRIMARY') {
        const next = await tx.patientInsurance.findFirst({ where: { patientId: m.patientId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.patientInsurance.update({ where: { id: next.id }, data: { priority: 'PRIMARY' } });
      }
      await audit(tx, req.ctx, { action: 'insurance.membership.archive', entityType: 'patient_insurance', entityId: m.id, summary: `أرشفة تأمين المريض (عضوية ${m.memberId}). المطالبات السابقة تبقى كما هي`, before: m });
      return m.patientId;
    });
    res.json(await patientInsuranceSummary(patientId));
  }),
);

/** Memberships expiring soon or already expired while still marked active — for reception alerts. */
insuranceRouter.get(
  '/alerts',
  requireAnyPerm('insurance.view', 'insurance.update'),
  ah(async (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(120).default(30) }), req.query);
    const today = dateOnly();
    const list = await prisma.patientInsurance.findMany({
      where: { deletedAt: null, status: 'ACTIVE', endDate: { not: null, lte: new Date(today.getTime() + q.days * 86_400_000) } },
      orderBy: { endDate: 'asc' }, take: 200,
      include: { patient: { select: { id: true, fullName: true, phone: true } }, company: { select: { nameAr: true } } },
    });
    res.json(list.map((m) => ({ ...m, effectiveStatus: effectiveStatus(m, today), daysToExpiry: daysToExpiry(m.endDate, today) })));
  }),
);

// ───────────── Pre-authorizations ─────────────

const authInclude = {
  patient: { select: { id: true, fullName: true, phone: true, fileNumber: true } },
  company: { select: { id: true, nameAr: true } },
  contract: { select: { id: true, name: true } },
  patientInsurance: { select: { id: true, memberId: true, cardNumber: true } },
  service: { select: { id: true, name: true, code: true, price: true } },
  visit: { select: { id: true, visitNumber: true } },
  _count: { select: { invoiceItems: true } },
} satisfies Prisma.InsuranceAuthorizationInclude;

const authView = <T extends { status: AuthorizationStatus; validUntil: Date | null }>(a: T) => ({
  ...a, effectiveStatus: (a.status === 'APPROVED' || a.status === 'PARTIALLY_APPROVED') && a.validUntil && a.validUntil < dateOnly() ? ('EXPIRED' as const) : a.status,
});

insuranceRouter.get(
  '/authorizations',
  requirePerm('insurance.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ status: z.nativeEnum(AuthorizationStatus).optional(), patientId: z.string().uuid().optional(), visitId: z.string().uuid().optional(), companyId: z.string().uuid().optional() }), req.query);
    const where: Prisma.InsuranceAuthorizationWhereInput = {
      ...(q.status && { status: q.status }), ...(q.patientId && { patientId: q.patientId }), ...(q.visitId && { visitId: q.visitId }), ...(q.companyId && { companyId: q.companyId }),
      ...(q.q && { OR: [{ requestNumber: { contains: q.q, mode: 'insensitive' } }, { approvalNumber: { contains: q.q, mode: 'insensitive' } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { patient: { phone: { contains: q.q } } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.insuranceAuthorization.findMany({ where, include: authInclude, orderBy: { requestedAt: 'desc' }, ...paginate(q) }),
      prisma.insuranceAuthorization.count({ where }),
    ]);
    res.json(paged(items.map(authView), total, q));
  }),
);

const authBody = z.object({
  patientInsuranceId: z.string().uuid('اختر تأمين المريض'),
  visitId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid('اختر الخدمة'),
  quantity: z.coerce.number().positive().max(1000).default(1),
  diagnosis: nullableStr(500),
  reason: nullableStr(1000),
  medicalReportId: z.string().uuid().nullable().optional(),
  notes: nullableStr(1000),
});
const decisionBody = z.object({
  status: z.enum(['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED']),
  approvalNumber: nullableStr(60),
  approvedQuantity: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().positive().nullable().optional()),
  approvedAmount: optMoney.optional(),
  validUntil: dateOnlyOpt,
  rejectReason: nullableStr(500),
  notes: nullableStr(1000),
}).refine((d) => d.status !== 'REJECTED' || !!d.rejectReason, { message: 'اذكر سبب الرفض', path: ['rejectReason'] })
  .refine((d) => d.status === 'REJECTED' || !!d.approvalNumber, { message: 'رقم الموافقة من الشركة مطلوب', path: ['approvalNumber'] });

async function decide(tx: Prisma.TransactionClient, ctx: Ctx, id: string, d: z.infer<typeof decisionBody>) {
  const before = await tx.insuranceAuthorization.findUnique({ where: { id } });
  if (!before) throw notFound();
  if (['CANCELLED'].includes(before.status)) throw badRequest('الطلب ملغى');
  const a = await tx.insuranceAuthorization.update({
    where: { id },
    data: {
      status: d.status, approvalNumber: d.approvalNumber ?? null, approvedQuantity: d.status === 'REJECTED' ? null : (d.approvedQuantity ?? before.quantity),
      approvedAmount: d.status === 'REJECTED' ? null : (d.approvedAmount ?? null), validUntil: d.validUntil ?? null, rejectReason: d.status === 'REJECTED' ? d.rejectReason : null,
      notes: d.notes ?? before.notes, decidedAt: new Date(), decidedById: ctx.userId, submittedAt: before.submittedAt ?? new Date(),
    },
  });
  await audit(tx, ctx, { action: 'insurance.authorization.decide', entityType: 'insurance_authorization', entityId: id, summary: `ردّ الشركة على الطلب ${a.requestNumber}: ${d.status}${d.approvalNumber ? ` (${d.approvalNumber})` : ''}`, before, after: a });
  return a;
}

/** Request a pre-authorization. The company's answer can be recorded in the same step (electronic approvals). */
insuranceRouter.post(
  '/authorizations',
  requirePerm('insurance.authorization.manage'),
  ah(async (req, res) => {
    const body = parse(authBody.extend({ submit: z.boolean().default(false), decision: decisionBody.nullable().optional() }), req.body);
    const id = await prisma.$transaction(async (tx) => {
      const pi = await tx.patientInsurance.findFirst({ where: { id: body.patientInsuranceId, deletedAt: null } });
      if (!pi) throw badRequest('التأمين غير موجود');
      await usableMembership(tx, pi.patientId, pi.id);
      const service = await tx.service.findFirst({ where: { id: body.serviceId, deletedAt: null } });
      if (!service) throw badRequest('الخدمة غير موجودة');
      let doctorId: string | null = null;
      let diagnosis = body.diagnosis ?? null;
      if (body.visitId) {
        const v = await tx.visit.findUnique({ where: { id: body.visitId }, include: { diagnoses: { where: { deletedAt: null } } } });
        if (!v || v.patientId !== pi.patientId) throw badRequest('الزيارة لا تخص هذا المريض');
        doctorId = v.doctorId;
        diagnosis = diagnosis ?? (v.diagnoses.map((d) => [d.icd10Code, d.description].filter(Boolean).join(' — ')).join('؛ ') || null);
      }
      const n = await nextCounter(tx, 'insurance-authorization');
      const a = await tx.insuranceAuthorization.create({
        data: {
          requestNumber: `PA-${pad(n, 6)}`, patientId: pi.patientId, patientInsuranceId: pi.id, companyId: pi.companyId, contractId: pi.contractId,
          visitId: body.visitId ?? null, doctorId, serviceId: service.id, quantity: body.quantity, diagnosis, reason: body.reason ?? null,
          medicalReportId: body.medicalReportId ?? null, notes: body.notes ?? null, createdById: req.ctx.userId,
          status: body.submit || body.decision ? 'SUBMITTED' : 'PENDING', submittedAt: body.submit || body.decision ? new Date() : null,
        },
      });
      await audit(tx, req.ctx, { action: 'insurance.authorization.create', entityType: 'insurance_authorization', entityId: a.id, summary: `طلب موافقة مسبقة ${a.requestNumber} لخدمة ${service.name}`, after: a });
      if (body.decision) await decide(tx, req.ctx, a.id, body.decision);
      return a.id;
    });
    res.status(201).json(authView(await prisma.insuranceAuthorization.findUniqueOrThrow({ where: { id }, include: authInclude })));
  }),
);

insuranceRouter.post(
  '/authorizations/:id/submit',
  requirePerm('insurance.authorization.manage'),
  ah(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const a = await tx.insuranceAuthorization.findUnique({ where: { id: req.params.id } });
      if (!a) throw notFound();
      if (a.status !== 'PENDING') throw badRequest('الطلب أُرسل مسبقاً');
      await tx.insuranceAuthorization.update({ where: { id: a.id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'insurance.authorization.submit', entityType: 'insurance_authorization', entityId: a.id, summary: `إرسال طلب الموافقة ${a.requestNumber}` });
    });
    res.json(authView(await prisma.insuranceAuthorization.findUniqueOrThrow({ where: { id: req.params.id }, include: authInclude })));
  }),
);

insuranceRouter.post(
  '/authorizations/:id/decide',
  requirePerm('insurance.authorization.manage'),
  ah(async (req, res) => {
    const body = parse(decisionBody, req.body);
    await prisma.$transaction((tx) => decide(tx, req.ctx, req.params.id, body));
    res.json(authView(await prisma.insuranceAuthorization.findUniqueOrThrow({ where: { id: req.params.id }, include: authInclude })));
  }),
);

insuranceRouter.post(
  '/authorizations/:id/cancel',
  requirePerm('insurance.authorization.manage'),
  ah(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'اذكر السبب').max(300) }), req.body);
    await prisma.$transaction(async (tx) => {
      const a = await tx.insuranceAuthorization.findUnique({ where: { id: req.params.id }, include: { _count: { select: { invoiceItems: { where: { invoice: { status: { not: 'CANCELLED' } } } } } } } });
      if (!a) throw notFound();
      if (a._count.invoiceItems) throw badRequest('الموافقة مستخدمة في فاتورة ولا يمكن إلغاؤها');
      await tx.insuranceAuthorization.update({ where: { id: a.id }, data: { status: 'CANCELLED', notes: [a.notes, `إلغاء: ${reason}`].filter(Boolean).join('\n') } });
      await audit(tx, req.ctx, { action: 'insurance.authorization.cancel', entityType: 'insurance_authorization', entityId: a.id, summary: `إلغاء طلب الموافقة ${a.requestNumber}: ${reason}`, before: { status: a.status }, after: { status: 'CANCELLED' } });
    });
    res.json(authView(await prisma.insuranceAuthorization.findUniqueOrThrow({ where: { id: req.params.id }, include: authInclude })));
  }),
);
