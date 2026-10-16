import { Prisma, type InvoiceStatus } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import { can } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { nextCounter, pad } from '../../lib/counters';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { D, r3 } from '../../lib/money';
import { getSetting } from '../../lib/settings';
import { addDays, ymd } from '../../lib/dates';
import { recordMovement } from '../inventory/service';
import { changeVisitStatus } from '../visits/service';
import { computeCoverage, contractPrice, usableMembership, type MembershipWithContract } from '../insurance/coverage';
import { cancelClaimWithInvoice, createClaimForInvoice } from '../insurance/claims';
import { onInvoiceCancel, onInvoiceDateChange, prepareSaleDocs } from '../einvoice/service';

export interface InvoiceItemInput {
  serviceId: string;
  quantity: number;
  unitPrice?: number | null;
  discount?: number | null;
  /** Insurance invoices only (needs insurance.coverage.override). */
  overrideApproval?: boolean;
  insuranceShare?: number | null;
}

export interface InvoiceInput {
  patientId: string;
  visitId?: string | null;
  doctorId?: string | null;
  templateId?: string | null;
  /** Omitted → taken from the visit (or self pay without a visit). */
  payerType?: 'SELF_PAY' | 'INSURANCE';
  patientInsuranceId?: string | null;
  items: InvoiceItemInput[];
  invoiceDiscount?: number;
  notes?: string | null;
  /** When rebuilding a draft: its own lines do not count against authorizations. */
  excludeInvoiceId?: string | null;
}

/**
 * Builds validated invoice lines. Every line must be a catalog item (service/material);
 * prices come from the catalog unless the service allows editing or the user holds invoices.price_override;
 * mandatory items of the chosen invoice template are enforced.
 */
export async function buildInvoice(tx: Tx, ctx: Ctx, input: InvoiceInput) {
  const patient = await tx.patient.findFirst({ where: { id: input.patientId, deletedAt: null } });
  if (!patient) throw notFound('المريض غير موجود');

  let doctorId = input.doctorId ?? null;
  let payer: 'SELF_PAY' | 'INSURANCE' = input.payerType ?? 'SELF_PAY';
  let membershipId = input.patientInsuranceId ?? null;
  if (input.visitId) {
    const visit = await tx.visit.findUnique({ where: { id: input.visitId } });
    if (!visit || visit.patientId !== patient.id) throw badRequest('الزيارة لا تخص هذا المريض');
    doctorId = doctorId ?? visit.doctorId;
    if (!input.payerType) { payer = visit.payerType === 'INSURANCE' ? 'INSURANCE' : 'SELF_PAY'; membershipId = membershipId ?? visit.patientInsuranceId; }
  }
  let membership: MembershipWithContract | null = null;
  if (payer === 'INSURANCE') {
    if (!membershipId) throw badRequest('اختر تأمين المريض أو اختر الدفع النقدي');
    membership = await usableMembership(tx, patient.id, membershipId);
  }

  const template = input.templateId
    ? await tx.invoiceTemplate.findFirst({ where: { id: input.templateId, isActive: true }, include: { items: true } })
    : await tx.invoiceTemplate.findFirst({ where: { isDefault: true, isActive: true }, include: { items: true } });
  if (input.templateId && !template) throw badRequest('نموذج الفاتورة غير متاح');

  const lines = [...input.items];
  const mandatory = template?.items.filter((i) => i.isMandatory) ?? [];
  for (const m of mandatory) {
    const existing = lines.find((l) => l.serviceId === m.serviceId);
    if (!existing) lines.unshift({ serviceId: m.serviceId, quantity: D(m.quantity).toNumber() });
    else if (existing.quantity < D(m.quantity).toNumber()) throw badRequest('لا يمكن تقليل كمية المادة الإجبارية في هذا النموذج');
  }
  if (!lines.length) throw badRequest('أضف مادة واحدة على الأقل للفاتورة');

  const services = await tx.service.findMany({ where: { id: { in: lines.map((l) => l.serviceId) }, deletedAt: null } });
  const byId = new Map(services.map((s) => [s.id, s]));
  const mandatoryIds = new Set(mandatory.map((m) => m.serviceId));

  let subtotal = D(0), itemsDiscount = D(0), taxTotal = D(0), linesTotal = D(0);
  const items = lines.map((l, idx) => {
    const s = byId.get(l.serviceId);
    if (!s) throw badRequest('إحدى المواد غير موجودة في قائمة الخدمات');
    if (!s.isActive && !mandatoryIds.has(s.id)) throw badRequest(`المادة "${s.name}" غير مفعلة`);
    if (!(l.quantity > 0)) throw badRequest('الكمية يجب أن تكون أكبر من صفر');
    const basePrice = membership ? contractPrice(membership.contract.rules, s) : D(s.price);
    let unitPrice = basePrice;
    if (l.unitPrice != null && !D(l.unitPrice).eq(basePrice)) {
      if (!s.allowPriceEdit && !can(ctx, 'invoices.price_override')) throw forbidden(`لا تملك صلاحية تعديل سعر "${s.name}"`);
      unitPrice = D(l.unitPrice);
    }
    const qty = D(l.quantity);
    const gross = r3(unitPrice.mul(qty));
    const discount = r3(l.discount ?? 0);
    if (discount.gt(0) && !can(ctx, 'invoices.discount')) throw forbidden('لا تملك صلاحية منح الخصم');
    if (discount.lt(0) || discount.gt(gross)) throw badRequest(`خصم غير صالح على "${s.name}"`);
    const net = gross.sub(discount);
    const taxAmount = r3(net.mul(s.taxRate).div(100));
    const lineTotal = net.add(taxAmount);
    subtotal = subtotal.add(gross);
    itemsDiscount = itemsDiscount.add(discount);
    taxTotal = taxTotal.add(taxAmount);
    linesTotal = linesTotal.add(lineTotal);
    return {
      serviceId: s.id, description: s.name, category: s.category, quantity: qty, unitPrice, discount, taxRate: s.taxRate,
      taxAmount, lineTotal, isMandatory: mandatoryIds.has(s.id), sortOrder: idx,
      coveragePercent: null as Prisma.Decimal | null, insuranceShare: D(0), patientShare: lineTotal,
      authorizationId: null as string | null, coverageNote: null as string | null,
      _service: s, _input: l,
    };
  });

  // Insurance split: coverage is a separate share, never a discount.
  let warnings: string[] = [];
  let coverage: Awaited<ReturnType<typeof computeCoverage>> | null = null;
  if (membership) {
    coverage = await computeCoverage(tx, ctx, membership, items.map((i) => ({
      service: i._service, quantity: i.quantity, lineTotal: i.lineTotal, overrideApproval: i._input.overrideApproval, insuranceShare: i._input.insuranceShare,
    })), { visitId: input.visitId, excludeInvoiceId: input.excludeInvoiceId });
    coverage.lines.forEach((c, k) => Object.assign(items[k], {
      coveragePercent: c.coveragePercent, insuranceShare: c.insuranceShare, patientShare: c.patientShare, authorizationId: c.authorizationId, coverageNote: c.coverageNote,
    }));
    warnings = coverage.warnings;
  }
  const insuranceShare = items.reduce((t, i) => t.add(i.insuranceShare), D(0));
  const linesPatient = linesTotal.sub(insuranceShare);

  const invoiceDiscount = r3(input.invoiceDiscount ?? 0);
  if (invoiceDiscount.gt(0) && !can(ctx, 'invoices.discount')) throw forbidden('لا تملك صلاحية منح الخصم');
  // A clinic discount only reduces what the patient pays; the company share is claimed in full.
  if (invoiceDiscount.lt(0) || invoiceDiscount.gt(linesPatient)) throw badRequest(membership ? 'الخصم أكبر من حصة المريض' : 'الخصم أكبر من قيمة الفاتورة');
  const total = linesTotal.sub(invoiceDiscount);
  const patientShare = linesPatient.sub(invoiceDiscount);

  return {
    header: {
      patientId: patient.id, visitId: input.visitId ?? null, doctorId, templateId: template?.id ?? null, notes: input.notes ?? null,
      subtotal, itemsDiscount, invoiceDiscount, discountTotal: itemsDiscount.add(invoiceDiscount), taxTotal, total, balance: patientShare,
      payerType: membership ? ('INSURANCE' as const) : ('SELF_PAY' as const),
      patientInsuranceId: membership?.id ?? null, insuranceCompanyId: membership?.companyId ?? null,
      insuranceContractId: membership?.contractId ?? null, insuranceMemberId: membership?.memberId ?? null,
      patientShare, insuranceShare,
    },
    items: items.map(({ _service, _input, ...rest }) => rest), // eslint-disable-line @typescript-eslint/no-unused-vars
    warnings,
    insurance: membership && coverage ? {
      company: membership.contract.company.nameAr, contract: membership.contract.name, memberId: membership.memberId,
      limit: coverage.limit.limit, used: coverage.limit.used, remaining: coverage.limit.remaining,
      lines: coverage.lines.map((c) => ({ requiresApproval: c.requiresApproval, requiresReport: c.requiresReport, approvalMissing: c.approvalMissing })),
    } : null,
  };
}

/** Deducts stock for catalog items linked to inventory (e.g. medications sold by the clinic). */
async function moveStockForInvoice(tx: Tx, ctx: Ctx, invoiceId: string, invoiceNumber: string, reverse: boolean) {
  const items = await tx.invoiceItem.findMany({ where: { invoiceId }, include: { service: { select: { inventoryItemId: true } } } });
  for (const it of items) {
    if (!it.service.inventoryItemId) continue;
    await recordMovement(tx, ctx, {
      itemId: it.service.inventoryItemId, type: reverse ? 'SALE_REVERSAL' : 'SALE', quantity: it.quantity,
      reason: reverse ? 'إلغاء فاتورة' : 'بيع عبر فاتورة', reference: invoiceNumber, referenceType: 'invoice', referenceId: invoiceId,
    });
  }
}

export async function issueInvoice(tx: Tx, ctx: Ctx, invoiceId: string) {
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw notFound();
  if (inv.status !== 'DRAFT') throw badRequest('الفاتورة صادرة مسبقاً');
  // The insurance must still be valid on the day the invoice is issued.
  if (inv.patientInsuranceId) await usableMembership(tx, inv.patientId, inv.patientInsuranceId);
  const fin = await getSetting('financial', tx);
  const n = await nextCounter(tx, 'invoice'); // single serial shared by all invoice templates
  // The invoice date is the requested (back-dated) one kept on the draft, else now. The real issue moment is
  // kept apart, and the due date runs from it so a back-dated invoice is not instantly overdue.
  const recordedAt = new Date();
  const issuedAt = inv.issuedAt ?? recordedAt;
  const invoiceNumber = `${fin.invoicePrefix}${pad(n, 6)}`;
  const updated = await tx.invoice.update({
    where: { id: inv.id },
    data: {
      invoiceNumber, issuedAt, issuedRecordedAt: recordedAt, status: D(inv.patientShare).eq(0) ? 'PAID' : 'ISSUED',
      dueDate: fin.invoiceDueDays > 0 ? addDays(recordedAt, fin.invoiceDueDays) : recordedAt,
    },
  });
  await moveStockForInvoice(tx, ctx, inv.id, invoiceNumber, false);
  await audit(tx, ctx, {
    action: 'invoice.issue', entityType: 'invoice', entityId: inv.id,
    summary: `إصدار الفاتورة ${invoiceNumber} بقيمة ${D(inv.total).toNumber()}${ymd(issuedAt) !== ymd(recordedAt) ? ` بتاريخ ${ymd(issuedAt)}` : ''}${D(inv.insuranceShare).gt(0) ? ` (حصة التأمين ${D(inv.insuranceShare).toNumber()}، حصة المريض ${D(inv.patientShare).toNumber()})` : ''}`,
  });
  // The company's share becomes an insurance receivable through its claim.
  await createClaimForInvoice(tx, ctx, inv.id);
  // National e-invoicing: documents prepared now (fixed number + UUID), sent once this transaction commits.
  await prepareSaleDocs(tx, ctx, inv.id);
  // Nothing left for the patient to pay (e.g. fully covered) → the visit is done.
  if (updated.status === 'PAID' && inv.visitId) {
    const visit = await tx.visit.findUnique({ where: { id: inv.visitId }, select: { status: true } });
    if (visit?.status === 'WAITING_PAYMENT') await changeVisitStatus(tx, ctx, inv.visitId, 'COMPLETED', 'لا يوجد مبلغ على المريض', { system: true });
  }
  return updated;
}

/** Recalculates paid/refunded/balance/status from the payment rows (single source of truth). */
export async function recomputeInvoice(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const sums = await tx.payment.groupBy({ by: ['type'], where: { invoiceId, voidedAt: null }, _sum: { amount: true } });
  const paid = D(sums.find((s) => s.type === 'PAYMENT')?._sum.amount);
  const refunded = D(sums.find((s) => s.type === 'REFUND')?._sum.amount);
  // Refunds return money AND write off the same amount, so the balance owed is (patient share) − payments.
  // The patient owes their share plus any insurance amount the clinic transferred back to them.
  const owed = D(inv.patientShare).add(inv.transferredFromInsurance);
  const balance = Prisma.Decimal.max(owed.sub(paid), 0);
  let status: InvoiceStatus = inv.status;
  if (!['DRAFT', 'CANCELLED'].includes(inv.status)) {
    if (refunded.gt(0) && refunded.gte(paid)) status = 'REFUNDED';
    else if (balance.eq(0)) status = 'PAID';
    else if (inv.dueDate && inv.dueDate < new Date() && paid.lt(owed)) status = 'OVERDUE';
    else if (paid.gt(0)) status = 'PARTIALLY_PAID';
    else status = 'ISSUED';
  }
  return tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount: paid, refundedAmount: refunded, balance, status } });
}

export interface PaymentInput {
  amount: number;
  methodId: string;
  reference?: string | null;
  notes?: string | null;
  paidAt?: Date;
}

export async function addPayment(tx: Tx, ctx: Ctx, invoiceId: string, p: PaymentInput, type: 'PAYMENT' | 'REFUND' = 'PAYMENT') {
  // Lock the invoice row to serialise concurrent payments.
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw notFound('الفاتورة غير موجودة');
  if (inv.status === 'DRAFT') throw badRequest('يجب إصدار الفاتورة قبل تسجيل الدفع');
  if (inv.status === 'CANCELLED') throw badRequest('الفاتورة ملغاة');
  const method = await tx.paymentMethod.findFirst({ where: { id: p.methodId, isActive: true } });
  if (!method) throw badRequest('طريقة الدفع غير متاحة');
  if (method.requiresReference && !p.reference) throw badRequest(`رقم العملية مطلوب للدفع عبر ${method.name}`);
  const amount = r3(p.amount);
  if (amount.lte(0)) throw badRequest('المبلغ يجب أن يكون أكبر من صفر');
  if (type === 'PAYMENT' && amount.gt(inv.balance)) throw badRequest(`المبلغ أكبر من المتبقي (${D(inv.balance).toNumber()})`);
  if (type === 'REFUND' && amount.gt(D(inv.paidAmount).sub(inv.refundedAmount))) throw badRequest('مبلغ الإرجاع أكبر من المبلغ المدفوع');
  const paidAt = p.paidAt ?? new Date();
  if (p.paidAt) await checkPaidAt(tx, ctx, inv, paidAt, type);

  const fin = await getSetting('financial', tx);
  const n = await nextCounter(tx, 'receipt');
  const payment = await tx.payment.create({
    data: {
      receiptNumber: `${type === 'REFUND' ? 'RF-' : fin.receiptPrefix}${pad(n, 6)}`, invoiceId: inv.id, patientId: inv.patientId, type, amount,
      methodId: method.id, reference: p.reference ?? null, notes: p.notes ?? null, paidAt, receivedById: ctx.userId,
    },
    include: { method: true },
  });
  const updated = await recomputeInvoice(tx, inv.id);
  await audit(tx, ctx, {
    action: type === 'REFUND' ? 'payment.refund' : 'payment.create', entityType: 'invoice', entityId: inv.id,
    summary: `${type === 'REFUND' ? 'إرجاع' : 'دفعة'} ${amount.toNumber()} (${method.name}) على ${inv.invoiceNumber} — إيصال ${payment.receiptNumber}`,
    before: { paidAmount: D(inv.paidAmount).toNumber(), balance: D(inv.balance).toNumber(), status: inv.status },
    after: { paidAmount: D(updated.paidAmount).toNumber(), balance: D(updated.balance).toNumber(), status: updated.status },
  });
  // Fully paid → close the visit if it was waiting at the cashier.
  if (type === 'PAYMENT' && updated.status === 'PAID' && inv.visitId) {
    const visit = await tx.visit.findUnique({ where: { id: inv.visitId }, select: { status: true } });
    if (visit?.status === 'WAITING_PAYMENT') await changeVisitStatus(tx, ctx, inv.visitId, 'COMPLETED', 'تم الدفع', { system: true });
  }
  return { payment, invoice: updated };
}

export async function cancelInvoice(tx: Tx, ctx: Ctx, invoiceId: string, reason: string) {
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw notFound();
  if (inv.status === 'CANCELLED') throw badRequest('الفاتورة ملغاة مسبقاً');
  const netPaid = D(inv.paidAmount).sub(inv.refundedAmount);
  if (netPaid.gt(0)) throw new AppError(409, 'HAS_PAYMENTS', 'لا يمكن إلغاء فاتورة عليها مدفوعات. قم بإرجاع المبلغ أولاً');
  // Before anything changes: refused while a national submission's outcome is unknown; otherwise accepted national
  // documents get a return invoice and unsent ones are voided.
  await onInvoiceCancel(tx, ctx, inv.id, reason);
  await cancelClaimWithInvoice(tx, ctx, inv.id, reason);
  const updated = await tx.invoice.update({
    where: { id: inv.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: reason, balance: 0 },
  });
  if (inv.invoiceNumber) await moveStockForInvoice(tx, ctx, inv.id, inv.invoiceNumber, true);
  await audit(tx, ctx, { action: 'invoice.cancel', entityType: 'invoice', entityId: inv.id, summary: `إلغاء الفاتورة ${inv.invoiceNumber ?? '(مسودة)'}: ${reason}`, before: { status: inv.status }, after: { status: 'CANCELLED', reason } });
  return updated;
}

// ── Invoice date (back-dating) ──

/** The given day (YYYY-MM-DD, clinic time) at the time of day of `time`, so order within a day stays natural. */
const onDay = (day: string, time: Date) => {
  const d = new Date(`${day}T00:00:00`);
  d.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), 0);
  return d;
};

/**
 * Invoice date requested when creating or editing an invoice. Nothing or today → null (the moment of issue).
 * An earlier day needs invoices.backdate; a future day is never allowed. `current` is the date the invoice
 * already holds: keeping it needs no permission (e.g. a receptionist finishing a draft an admin back-dated).
 */
export function requestedInvoiceDate(ctx: Ctx, day: string | null | undefined, current: Date | null = null): Date | null {
  if (!day) return current;
  const today = ymd(new Date());
  if (day > today) throw badRequest('لا يمكن أن يكون تاريخ الفاتورة في المستقبل');
  if (current && ymd(current) === day) return current;
  if (day === today) return null;
  if (!can(ctx, 'invoices.backdate')) throw forbidden('لا تملك صلاحية تحديد تاريخ سابق للفاتورة');
  return onDay(day, new Date());
}

/**
 * Changes the approved date of an existing invoice. Only the date moves: amounts, lines, payments, status and
 * due date stay as they are. Refused when it would contradict records that already depend on the date.
 */
export async function changeInvoiceDate(tx: Tx, ctx: Ctx, invoiceId: string, day: string, reason: string | null) {
  if (!can(ctx, 'invoices.backdate')) throw forbidden('لا تملك صلاحية تعديل تاريخ الفاتورة');
  const inv = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      claim: { select: { claimNumber: true, status: true } },
      payments: { where: { voidedAt: null, type: 'PAYMENT' }, orderBy: { paidAt: 'asc' }, take: 1, select: { paidAt: true, receiptNumber: true } },
    },
  });
  if (!inv) throw notFound();
  if (inv.status === 'CANCELLED') throw badRequest('لا يمكن تعديل تاريخ فاتورة ملغاة');
  if (day > ymd(new Date())) throw badRequest('لا يمكن أن يكون تاريخ الفاتورة في المستقبل');
  const old = inv.issuedAt ?? inv.createdAt;
  if (ymd(old) === day) throw badRequest('التاريخ الجديد مطابق لتاريخ الفاتورة الحالي');
  // A claim already sent to the insurer carries this invoice's date: changing it here would contradict the claim.
  if (inv.claim && !['DRAFT', 'READY', 'CANCELLED'].includes(inv.claim.status)) {
    throw badRequest(`لا يمكن تعديل التاريخ: مطالبة التأمين ${inv.claim.claimNumber} أُرسلت لشركة التأمين. يجب معالجة المطالبة أولاً (إلغاء الفاتورة وإصدار فاتورة جديدة بالتاريخ الصحيح)`);
  }
  // Money cannot be received for an invoice before the invoice exists.
  const first = inv.payments[0];
  if (first && ymd(first.paidAt) < day) {
    throw badRequest(`لا يمكن جعل تاريخ الفاتورة بعد تاريخ أول دفعة عليها (${ymd(first.paidAt)}، سند ${first.receiptNumber})`);
  }
  // An invoice already accepted by the national system keeps the date it was reported with.
  await onInvoiceDateChange(tx, inv.id, day);
  const issuedAt = onDay(day, old);
  await tx.invoice.update({ where: { id: inv.id }, data: { issuedAt } });
  await audit(tx, ctx, {
    action: 'invoice.date_change', entityType: 'invoice', entityId: inv.id,
    summary: `تعديل تاريخ الفاتورة ${inv.invoiceNumber ?? '(مسودة)'} من ${ymd(old)} إلى ${day}${reason ? ` — السبب: ${reason}` : ''}`,
    before: { invoiceNumber: inv.invoiceNumber, invoiceDate: ymd(old) },
    after: { invoiceNumber: inv.invoiceNumber, invoiceDate: day, reason },
  });
  return { oldDate: ymd(old), newDate: day };
}

// ── Receipt date (back-dating) ──

/**
 * Rules for the date money was received or refunded: never in the future; an earlier day needs payments.backdate;
 * not before the invoice date; a refund not before the first payment, and (when moving a payment) a payment not
 * after the first refund.
 */
async function checkPaidAt(
  tx: Tx, ctx: Ctx, inv: { id: string; issuedAt: Date | null; createdAt: Date }, when: Date, type: 'PAYMENT' | 'REFUND', movingId?: string,
) {
  const day = ymd(when);
  if (day > ymd(new Date())) throw badRequest('لا يمكن أن يكون تاريخ القبض في المستقبل');
  if (day < ymd(new Date()) && !can(ctx, 'payments.backdate')) throw forbidden('لا تملك صلاحية تحديد تاريخ سابق للقبض');
  const invDay = ymd(inv.issuedAt ?? inv.createdAt);
  if (day < invDay) throw badRequest(`لا يمكن أن يكون تاريخ القبض قبل تاريخ الفاتورة (${invDay})`);
  const other = await tx.payment.findFirst({
    where: { invoiceId: inv.id, voidedAt: null, type: type === 'REFUND' ? 'PAYMENT' : 'REFUND', ...(movingId && { id: { not: movingId } }) },
    orderBy: { paidAt: 'asc' }, select: { paidAt: true, receiptNumber: true },
  });
  if (!other) return;
  if (type === 'REFUND' && day < ymd(other.paidAt)) throw badRequest(`لا يمكن أن يكون تاريخ الإرجاع قبل تاريخ أول دفعة (${ymd(other.paidAt)}، سند ${other.receiptNumber})`);
  if (type === 'PAYMENT' && movingId && day > ymd(other.paidAt)) throw badRequest(`لا يمكن جعل تاريخ الدفعة بعد تاريخ الإرجاع ${other.receiptNumber} (${ymd(other.paidAt)})`);
}

/**
 * Changes the date of a recorded receipt (payment or refund). Only the date moves — amount, method, invoice
 * balances and status stay as they are; the cash summary follows the new date. Audited (append-only log).
 */
export async function changePaymentDate(tx: Tx, ctx: Ctx, paymentId: string, day: string, reason: string | null) {
  if (!can(ctx, 'payments.backdate')) throw forbidden('لا تملك صلاحية تعديل تاريخ القبض');
  const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { invoice: { select: { id: true, invoiceNumber: true, issuedAt: true, createdAt: true } } } });
  if (!p) throw notFound();
  if (p.voidedAt) throw badRequest('لا يمكن تعديل تاريخ دفعة ملغاة');
  const old = ymd(p.paidAt);
  if (old === day) throw badRequest('التاريخ الجديد مطابق لتاريخ القبض الحالي');
  const paidAt = onDay(day, p.paidAt);
  await checkPaidAt(tx, ctx, p.invoice, paidAt, p.type, p.id);
  await tx.payment.update({ where: { id: p.id }, data: { paidAt } });
  await audit(tx, ctx, {
    action: 'payment.date_change', entityType: 'payment', entityId: p.id,
    summary: `تعديل تاريخ ${p.type === 'REFUND' ? 'الإرجاع' : 'الإيصال'} ${p.receiptNumber} (فاتورة ${p.invoice.invoiceNumber}) من ${old} إلى ${day}${reason ? ` — السبب: ${reason}` : ''}`,
    before: { paidAt: old }, after: { paidAt: day, reason },
  });
  return { receiptNumber: p.receiptNumber, oldDate: old, newDate: day };
}
