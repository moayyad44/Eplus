import { Prisma, type InvoiceStatus } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import { can } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { nextCounter, pad } from '../../lib/counters';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { D, r3 } from '../../lib/money';
import { getSetting } from '../../lib/settings';
import { addDays } from '../../lib/dates';
import { recordMovement } from '../inventory/service';
import { changeVisitStatus } from '../visits/service';

export interface InvoiceItemInput {
  serviceId: string;
  quantity: number;
  unitPrice?: number | null;
  discount?: number | null;
}

export interface InvoiceInput {
  patientId: string;
  visitId?: string | null;
  doctorId?: string | null;
  templateId?: string | null;
  items: InvoiceItemInput[];
  invoiceDiscount?: number;
  notes?: string | null;
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
  if (input.visitId) {
    const visit = await tx.visit.findUnique({ where: { id: input.visitId } });
    if (!visit || visit.patientId !== patient.id) throw badRequest('الزيارة لا تخص هذا المريض');
    doctorId = doctorId ?? visit.doctorId;
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
    let unitPrice = D(s.price);
    if (l.unitPrice != null && !D(l.unitPrice).eq(s.price)) {
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
    };
  });

  const invoiceDiscount = r3(input.invoiceDiscount ?? 0);
  if (invoiceDiscount.gt(0) && !can(ctx, 'invoices.discount')) throw forbidden('لا تملك صلاحية منح الخصم');
  if (invoiceDiscount.lt(0) || invoiceDiscount.gt(linesTotal)) throw badRequest('الخصم أكبر من قيمة الفاتورة');
  const total = linesTotal.sub(invoiceDiscount);

  return {
    header: {
      patientId: patient.id, visitId: input.visitId ?? null, doctorId, templateId: template?.id ?? null, notes: input.notes ?? null,
      subtotal, itemsDiscount, invoiceDiscount, discountTotal: itemsDiscount.add(invoiceDiscount), taxTotal, total, balance: total,
    },
    items,
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
  const fin = await getSetting('financial', tx);
  const n = await nextCounter(tx, 'invoice'); // single serial shared by all invoice templates
  const issuedAt = new Date();
  const invoiceNumber = `${fin.invoicePrefix}${pad(n, 6)}`;
  const updated = await tx.invoice.update({
    where: { id: inv.id },
    data: {
      invoiceNumber, issuedAt, status: D(inv.total).eq(0) ? 'PAID' : 'ISSUED',
      dueDate: fin.invoiceDueDays > 0 ? addDays(issuedAt, fin.invoiceDueDays) : issuedAt,
    },
  });
  await moveStockForInvoice(tx, ctx, inv.id, invoiceNumber, false);
  await audit(tx, ctx, { action: 'invoice.issue', entityType: 'invoice', entityId: inv.id, summary: `إصدار الفاتورة ${invoiceNumber} بقيمة ${D(inv.total).toNumber()}` });
  return updated;
}

/** Recalculates paid/refunded/balance/status from the payment rows (single source of truth). */
export async function recomputeInvoice(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const sums = await tx.payment.groupBy({ by: ['type'], where: { invoiceId, voidedAt: null }, _sum: { amount: true } });
  const paid = D(sums.find((s) => s.type === 'PAYMENT')?._sum.amount);
  const refunded = D(sums.find((s) => s.type === 'REFUND')?._sum.amount);
  // Refunds return money AND write off the same amount, so the balance owed is total − payments.
  const balance = Prisma.Decimal.max(D(inv.total).sub(paid), 0);
  let status: InvoiceStatus = inv.status;
  if (!['DRAFT', 'CANCELLED'].includes(inv.status)) {
    if (refunded.gt(0) && refunded.gte(paid)) status = 'REFUNDED';
    else if (balance.eq(0)) status = 'PAID';
    else if (inv.dueDate && inv.dueDate < new Date() && paid.lt(inv.total)) status = 'OVERDUE';
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

  const fin = await getSetting('financial', tx);
  const n = await nextCounter(tx, 'receipt');
  const payment = await tx.payment.create({
    data: {
      receiptNumber: `${type === 'REFUND' ? 'RF-' : fin.receiptPrefix}${pad(n, 6)}`, invoiceId: inv.id, patientId: inv.patientId, type, amount,
      methodId: method.id, reference: p.reference ?? null, notes: p.notes ?? null, paidAt: p.paidAt ?? new Date(), receivedById: ctx.userId,
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
  const updated = await tx.invoice.update({
    where: { id: inv.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: reason, balance: 0 },
  });
  if (inv.invoiceNumber) await moveStockForInvoice(tx, ctx, inv.id, inv.invoiceNumber, true);
  await audit(tx, ctx, { action: 'invoice.cancel', entityType: 'invoice', entityId: inv.id, summary: `إلغاء الفاتورة ${inv.invoiceNumber ?? '(مسودة)'}: ${reason}`, before: { status: inv.status }, after: { status: 'CANCELLED', reason } });
  return updated;
}
