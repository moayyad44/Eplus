import { Prisma, type ClaimEventType, type ClaimStatus } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import { can } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { nextCounter, pad } from '../../lib/counters';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { D, r3 } from '../../lib/money';

/*
 * A claim's money is a ledger: every decision, payment, transfer or write-off is an append-only event
 * carrying amount deltas, and the claim columns are recomputed from the events that are not voided.
 *
 *   insuranceAmount = pending + approved + rejected + transferred + writtenOff + cancelled
 *   outstanding (insurance receivable) = pending + approved − paid
 */

type Amounts = { approved: Prisma.Decimal; rejected: Prisma.Decimal; paid: Prisma.Decimal; transferred: Prisma.Decimal; writtenOff: Prisma.Decimal; submitted: Prisma.Decimal; cancelled: Prisma.Decimal; pending: Prisma.Decimal };

const WORKFLOW: ClaimStatus[] = ['DRAFT', 'READY', 'SUBMITTED', 'UNDER_REVIEW', 'RESUBMISSION_REQUIRED', 'CLOSED', 'CANCELLED'];

/** Status shown to users, derived from the workflow step and the amounts. */
export function deriveStatus(wf: ClaimStatus, a: Amounts): ClaimStatus {
  if (wf === 'CANCELLED') return 'CANCELLED';
  if (a.pending.gt(0)) return a.paid.gt(0) ? 'PARTIALLY_PAID' : wf === 'CLOSED' ? 'SUBMITTED' : wf;
  if (wf === 'CLOSED') return 'CLOSED';
  if (a.approved.eq(0)) {
    if (a.rejected.gt(0)) return wf === 'RESUBMISSION_REQUIRED' ? 'RESUBMISSION_REQUIRED' : 'REJECTED';
    return 'CLOSED'; // everything transferred to the patient or written off
  }
  if (a.paid.eq(0)) return a.rejected.gt(0) ? (wf === 'RESUBMISSION_REQUIRED' ? 'RESUBMISSION_REQUIRED' : 'PARTIALLY_APPROVED') : 'APPROVED';
  if (a.paid.lt(a.approved)) return 'PARTIALLY_PAID';
  return a.rejected.gt(0) ? 'PAID' : 'CLOSED';
}

async function lockClaim(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM insurance_claims WHERE id = ${id} FOR UPDATE`;
  const c = await tx.insuranceClaim.findUnique({ where: { id } });
  if (!c) throw notFound('المطالبة غير موجودة');
  return c;
}

const snapshot = (c: { status: ClaimStatus; approvedAmount: Prisma.Decimal; rejectedAmount: Prisma.Decimal; paidAmount: Prisma.Decimal; outstandingAmount: Prisma.Decimal; pendingAmount: Prisma.Decimal; transferredAmount: Prisma.Decimal; writtenOffAmount: Prisma.Decimal }) => ({
  status: c.status, approved: D(c.approvedAmount).toNumber(), rejected: D(c.rejectedAmount).toNumber(), paid: D(c.paidAmount).toNumber(),
  pending: D(c.pendingAmount).toNumber(), outstanding: D(c.outstandingAmount).toNumber(), transferred: D(c.transferredAmount).toNumber(), writtenOff: D(c.writtenOffAmount).toNumber(),
});

/** Recomputes a claim from its ledger, then the invoice's patient balance (transfers raise it). */
export async function recomputeClaim(tx: Tx, claimId: string) {
  const c = await tx.insuranceClaim.findUniqueOrThrow({ where: { id: claimId } });
  const s = await tx.insuranceClaimEvent.aggregate({
    where: { claimId, voidedAt: null },
    _sum: { dApproved: true, dRejected: true, dPaid: true, dTransferred: true, dWrittenOff: true, dSubmitted: true, dCancelled: true },
  });
  const a: Amounts = {
    approved: D(s._sum.dApproved), rejected: D(s._sum.dRejected), paid: D(s._sum.dPaid), transferred: D(s._sum.dTransferred),
    writtenOff: D(s._sum.dWrittenOff), submitted: D(s._sum.dSubmitted), cancelled: D(s._sum.dCancelled), pending: D(0),
  };
  a.pending = D(c.insuranceAmount).sub(a.approved).sub(a.rejected).sub(a.transferred).sub(a.writtenOff).sub(a.cancelled);
  if (a.pending.lt(0) || a.paid.gt(a.approved)) throw new AppError(409, 'CLAIM_INCONSISTENT', 'المبالغ تتجاوز قيمة المطالبة');
  const status = deriveStatus(c.workflowStatus, a);
  const lastPay = await tx.insurancePaymentAllocation.findFirst({ where: { claimId, payment: { voidedAt: null } }, orderBy: { payment: { paidAt: 'desc' } }, select: { payment: { select: { paidAt: true } } } });
  const updated = await tx.insuranceClaim.update({
    where: { id: claimId },
    data: {
      approvedAmount: a.approved, rejectedAmount: a.rejected, paidAmount: a.paid, transferredAmount: a.transferred, writtenOffAmount: a.writtenOff,
      submittedAmount: a.submitted, pendingAmount: a.pending, outstandingAmount: status === 'CANCELLED' ? 0 : a.pending.add(a.approved).sub(a.paid),
      status, lastPaymentAt: lastPay?.payment.paidAt ?? null,
      closedAt: status === 'CLOSED' ? (c.closedAt ?? new Date()) : null,
    },
  });
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: c.invoiceId }, select: { transferredFromInsurance: true } });
  if (!D(inv.transferredFromInsurance).eq(a.transferred)) {
    await tx.invoice.update({ where: { id: c.invoiceId }, data: { transferredFromInsurance: a.transferred } });
    const { recomputeInvoice } = await import('../billing/service');
    await recomputeInvoice(tx, c.invoiceId);
  }
  return updated;
}

async function addEvent(
  tx: Tx, ctx: Ctx, claimId: string, type: ClaimEventType,
  d: Partial<Record<'dApproved' | 'dRejected' | 'dPaid' | 'dTransferred' | 'dWrittenOff' | 'dSubmitted' | 'dCancelled', Prisma.Decimal | number>> = {},
  extra: { reason?: string | null; notes?: string | null; allocationId?: string; fromStatus?: ClaimStatus; toStatus?: ClaimStatus } = {},
) {
  return tx.insuranceClaimEvent.create({
    data: { claimId, type, ...d, reason: extra.reason ?? null, notes: extra.notes ?? null, allocationId: extra.allocationId, fromStatus: extra.fromStatus, toStatus: extra.toStatus, userId: ctx.userId, userName: ctx.userName },
  });
}

/** Runs a claim action: lock → validate → events → recompute → audit (before/after). */
async function act(tx: Tx, ctx: Ctx, claimId: string, action: string, summary: (c: Prisma.InsuranceClaimGetPayload<object>) => string, fn: (c: Prisma.InsuranceClaimGetPayload<object>) => Promise<ClaimStatus | void>) {
  const before = await lockClaim(tx, claimId);
  const wf = await fn(before);
  if (wf) await tx.insuranceClaim.update({ where: { id: claimId }, data: { workflowStatus: wf } });
  const after = await recomputeClaim(tx, claimId);
  await audit(tx, ctx, { action, entityType: 'insurance_claim', entityId: claimId, summary: summary(after), before: snapshot(before), after: snapshot(after) });
  return after;
}

// ── Creation (on invoice issue) and cancellation (with the invoice) ──

export async function createClaimForInvoice(tx: Tx, ctx: Ctx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { items: true, patientInsurance: true, visit: { include: { diagnoses: { orderBy: { createdAt: 'asc' } } } } },
  });
  if (!inv.patientInsurance || !inv.insuranceCompanyId || !inv.insuranceContractId || D(inv.insuranceShare).lte(0)) return null;
  const n = await nextCounter(tx, 'insurance-claim');
  const diagnosis = inv.visit?.diagnoses.map((d) => [d.icd10Code, d.description].filter(Boolean).join(' — ')).join('؛ ') || null;
  const claim = await tx.insuranceClaim.create({
    data: {
      claimNumber: `CLM-${pad(n, 6)}`, invoiceId: inv.id, patientId: inv.patientId, companyId: inv.insuranceCompanyId, contractId: inv.insuranceContractId,
      patientInsuranceId: inv.patientInsurance.id, visitId: inv.visitId, doctorId: inv.doctorId, policyNumber: inv.patientInsurance.policyNumber,
      memberId: inv.patientInsurance.memberId, diagnosis, totalAmount: inv.total, insuranceAmount: inv.insuranceShare, patientAmount: inv.patientShare,
      pendingAmount: inv.insuranceShare, outstandingAmount: inv.insuranceShare, createdById: ctx.userId,
      items: {
        create: inv.items.filter((i) => D(i.insuranceShare).gt(0)).map((i) => ({
          invoiceItemId: i.id, serviceId: i.serviceId, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice,
          totalAmount: i.lineTotal, insuranceAmount: i.insuranceShare,
        })),
      },
    },
  });
  await addEvent(tx, ctx, claim.id, 'CREATED', {}, { toStatus: 'DRAFT', notes: `فاتورة ${inv.invoiceNumber}` });
  await audit(tx, ctx, { action: 'insurance.claim.create', entityType: 'insurance_claim', entityId: claim.id, summary: `مطالبة ${claim.claimNumber} للفاتورة ${inv.invoiceNumber} بقيمة ${D(inv.insuranceShare).toNumber()}`, after: { claimNumber: claim.claimNumber, insuranceAmount: D(inv.insuranceShare).toNumber() } });
  return claim;
}

/** Called when an invoice is cancelled. Refused once the company approved, paid or anything was settled. */
export async function cancelClaimWithInvoice(tx: Tx, ctx: Ctx, invoiceId: string, reason: string) {
  const c = await tx.insuranceClaim.findUnique({ where: { invoiceId } });
  if (!c || c.status === 'CANCELLED') return;
  await lockClaim(tx, c.id);
  if (D(c.approvedAmount).gt(0) || D(c.paidAmount).gt(0) || D(c.transferredAmount).gt(0) || D(c.writtenOffAmount).gt(0)) {
    throw new AppError(409, 'CLAIM_SETTLED', `لا يمكن إلغاء الفاتورة: مطالبة التأمين ${c.claimNumber} معتمدة أو مدفوعة`);
  }
  await act(tx, ctx, c.id, 'insurance.claim.cancel', (x) => `إلغاء المطالبة ${x.claimNumber} مع إلغاء الفاتورة`, async (cur) => {
    await addEvent(tx, ctx, cur.id, 'CANCELLED', { dCancelled: D(cur.pendingAmount).add(cur.rejectedAmount), dRejected: D(cur.rejectedAmount).neg() }, { reason, fromStatus: cur.status, toStatus: 'CANCELLED' });
    return 'CANCELLED';
  });
}

// ── Workflow ──

const need = (ctx: Ctx, perm: Parameters<typeof can>[1]) => { if (!can(ctx, perm)) throw forbidden(); };
const notCancelled = (c: { status: ClaimStatus; claimNumber: string }) => { if (c.status === 'CANCELLED') throw badRequest(`المطالبة ${c.claimNumber} ملغاة`); };

export async function markReady(tx: Tx, ctx: Ctx, id: string, notes?: string | null) {
  return act(tx, ctx, id, 'insurance.claim.ready', (c) => `تجهيز المطالبة ${c.claimNumber} للإرسال`, async (c) => {
    notCancelled(c);
    if (c.workflowStatus !== 'DRAFT') throw badRequest('المطالبة ليست مسودة');
    await addEvent(tx, ctx, c.id, 'READY', {}, { notes, fromStatus: c.status, toStatus: 'READY' });
    return 'READY';
  });
}

export async function submitClaim(tx: Tx, ctx: Ctx, id: string, notes?: string | null) {
  return act(tx, ctx, id, 'insurance.claim.submit', (c) => `إرسال المطالبة ${c.claimNumber} بقيمة ${D(c.pendingAmount).toNumber()}`, async (c) => {
    notCancelled(c);
    if (!['DRAFT', 'READY'].includes(c.workflowStatus)) throw badRequest(`المطالبة ${c.claimNumber} مرسلة مسبقاً`);
    await addEvent(tx, ctx, c.id, 'SUBMITTED', { dSubmitted: c.pendingAmount }, { notes, fromStatus: c.status, toStatus: 'SUBMITTED' });
    await tx.insuranceClaim.update({ where: { id: c.id }, data: { submittedAt: c.submittedAt ?? new Date(), submissionCount: { increment: 1 } } });
    return 'SUBMITTED';
  });
}

export async function markUnderReview(tx: Tx, ctx: Ctx, id: string, notes?: string | null) {
  return act(tx, ctx, id, 'insurance.claim.review', (c) => `المطالبة ${c.claimNumber} قيد المراجعة لدى الشركة`, async (c) => {
    if (c.workflowStatus !== 'SUBMITTED') throw badRequest('يمكن تحويل المطالبة المرسلة فقط إلى «قيد المراجعة»');
    await addEvent(tx, ctx, c.id, 'UNDER_REVIEW', {}, { notes, fromStatus: c.status, toStatus: 'UNDER_REVIEW' });
    return 'UNDER_REVIEW';
  });
}

export interface DecisionInput {
  items: { claimItemId: string; approved: number; rejected: number; reason?: string | null }[];
  approvalNumber?: string | null;
  notes?: string | null;
}

/** The company's answer: per line, how much it approves and how much it rejects (with a reason). */
export async function recordDecision(tx: Tx, ctx: Ctx, id: string, input: DecisionInput) {
  return act(tx, ctx, id, 'insurance.claim.decision', (c) => `قرار الشركة على ${c.claimNumber}: معتمد ${D(c.approvedAmount).toNumber()} / مرفوض ${D(c.rejectedAmount).toNumber()}`, async (c) => {
    notCancelled(c);
    if (!['SUBMITTED', 'UNDER_REVIEW', 'RESUBMISSION_REQUIRED'].includes(c.workflowStatus)) throw badRequest('أرسل المطالبة أولاً قبل تسجيل قرار الشركة');
    const items = await tx.insuranceClaimItem.findMany({ where: { claimId: c.id } });
    let approved = D(0), rejected = D(0);
    const reasons: string[] = [];
    for (const it of input.items) {
      const item = items.find((x) => x.id === it.claimItemId);
      if (!item) throw badRequest('بند غير موجود في المطالبة');
      const a = r3(it.approved), r = r3(it.rejected);
      if (a.lt(0) || r.lt(0)) throw badRequest('المبالغ لا يمكن أن تكون سالبة');
      if (r.gt(0) && !it.reason?.trim()) throw badRequest(`اذكر سبب الرفض لبند "${item.description}"`);
      if (a.add(r).gt(D(item.insuranceAmount).sub(item.approvedAmount))) throw badRequest(`المبلغ على "${item.description}" أكبر من قيمته`);
      approved = approved.add(a); rejected = rejected.add(r);
      if (r.gt(0)) reasons.push(`${item.description}: ${it.reason!.trim()}`);
      if (a.gt(0) || r.gt(0)) {
        await tx.insuranceClaimItem.update({
          where: { id: item.id },
          data: { approvedAmount: { increment: a }, rejectedAmount: { increment: r }, ...(r.gt(0) && { rejectReason: it.reason!.trim() }), ...(input.approvalNumber && { approvalNumber: input.approvalNumber }) },
        });
      }
    }
    if (approved.add(rejected).lte(0)) throw badRequest('أدخل المبلغ المعتمد أو المرفوض');
    if (approved.gt(0)) need(ctx, 'insurance.claim.approve');
    if (rejected.gt(0)) need(ctx, 'insurance.claim.reject');
    if (approved.add(rejected).gt(c.pendingAmount)) throw badRequest(`المجموع (${approved.add(rejected).toNumber()}) أكبر من المبلغ قيد المطالبة (${D(c.pendingAmount).toNumber()})`);
    await addEvent(tx, ctx, c.id, 'DECISION', { dApproved: approved, dRejected: rejected }, {
      reason: reasons.join('؛ ') || null, notes: [input.approvalNumber && `رقم الاعتماد ${input.approvalNumber}`, input.notes].filter(Boolean).join(' — ') || null, fromStatus: c.status,
    });
    return c.workflowStatus === 'SUBMITTED' ? 'UNDER_REVIEW' : c.workflowStatus;
  });
}

export async function markResubmissionRequired(tx: Tx, ctx: Ctx, id: string, notes?: string | null) {
  return act(tx, ctx, id, 'insurance.claim.resubmission_required', (c) => `المطالبة ${c.claimNumber} تحتاج إعادة تقديم`, async (c) => {
    if (D(c.rejectedAmount).lte(0)) throw badRequest('لا يوجد مبلغ مرفوض');
    await addEvent(tx, ctx, c.id, 'RESUBMISSION_REQUIRED', {}, { notes, fromStatus: c.status, toStatus: 'RESUBMISSION_REQUIRED' });
    return 'RESUBMISSION_REQUIRED';
  });
}

/** Sends (part of) the rejected amount back to the company. History of the earlier submission is kept. */
export async function resubmitClaim(tx: Tx, ctx: Ctx, id: string, amount: number | null | undefined, notes?: string | null) {
  return act(tx, ctx, id, 'insurance.claim.resubmit', (c) => `إعادة تقديم المطالبة ${c.claimNumber} (المحاولة ${c.submissionCount})`, async (c) => {
    notCancelled(c);
    const x = amount == null ? D(c.rejectedAmount) : r3(amount);
    if (x.lte(0) || x.gt(c.rejectedAmount)) throw badRequest(`مبلغ إعادة التقديم يجب أن يكون بين 0 و ${D(c.rejectedAmount).toNumber()}`);
    await addEvent(tx, ctx, c.id, 'RESUBMITTED', { dRejected: x.neg(), dSubmitted: x }, { notes, fromStatus: c.status, toStatus: 'SUBMITTED' });
    await tx.insuranceClaim.update({ where: { id: c.id }, data: { submissionCount: { increment: 1 } } });
    return 'SUBMITTED';
  });
}

/** Rejected amount billed to the patient: it leaves the insurance receivable and raises the patient's balance. */
export async function transferToPatient(tx: Tx, ctx: Ctx, id: string, amount: number | null | undefined, reason: string) {
  return act(tx, ctx, id, 'insurance.claim.transfer', (c) => `تحويل ${D(c.transferredAmount).toNumber()} من المطالبة ${c.claimNumber} على المريض`, async (c) => {
    notCancelled(c);
    const x = amount == null ? D(c.rejectedAmount) : r3(amount);
    if (x.lte(0) || x.gt(c.rejectedAmount)) throw badRequest(`يمكن تحويل المبلغ المرفوض فقط (حتى ${D(c.rejectedAmount).toNumber()})`);
    await addEvent(tx, ctx, c.id, 'TRANSFER_TO_PATIENT', { dRejected: x.neg(), dTransferred: x }, { reason, fromStatus: c.status });
  });
}

/** Writes off a rejected amount, or an approved amount the company will not pay. */
export async function writeOff(tx: Tx, ctx: Ctx, id: string, source: 'REJECTED' | 'APPROVED_UNPAID', amount: number | null | undefined, reason: string) {
  return act(tx, ctx, id, 'insurance.claim.write_off', (c) => `شطب ${D(c.writtenOffAmount).toNumber()} من المطالبة ${c.claimNumber}`, async (c) => {
    notCancelled(c);
    const max = source === 'REJECTED' ? D(c.rejectedAmount) : D(c.approvedAmount).sub(c.paidAmount);
    const x = amount == null ? max : r3(amount);
    if (x.lte(0) || x.gt(max)) throw badRequest(`مبلغ الشطب يجب أن يكون بين 0 و ${max.toNumber()}`);
    await addEvent(tx, ctx, c.id, 'WRITE_OFF', source === 'REJECTED' ? { dRejected: x.neg(), dWrittenOff: x } : { dApproved: x.neg(), dWrittenOff: x }, { reason, fromStatus: c.status });
  });
}

/** Closes a settled claim; a rejected remainder is written off (kept visible in the history). */
export async function closeClaim(tx: Tx, ctx: Ctx, id: string, notes?: string | null) {
  return act(tx, ctx, id, 'insurance.claim.close', (c) => `إغلاق المطالبة ${c.claimNumber}`, async (c) => {
    notCancelled(c);
    if (D(c.pendingAmount).gt(0) || D(c.paidAmount).lt(c.approvedAmount)) throw badRequest('لا يمكن الإغلاق: يوجد مبلغ قيد المطالبة أو معتمد غير مدفوع');
    if (D(c.rejectedAmount).gt(0)) {
      need(ctx, 'insurance.claim.reject');
      await addEvent(tx, ctx, c.id, 'WRITE_OFF', { dRejected: D(c.rejectedAmount).neg(), dWrittenOff: c.rejectedAmount }, { reason: 'شطب المرفوض عند إغلاق المطالبة' });
    }
    await addEvent(tx, ctx, c.id, 'CLOSED', {}, { notes, fromStatus: c.status, toStatus: 'CLOSED' });
    return 'CLOSED';
  });
}

export async function addNote(tx: Tx, ctx: Ctx, id: string, notes: string) {
  await lockClaim(tx, id);
  await addEvent(tx, ctx, id, 'NOTE', {}, { notes });
  await audit(tx, ctx, { action: 'insurance.claim.note', entityType: 'insurance_claim', entityId: id, summary: `ملاحظة على المطالبة: ${notes}` });
}

// ── Company payments ──

export interface CompanyPaymentInput {
  companyId: string;
  methodId: string;
  reference?: string | null;
  notes?: string | null;
  paidAt?: Date | null;
  allocations: { claimId: string; amount: number }[];
}

/**
 * Records money received from a company and spreads it over claims. Paying more than the approved amount
 * approves the difference (the company paid it, so it accepted it). Lowers the insurance receivable.
 */
export async function recordCompanyPayment(tx: Tx, ctx: Ctx, input: CompanyPaymentInput) {
  const company = await tx.insuranceCompany.findUnique({ where: { id: input.companyId } });
  if (!company) throw notFound('شركة التأمين غير موجودة');
  const method = await tx.paymentMethod.findFirst({ where: { id: input.methodId, isActive: true } });
  if (!method) throw badRequest('طريقة الدفع غير متاحة');
  if (method.requiresReference && !input.reference) throw badRequest(`رقم العملية مطلوب للدفع عبر ${method.name}`);
  const lines = input.allocations.map((a) => ({ ...a, amount: r3(a.amount) })).filter((a) => a.amount.gt(0));
  if (!lines.length) throw badRequest('وزّع المبلغ على مطالبة واحدة على الأقل');
  if (new Set(lines.map((l) => l.claimId)).size !== lines.length) throw badRequest('المطالبة مكررة في التوزيع');
  const total = lines.reduce((t, l) => t.add(l.amount), D(0));
  const n = await nextCounter(tx, 'insurance-receipt');
  const payment = await tx.insurancePayment.create({
    data: {
      receiptNumber: `INS-${pad(n, 6)}`, companyId: company.id, amount: total, methodId: method.id, reference: input.reference ?? null,
      notes: input.notes ?? null, paidAt: input.paidAt ?? new Date(), receivedById: ctx.userId,
    },
  });
  for (const l of lines) {
    const c = await lockClaim(tx, l.claimId);
    if (c.companyId !== company.id) throw badRequest(`المطالبة ${c.claimNumber} لا تخص هذه الشركة`);
    notCancelled(c);
    const unpaidApproved = D(c.approvedAmount).sub(c.paidAmount);
    if (l.amount.gt(unpaidApproved.add(c.pendingAmount))) throw badRequest(`المبلغ على ${c.claimNumber} أكبر من المستحق (${unpaidApproved.add(c.pendingAmount).toNumber()})`);
    const alloc = await tx.insurancePaymentAllocation.create({ data: { paymentId: payment.id, claimId: c.id, amount: l.amount } });
    if (l.amount.gt(unpaidApproved)) {
      await addEvent(tx, ctx, c.id, 'DECISION', { dApproved: l.amount.sub(unpaidApproved) }, { allocationId: alloc.id, notes: `اعتماد ضمني مع الدفعة ${payment.receiptNumber}`, fromStatus: c.status });
    }
    await addEvent(tx, ctx, c.id, 'PAYMENT', { dPaid: l.amount }, { allocationId: alloc.id, notes: `دفعة ${payment.receiptNumber}${input.reference ? ` — مرجع ${input.reference}` : ''}`, fromStatus: c.status });
    if (['DRAFT', 'READY'].includes(c.workflowStatus)) await tx.insuranceClaim.update({ where: { id: c.id }, data: { workflowStatus: 'SUBMITTED', submittedAt: c.submittedAt ?? payment.paidAt } });
    await recomputeClaim(tx, c.id);
  }
  await audit(tx, ctx, {
    action: 'insurance.payment.create', entityType: 'insurance_payment', entityId: payment.id,
    summary: `دفعة ${payment.receiptNumber} من ${company.nameAr} بقيمة ${total.toNumber()} (${method.name}) على ${lines.length} مطالبة`,
    after: { amount: total.toNumber(), method: method.name, reference: input.reference, allocations: lines.map((l) => ({ claimId: l.claimId, amount: l.amount.toNumber() })) },
  });
  return payment;
}

export async function voidCompanyPayment(tx: Tx, ctx: Ctx, paymentId: string, reason: string) {
  const p = await tx.insurancePayment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
  if (!p) throw notFound();
  if (p.voidedAt) throw badRequest('الدفعة ملغاة مسبقاً');
  await tx.insurancePayment.update({ where: { id: p.id }, data: { voidedAt: new Date(), voidedById: ctx.userId, voidReason: reason } });
  for (const a of p.allocations) {
    await lockClaim(tx, a.claimId);
    await tx.insuranceClaimEvent.updateMany({ where: { allocationId: a.id, voidedAt: null }, data: { voidedAt: new Date() } });
    await recomputeClaim(tx, a.claimId);
  }
  await audit(tx, ctx, { action: 'insurance.payment.void', entityType: 'insurance_payment', entityId: p.id, summary: `إلغاء دفعة التأمين ${p.receiptNumber} (${D(p.amount).toNumber()}): ${reason}`, before: { status: 'active' }, after: { status: 'voided', reason } });
}

export { WORKFLOW };
