import { Prisma, type InsuranceCoverageRule, type InsuranceStatus, type Service } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import { can } from '../../auth/context';
import type { Db, Tx } from '../../lib/prisma';
import { badRequest } from '../../lib/errors';
import { D, r3 } from '../../lib/money';
import { addDays, dateOnly, dateOnlyStr } from '../../lib/dates';

export type EffectiveStatus = InsuranceStatus | 'NOT_STARTED' | 'ARCHIVED';

/** A membership's real status today: an end date in the past always wins over the stored status. */
export function effectiveStatus(m: { status: InsuranceStatus; startDate: Date | null; endDate: Date | null; deletedAt?: Date | null }, today = dateOnly()): EffectiveStatus {
  if (m.deletedAt) return 'ARCHIVED';
  if (m.status === 'SUSPENDED') return 'SUSPENDED';
  if (m.status === 'EXPIRED' || (m.endDate && m.endDate < today)) return 'EXPIRED';
  if (m.startDate && m.startDate > today) return 'NOT_STARTED';
  return 'ACTIVE';
}

export const daysToExpiry = (endDate: Date | null, today = dateOnly()) =>
  endDate ? Math.round((endDate.getTime() - today.getTime()) / 86_400_000) : null;

const STATUS_MSG: Record<Exclude<EffectiveStatus, 'ACTIVE'>, string> = {
  EXPIRED: 'تأمين المريض منتهي الصلاحية',
  SUSPENDED: 'تأمين المريض موقوف',
  NOT_STARTED: 'تأمين المريض لم يبدأ بعد',
  ARCHIVED: 'هذا التأمين مؤرشف',
};

const membershipInclude = { contract: { include: { rules: true, company: true } } } satisfies Prisma.PatientInsuranceInclude;
export type MembershipWithContract = Prisma.PatientInsuranceGetPayload<{ include: typeof membershipInclude }>;

/** Loads a membership and fails unless it, its contract and its company can be used today. */
export async function usableMembership(db: Db, patientId: string, membershipId: string): Promise<MembershipWithContract> {
  const m = await db.patientInsurance.findFirst({ where: { id: membershipId, patientId }, include: membershipInclude });
  if (!m) throw badRequest('التأمين المحدد لا يخص هذا المريض');
  const st = effectiveStatus(m);
  if (st !== 'ACTIVE') throw badRequest(`${STATUS_MSG[st]}${m.endDate && st === 'EXPIRED' ? ` (انتهى ${dateOnlyStr(m.endDate)})` : ''}. حدّث بيانات التأمين أو اختر الدفع النقدي`);
  const today = dateOnly();
  const c = m.contract;
  if (!c.company.isActive) throw badRequest(`شركة التأمين "${c.company.nameAr}" غير فعالة`);
  if (!c.isActive || (c.endDate && c.endDate < today) || (c.startDate && c.startDate > today)) throw badRequest(`عقد التأمين "${c.name}" غير ساري`);
  return m;
}

/**
 * Picks the insurance for a new visit or invoice: the primary membership when it is usable,
 * otherwise the secondary one. A secondary insurance is never used while the primary is valid.
 */
export async function defaultMembership(db: Db, patientId: string) {
  const list = await db.patientInsurance.findMany({ where: { patientId, deletedAt: null }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
  return list.find((m) => effectiveStatus(m) === 'ACTIVE') ?? null;
}

/** Start of the current policy year: the last anniversary of the start date, or 1 January. */
export function policyYearStart(startDate: Date | null, today = dateOnly()) {
  const y = today.getUTCFullYear();
  if (!startDate) return new Date(Date.UTC(y, 0, 1));
  let s = new Date(Date.UTC(y, startDate.getUTCMonth(), startDate.getUTCDate()));
  if (s > today) s = new Date(Date.UTC(y - 1, startDate.getUTCMonth(), startDate.getUTCDate()));
  return s < startDate ? startDate : s;
}

/** Yearly limit, the part used by claims in the current policy year, and what is left. */
export async function annualUsage(db: Db, m: { id: string; startDate: Date | null; annualLimit: Prisma.Decimal | null; contract: { annualLimit: Prisma.Decimal | null } }) {
  const limit = m.annualLimit ?? m.contract.annualLimit;
  const from = policyYearStart(m.startDate);
  const agg = await db.insuranceClaim.aggregate({
    where: { patientInsuranceId: m.id, status: { not: 'CANCELLED' }, createdAt: { gte: from } },
    _sum: { insuranceAmount: true, rejectedAmount: true, transferredAmount: true, writtenOffAmount: true },
  });
  const s = agg._sum;
  const used = Prisma.Decimal.max(D(s.insuranceAmount).sub(D(s.rejectedAmount)).sub(D(s.transferredAmount)).sub(D(s.writtenOffAmount)), 0);
  return { limit, used, remaining: limit ? Prisma.Decimal.max(D(limit).sub(used), 0) : null, periodStart: from, periodEnd: addDays(from, 365) };
}

export interface RuleSet { service?: InsuranceCoverageRule; category?: InsuranceCoverageRule }
export const rulesFor = (rules: InsuranceCoverageRule[], s: Pick<Service, 'id' | 'category'>): RuleSet => ({
  service: rules.find((r) => r.serviceId === s.id),
  category: rules.find((r) => !r.serviceId && r.category === s.category),
});

/** Contract price of a service (falls back to the clinic price). */
export const contractPrice = (rules: InsuranceCoverageRule[], s: Pick<Service, 'id' | 'category' | 'price'>) =>
  D(rulesFor(rules, s).service?.price ?? s.price);

export interface LineCoverageInput {
  service: Service;
  quantity: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Staff override: cover a line that needs an approval nobody recorded. */
  overrideApproval?: boolean;
  /** Staff override: the company share as printed on the company's own approval. */
  insuranceShare?: number | null;
}

export interface LineCoverage {
  coveragePercent: Prisma.Decimal | null;
  insuranceShare: Prisma.Decimal;
  patientShare: Prisma.Decimal;
  authorizationId: string | null;
  coverageNote: string | null;
  requiresApproval: boolean;
  requiresReport: boolean;
  approvalMissing: boolean;
}

/**
 * Splits each invoice line between the company and the patient.
 * Order of rules: service rule → category rule → service defaults → contract default.
 * Lines that need a pre-authorization are only covered with an approved, unexpired, unused authorization,
 * or when a user holding insurance.coverage.override covers them explicitly.
 * Finally the member's yearly limit caps the total company share.
 */
export async function computeCoverage(
  tx: Tx, ctx: Ctx, m: MembershipWithContract,
  lines: LineCoverageInput[], opts: { visitId?: string | null; excludeInvoiceId?: string | null },
): Promise<{ lines: LineCoverage[]; warnings: string[]; limit: Awaited<ReturnType<typeof annualUsage>> }> {
  const today = dateOnly();
  const warnings: string[] = [];
  const memberPercent = m.coveragePercent;
  const out: LineCoverage[] = [];
  const authUse = new Map<string, { qty: Prisma.Decimal; amount: Prisma.Decimal }>();

  for (const l of lines) {
    const s = l.service;
    const { service: sr, category: cr } = rulesFor(m.contract.rules, s);
    const rule = sr ?? cr;
    const requiresApproval = Boolean(sr?.requiresApproval || cr?.requiresApproval || s.insRequiresApproval);
    const requiresReport = Boolean(sr?.requiresReport || cr?.requiresReport || s.insRequiresReport);
    let note: string | null = null;
    let percent: Prisma.Decimal | null = null;
    let ins = D(0);
    const covered = sr ? sr.covered : s.insurable && (cr ? cr.covered : true);

    if (!covered) {
      note = 'خدمة غير مشمولة بالتأمين';
    } else {
      if (rule?.patientFixed != null) {
        ins = Prisma.Decimal.max(l.lineTotal.sub(r3(D(rule.patientFixed).mul(l.quantity))), 0);
        note = `يتحمل المريض ${D(rule.patientFixed).toNumber()} لكل وحدة`;
      } else {
        percent = D(rule?.coveragePercent ?? memberPercent ?? s.insCoveragePercent ?? m.contract.coveragePercent);
        ins = r3(l.lineTotal.mul(percent).div(100));
      }
      const caps = [rule?.maxAmount, s.insMaxAmount].filter((v): v is Prisma.Decimal => v != null).map((v) => r3(D(v).mul(l.quantity)));
      if (caps.length) {
        const cap = Prisma.Decimal.min(...caps);
        if (ins.gt(cap)) { ins = cap; note = `الحد الأعلى لتغطية الخدمة ${cap.toNumber()}`; }
      }
    }

    let authorizationId: string | null = null;
    let approvalMissing = false;
    if (covered && requiresApproval) {
      const auths = await tx.insuranceAuthorization.findMany({
        where: {
          patientInsuranceId: m.id, serviceId: s.id, status: { in: ['APPROVED', 'PARTIALLY_APPROVED'] },
          OR: [{ validUntil: null }, { validUntil: { gte: today } }],
          ...(opts.visitId ? { AND: [{ OR: [{ visitId: null }, { visitId: opts.visitId }] }] } : {}),
        },
        orderBy: { decidedAt: 'asc' },
        include: { invoiceItems: { where: { invoice: { status: { not: 'CANCELLED' }, ...(opts.excludeInvoiceId && { id: { not: opts.excludeInvoiceId } }) } }, select: { quantity: true, insuranceShare: true } } },
      });
      for (const a of auths) {
        const used = authUse.get(a.id) ?? {
          qty: a.invoiceItems.reduce((t, i) => t.add(i.quantity), D(0)),
          amount: a.invoiceItems.reduce((t, i) => t.add(i.insuranceShare), D(0)),
        };
        const qtyLeft = D(a.approvedQuantity ?? a.quantity).sub(used.qty);
        if (qtyLeft.lt(l.quantity)) continue;
        authorizationId = a.id;
        if (a.approvedAmount != null) {
          const amountLeft = Prisma.Decimal.max(D(a.approvedAmount).sub(used.amount), 0);
          if (ins.gt(amountLeft)) { ins = amountLeft; note = `حسب المبلغ المعتمد في الموافقة ${a.approvalNumber ?? a.requestNumber}`; }
        }
        authUse.set(a.id, { qty: used.qty.add(l.quantity), amount: used.amount.add(ins) });
        note = note ?? `موافقة ${a.approvalNumber ?? a.requestNumber}`;
        break;
      }
      if (!authorizationId) {
        if (l.overrideApproval) {
          if (!can(ctx, 'insurance.coverage.override')) throw badRequest(`لا تملك صلاحية اعتماد تغطية "${s.name}" بدون موافقة مسبقة`);
          note = 'تغطية بدون موافقة مسبقة (اعتماد يدوي)';
        } else {
          approvalMissing = true;
          ins = D(0);
          note = 'تحتاج موافقة مسبقة من شركة التأمين — غير مغطاة حتى تسجيل الموافقة';
          warnings.push(`"${s.name}" تحتاج إلى موافقة مسبقة من شركة التأمين.`);
        }
      }
    }

    if (l.insuranceShare != null && !D(l.insuranceShare).eq(ins)) {
      if (!can(ctx, 'insurance.coverage.override')) throw badRequest(`لا تملك صلاحية تعديل حصة التأمين على "${s.name}"`);
      const v = r3(l.insuranceShare);
      if (v.lt(0) || v.gt(l.lineTotal)) throw badRequest(`حصة التأمين على "${s.name}" يجب أن تكون بين 0 و ${l.lineTotal.toNumber()}`);
      ins = v;
      percent = l.lineTotal.gt(0) ? r3(v.mul(100).div(l.lineTotal)) : null;
      note = 'حصة تأمين معدلة يدوياً';
      approvalMissing = false;
    }
    if (requiresReport) warnings.push(`"${s.name}" تتطلب تقريراً طبياً أو وصفة عند تقديم المطالبة.`);
    out.push({ coveragePercent: percent, insuranceShare: ins, patientShare: l.lineTotal.sub(ins), authorizationId, coverageNote: note, requiresApproval, requiresReport, approvalMissing });
  }

  // Yearly limit of the member.
  const limit = await annualUsage(tx, m);
  if (limit.remaining) {
    let left = limit.remaining;
    for (const c of out) {
      if (c.insuranceShare.lte(left)) { left = left.sub(c.insuranceShare); continue; }
      const cut = c.insuranceShare.sub(left);
      c.insuranceShare = left;
      c.patientShare = c.patientShare.add(cut);
      c.coverageNote = 'تم تجاوز الحد السنوي للتغطية — الفرق على المريض';
      left = D(0);
    }
    if (out.some((c) => c.coverageNote?.startsWith('تم تجاوز'))) warnings.push(`تم الوصول إلى الحد السنوي للتغطية (المتبقي ${limit.remaining.toNumber()}).`);
  }
  const days = daysToExpiry(m.endDate, today);
  if (days != null && days <= 30) warnings.push(`ينتهي تأمين المريض خلال ${days} يوم.`);
  return { lines: out, warnings: [...new Set(warnings)], limit };
}

export interface PayerChoice { payerType?: 'SELF_PAY' | 'INSURANCE'; patientInsuranceId?: string | null }

/**
 * Payer snapshot stored on a visit. Not specified → the patient's usable insurance if any, else self pay.
 * Asking for insurance explicitly fails when no valid membership exists.
 */
export async function resolveVisitPayer(db: Db, patientId: string, input: PayerChoice) {
  const self = { payerType: 'SELF_PAY' as const, patientInsuranceId: null, insuranceCompanyId: null, insuranceContractId: null, insuranceMemberId: null };
  if (input.payerType === 'SELF_PAY') return self;
  let m: MembershipWithContract | null = null;
  if (input.patientInsuranceId) m = await usableMembership(db, patientId, input.patientInsuranceId);
  else {
    const d = await defaultMembership(db, patientId);
    if (d) {
      try { m = await usableMembership(db, patientId, d.id); } catch (e) { if (input.payerType === 'INSURANCE') throw e; }
    } else if (input.payerType === 'INSURANCE') throw badRequest('لا يوجد تأمين ساري لهذا المريض');
  }
  if (!m) return self;
  return { payerType: 'INSURANCE' as const, patientInsuranceId: m.id, insuranceCompanyId: m.companyId, insuranceContractId: m.contractId, insuranceMemberId: m.memberId };
}
