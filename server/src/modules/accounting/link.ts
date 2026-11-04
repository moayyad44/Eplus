import { Prisma, type JournalType, type ServiceCategory } from '@prisma/client';
import { prisma, type Db, type Tx } from '../../lib/prisma';
import { getSetting } from '../../lib/settings';
import { ymd, dateOnlyStr } from '../../lib/dates';
import { D, r3 } from '../../lib/money';
import { notifyPermission } from '../../lib/notify';
import { createEntry, deleteEntry, ensureOpenPeriod, dayOf, updateEntry, type LineInput } from './journal';
import { planDoc } from './docs';
import { trackVisa } from './visa';

/**
 * Link between EmergencyPlus and the books.
 *
 * Every financial operation queues its key ("invoice:<id>", "payment:<id>"…) in the SAME transaction as the
 * operation itself, so nothing is ever lost. The queue is then turned into journal entries: each key owns exactly
 * one entry, rebuilt from the operation's current state, so a retry or a re-queue never duplicates anything and an
 * edit of the operation updates its entry. A cancelled operation removes its entry (or reverses it when its period
 * is closed). Failures are kept with their reason and can be retried.
 */

export type Kind = 'invoice' | 'invoice-cancel' | 'payment' | 'expense' | 'supplier-payment' | 'po' | 'inv-move' | 'ins-payment' | 'claim-event' | DocKind;
export type DocKind = 'voucher' | 'transfer' | 'cash-count' | 'visa-settlement' | 'cheque-event' | 'advance' | 'payroll' | 'payroll-pay' | 'asset' | 'depreciation' | 'asset-disposal' | 'year-close';

/** Queue (or re-queue) an operation. Call inside the operation's own transaction. */
export async function enqueue(tx: Db, kind: Kind, sourceId: string) {
  const sourceKey = `${kind}:${sourceId}`;
  await tx.accountingEvent.upsert({
    where: { sourceKey },
    create: { sourceKey, kind, sourceId },
    update: { status: 'PENDING', queuedAt: new Date(), lastError: null, note: null },
  });
  kick();
}

/** All payments of an invoice depend on each other (overpayments, refunds): re-queue them together. */
export async function enqueueInvoicePayments(tx: Db, invoiceId: string) {
  const ps = await tx.payment.findMany({ where: { invoiceId }, select: { id: true } });
  for (const p of ps) await enqueue(tx, 'payment', p.id);
}

let timer: NodeJS.Timeout | null = null;
/** Process the queue shortly after the operation commits (tests call processPending directly). */
export function kick() {
  if (process.env.NODE_ENV === 'test' || timer) return;
  timer = setTimeout(() => { timer = null; processPending().catch((e) => console.error('[accounting link]', e)); }, 300);
}

// ───────────── Account mapping ─────────────

/** Roles the automatic entries use; each can be pointed at any account from the settings. */
export const ROLES = [
  'CASH_MAIN', 'VISA_CLEARING', 'EPAY_CLEARING', 'AR_PATIENTS', 'AR_INSURANCE', 'PATIENT_CREDITS', 'DISCOUNTS_GIVEN', 'SALES_TAX',
  'AP_SUPPLIERS', 'INVENTORY', 'COGS', 'EXP_MEDICAL_SUPPLIES', 'EXP_PURCHASES', 'COUNT_DIFFERENCES', 'BAD_DEBTS', 'EXP_OTHER', 'OPENING_BALANCES',
  'CHEQUES_ON_HAND', 'CHEQUES_UNDER_COLLECTION', 'CHEQUES_ISSUED', 'AR_OTHER', 'BANK_CHARGES', 'VISA_FEES', 'SALARIES', 'SALARIES_PAYABLE', 'EMPLOYEE_ADVANCES',
  'DEPRECIATION', 'ACCUM_DEPRECIATION', 'GAIN_ON_DISPOSAL', 'LOSS_ON_DISPOSAL', 'RETAINED_EARNINGS',
] as const;
/** Roles without an account of their own in the starting chart use this one until mapped. */
const ROLE_FALLBACK: Record<string, string> = { GAIN_ON_DISPOSAL: 'REV_OTHER', LOSS_ON_DISPOSAL: 'EXP_OTHER' };
export const REVENUE_DEFAULT: Record<ServiceCategory, string> = {
  EXAMINATION: 'REV_CONSULTATION', CONSULTATION: 'REV_CONSULTATION', PROCEDURE: 'REV_SERVICES', LAB: 'REV_LAB', NURSING: 'REV_SERVICES', MEDICATION: 'REV_MEDICATION', OTHER: 'REV_OTHER',
};
const METHOD_DEFAULT: Record<string, string> = { CASH: 'CASH_MAIN', VISA: 'VISA_CLEARING' };

export async function loadMapping(db: Db = prisma) {
  const cfg = await getSetting('accounting', db);
  const keyed = await db.account.findMany({ where: { systemKey: { not: null } }, select: { id: true, systemKey: true } });
  const byKey = new Map(keyed.map((a) => [a.systemKey!, a.id]));
  const methods = await db.paymentMethod.findMany({ select: { id: true, code: true, name: true } });
  const role = (k: string) => {
    const id = cfg.accountMap[k] ?? byKey.get(k) ?? (ROLE_FALLBACK[k] ? byKey.get(ROLE_FALLBACK[k]) : undefined);
    if (!id) throw new Error(`لم يُحدَّد حساب للدور ${k} في إعدادات الربط`);
    return id;
  };
  return {
    cfg,
    role,
    method: (methodId: string | null | undefined) => {
      if (methodId && cfg.methodAccounts[methodId]) return cfg.methodAccounts[methodId];
      const code = methods.find((m) => m.id === methodId)?.code;
      return role(methodId ? METHOD_DEFAULT[code ?? ''] ?? 'EPAY_CLEARING' : 'CASH_MAIN');
    },
    expense: (categoryId: string) => cfg.expenseAccounts[categoryId] ?? role('EXP_OTHER'),
    revenue: (cat: ServiceCategory) => cfg.revenueAccounts[cat] ?? role(REVENUE_DEFAULT[cat]),
    methodName: (methodId: string | null | undefined) => methods.find((m) => m.id === methodId)?.name ?? '',
  };
}
export type Mapping = Awaited<ReturnType<typeof loadMapping>>;

// ───────────── What each operation should look like in the books ─────────────

export type Plan =
  | { do: 'post'; date: string; type: JournalType; description: string; reference?: string | null; lines: LineInput[] }
  | { do: 'undo'; why: string }
  | { do: 'skip'; note: string };

export const L = (accountId: string, debit: Prisma.Decimal.Value, credit: Prisma.Decimal.Value, extra: Partial<LineInput> = {}): LineInput =>
  ({ accountId, debit: r3(D(debit)), credit: r3(D(credit)), ...extra });
export const nonZero = (lines: LineInput[]) => lines.filter((l) => D(l.debit).gt(0) || D(l.credit).gt(0));

/** How each payment of an invoice splits: what settles the receivable, what is an overpayment, what a refund takes back. */
async function paymentSplits(db: Db, invoiceId: string) {
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const pays = await db.payment.findMany({ where: { invoiceId, voidedAt: null }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] });
  const owed = D(inv.patientShare).add(inv.transferredFromInsurance);
  let settled = D(0), credit = D(0);
  const out = new Map<string, { toAR: Prisma.Decimal; toCredit: Prisma.Decimal; fromCredit: Prisma.Decimal; toAllowance: Prisma.Decimal }>();
  for (const p of pays) {
    const a = D(p.amount);
    if (p.type === 'PAYMENT') {
      const toAR = Prisma.Decimal.min(a, Prisma.Decimal.max(owed.sub(settled), 0));
      settled = settled.add(toAR); credit = credit.add(a.sub(toAR));
      out.set(p.id, { toAR, toCredit: a.sub(toAR), fromCredit: D(0), toAllowance: D(0) });
    } else {
      const fromCredit = Prisma.Decimal.min(a, credit);
      credit = credit.sub(fromCredit);
      out.set(p.id, { toAR: D(0), toCredit: D(0), fromCredit, toAllowance: a.sub(fromCredit) });
    }
  }
  return out;
}

async function plan(db: Db, kind: Kind, id: string, m: Mapping): Promise<Plan> {
  const perpetual = m.cfg.inventoryMethod === 'PERPETUAL';
  switch (kind) {
    case 'invoice': {
      const inv = await db.invoice.findUnique({ where: { id }, include: { items: true, patient: { select: { fullName: true } }, insuranceCompany: { select: { nameAr: true } } } });
      if (!inv || !inv.issuedAt || inv.status === 'DRAFT') return { do: 'skip', note: 'فاتورة غير صادرة' };
      const patient = { partyType: 'PATIENT', partyId: inv.patientId, partyName: inv.patient.fullName };
      const lines: LineInput[] = [];
      const byCat = new Map<ServiceCategory, Prisma.Decimal>();
      for (const it of inv.items) byCat.set(it.category, (byCat.get(it.category) ?? D(0)).add(D(it.unitPrice).mul(it.quantity)));
      for (const [cat, v] of byCat) lines.push(L(m.revenue(cat), 0, v, { doctorId: inv.doctorId, description: 'إيراد خدمات' }));
      lines.push(L(m.role('DISCOUNTS_GIVEN'), inv.discountTotal, 0, { ...patient, description: 'خصم' }));
      lines.push(L(m.role('SALES_TAX'), 0, inv.taxTotal));
      lines.push(L(m.role('AR_PATIENTS'), inv.patientShare, 0, { ...patient, description: 'حصة المريض' }));
      lines.push(L(m.role('AR_INSURANCE'), inv.insuranceShare, 0, { partyType: 'INSURANCE', partyId: inv.insuranceCompanyId, partyName: inv.insuranceCompany?.nameAr ?? null, description: 'حصة شركة التأمين' }));
      if (perpetual) {
        const sold = await db.inventoryTransaction.findMany({ where: { referenceType: 'invoice', referenceId: inv.id, type: 'SALE' }, include: { item: { select: { purchasePrice: true } } } });
        const cost = sold.reduce((t, s) => t.add(D(s.quantity).abs().mul(s.unitCost ?? s.item.purchasePrice)), D(0));
        lines.push(L(m.role('COGS'), cost, 0, { description: 'تكلفة الأصناف المباعة' }), L(m.role('INVENTORY'), 0, cost));
      }
      const real = nonZero(lines);
      if (!real.length) return { do: 'skip', note: 'فاتورة بقيمة صفر' };
      return { do: 'post', date: ymd(inv.issuedAt), type: 'REVENUE', description: `فاتورة ${inv.invoiceNumber} — ${inv.patient.fullName}`, reference: inv.invoiceNumber, lines: real };
    }
    case 'invoice-cancel': {
      const inv = await db.invoice.findUnique({ where: { id } });
      if (!inv || inv.status !== 'CANCELLED' || !inv.cancelledAt) return { do: 'undo', why: 'الفاتورة غير ملغاة' };
      const orig = await db.journalEntry.findUnique({ where: { sourceKey: `invoice:${id}` }, include: { lines: true } });
      if (!orig || orig.status === 'DELETED') return { do: 'skip', note: 'لا يوجد قيد للفاتورة (صدرت قبل بدء المحاسبة): عالج أثر الإلغاء يدوياً إن لزم' };
      const lines = orig.lines.map((l) => L(l.accountId, l.credit, l.debit, { partyType: l.partyType, partyId: l.partyId, partyName: l.partyName, doctorId: l.doctorId, description: 'عكس الفاتورة الملغاة' }));
      // Refunds that were booked as allowances reopen the receivable that the reversal now closes.
      const splits = await paymentSplits(db, id);
      const allowance = [...splits.values()].reduce((t, s) => t.add(s.toAllowance), D(0));
      lines.push(L(m.role('AR_PATIENTS'), allowance, 0, { partyType: 'PATIENT', partyId: inv.patientId }), L(m.role('DISCOUNTS_GIVEN'), 0, allowance));
      return { do: 'post', date: ymd(inv.cancelledAt), type: 'CORRECTION', description: `إلغاء الفاتورة ${inv.invoiceNumber}${inv.cancelReason ? `: ${inv.cancelReason}` : ''}`, reference: inv.invoiceNumber, lines: nonZero(lines) };
    }
    case 'payment': {
      const p = await db.payment.findUnique({ where: { id }, include: { invoice: { select: { id: true, invoiceNumber: true, issuedAt: true } }, patient: { select: { fullName: true } } } });
      if (!p) return { do: 'undo', why: 'الدفعة غير موجودة' };
      if (p.voidedAt) return { do: 'undo', why: 'دفعة ملغاة' };
      const s = (await paymentSplits(db, p.invoiceId)).get(p.id)!;
      const party = { partyType: 'PATIENT', partyId: p.patientId, partyName: p.patient.fullName };
      const cash = m.method(p.methodId);
      const lines = p.type === 'PAYMENT'
        ? [L(cash, p.amount, 0, { description: m.methodName(p.methodId) }), L(m.role('AR_PATIENTS'), 0, s.toAR, party), L(m.role('PATIENT_CREDITS'), 0, s.toCredit, { ...party, description: 'مبلغ مدفوع بالزيادة' })]
        : [L(m.role('PATIENT_CREDITS'), s.fromCredit, 0, { ...party, description: 'إرجاع الزيادة' }), L(m.role('DISCOUNTS_GIVEN'), s.toAllowance, 0, { ...party, description: 'مرتجع للمريض' }), L(cash, 0, p.amount, { description: m.methodName(p.methodId) })];
      return { do: 'post', date: ymd(p.paidAt), type: p.type === 'PAYMENT' ? 'RECEIPT' : 'PAYMENT', description: `${p.type === 'PAYMENT' ? 'قبض' : 'إرجاع'} — إيصال ${p.receiptNumber} — فاتورة ${p.invoice.invoiceNumber ?? ''}`, reference: p.receiptNumber, lines: nonZero(lines) };
    }
    case 'expense': {
      const e = await db.expense.findUnique({ where: { id }, include: { category: { select: { name: true } } } });
      if (!e || e.voidedAt) return { do: 'undo', why: 'مصروف ملغى' };
      return {
        do: 'post', date: dateOnlyStr(e.expenseDate), type: 'EXPENSE', description: `مصروف: ${e.category.name} — ${e.description}`, reference: e.reference,
        lines: [L(m.expense(e.categoryId), e.amount, 0, { description: e.description }), L(m.method(e.paymentMethodId), 0, e.amount, { description: m.methodName(e.paymentMethodId) || 'نقداً' })],
      };
    }
    case 'supplier-payment': {
      const p = await db.supplierPayment.findUnique({ where: { id }, include: { supplier: { select: { name: true } } } });
      if (!p || p.voidedAt) return { do: 'undo', why: 'دفعة مورد ملغاة' };
      const party = { partyType: 'SUPPLIER', partyId: p.supplierId, partyName: p.supplier.name };
      return { do: 'post', date: ymd(p.paidAt), type: 'PAYMENT', description: `دفعة للمورد ${p.supplier.name}`, reference: p.reference, lines: [L(m.role('AP_SUPPLIERS'), p.amount, 0, party), L(m.method(p.methodId), 0, p.amount, { description: m.methodName(p.methodId) })] };
    }
    case 'po': {
      const po = await db.purchaseOrder.findUnique({ where: { id }, include: { supplier: { select: { name: true } } } });
      if (!po || po.status !== 'RECEIVED' || !po.receivedAt) return { do: 'undo', why: 'أمر شراء غير مستلم' };
      const party = { partyType: 'SUPPLIER', partyId: po.supplierId, partyName: po.supplier.name };
      return { do: 'post', date: ymd(po.receivedAt), type: 'PURCHASE', description: `استلام أمر الشراء ${po.poNumber} — ${po.supplier.name}`, reference: po.poNumber, lines: nonZero([L(m.role(perpetual ? 'INVENTORY' : 'EXP_PURCHASES'), po.total, 0), L(m.role('AP_SUPPLIERS'), 0, po.total, party)]) };
    }
    case 'inv-move': {
      if (!perpetual) return { do: 'skip', note: 'الجرد الدوري: لا تُقيَّد حركات المخزون' };
      const t = await db.inventoryTransaction.findUnique({ where: { id }, include: { item: { select: { name: true, purchasePrice: true } }, warehouse: { select: { name: true } } } });
      if (!t) return { do: 'undo', why: 'حركة غير موجودة' };
      const value = r3(D(t.quantity).abs().mul(t.unitCost ?? t.item.purchasePrice));
      if (value.eq(0)) return { do: 'skip', note: 'قيمة الحركة صفر (لا يوجد سعر شراء للصنف)' };
      const inv = m.role('INVENTORY');
      const other = ['CONSUMPTION', 'ISSUE', 'RETURN'].includes(t.type) ? m.role('EXP_MEDICAL_SUPPLIES') : ['RECEIPT', 'ADJUSTMENT', 'STOCK_COUNT'].includes(t.type) ? m.role('COUNT_DIFFERENCES') : null;
      if (!other) return { do: 'skip', note: 'حركة لا تُقيَّد منفصلة' };
      const into = D(t.quantity).gt(0);
      return {
        do: 'post', date: ymd(t.createdAt), type: 'ADJUSTMENT', description: `مخزون: ${t.item.name} (${t.warehouse.name}) ${D(t.quantity).toNumber()}${t.reason ? ` — ${t.reason}` : ''}`, reference: t.reference,
        lines: into ? [L(inv, value, 0), L(other, 0, value)] : [L(other, value, 0), L(inv, 0, value)],
      };
    }
    case 'ins-payment': {
      const p = await db.insurancePayment.findUnique({ where: { id }, include: { company: { select: { nameAr: true } } } });
      if (!p || p.voidedAt) return { do: 'undo', why: 'دفعة شركة تأمين ملغاة' };
      const party = { partyType: 'INSURANCE', partyId: p.companyId, partyName: p.company.nameAr };
      return { do: 'post', date: ymd(p.paidAt), type: 'RECEIPT', description: `دفعة من ${p.company.nameAr} — ${p.receiptNumber}`, reference: p.reference ?? p.receiptNumber, lines: [L(m.method(p.methodId), p.amount, 0, { description: m.methodName(p.methodId) }), L(m.role('AR_INSURANCE'), 0, p.amount, party)] };
    }
    case 'voucher': case 'transfer': case 'cash-count': case 'visa-settlement': case 'cheque-event': case 'advance': case 'payroll': case 'payroll-pay':
    case 'asset': case 'depreciation': case 'asset-disposal': case 'year-close':
      return planDoc(db, kind, id, m);
    case 'claim-event': {
      const ev = await db.insuranceClaimEvent.findUnique({ where: { id }, include: { claim: { include: { invoice: { select: { invoiceNumber: true, patientId: true, patient: { select: { fullName: true } } } }, company: { select: { nameAr: true } } } } } });
      if (!ev || ev.voidedAt) return { do: 'undo', why: 'حركة مطالبة ملغاة' };
      const c = ev.claim;
      const ins = { partyType: 'INSURANCE', partyId: c.companyId, partyName: c.company.nameAr };
      if (ev.type === 'TRANSFER_TO_PATIENT' && D(ev.dTransferred).gt(0))
        return { do: 'post', date: ymd(ev.createdAt), type: 'ADJUSTMENT', description: `تحويل مرفوض المطالبة ${c.claimNumber} على المريض`, reference: c.invoice.invoiceNumber, lines: [L(m.role('AR_PATIENTS'), ev.dTransferred, 0, { partyType: 'PATIENT', partyId: c.invoice.patientId, partyName: c.invoice.patient.fullName }), L(m.role('AR_INSURANCE'), 0, ev.dTransferred, ins)] };
      if (ev.type === 'WRITE_OFF' && D(ev.dWrittenOff).gt(0))
        return { do: 'post', date: ymd(ev.createdAt), type: 'ADJUSTMENT', description: `شطب من المطالبة ${c.claimNumber}${ev.reason ? `: ${ev.reason}` : ''}`, reference: c.invoice.invoiceNumber, lines: [L(m.role('BAD_DEBTS'), ev.dWrittenOff, 0), L(m.role('AR_INSURANCE'), 0, ev.dWrittenOff, ins)] };
      return { do: 'skip', note: 'حركة مطالبة بلا أثر مالي' };
    }
  }
}

// ───────────── Turning the queue into entries ─────────────

export async function apply(tx: Tx, key: string, kind: Kind, sourceId: string, p: Plan, startDate: string): Promise<{ status: 'DONE' | 'SKIPPED'; note?: string; entryId?: string | null }> {
  const existing = await tx.journalEntry.findUnique({ where: { sourceKey: key } });
  const remove = async (why: string) => {
    if (!existing || existing.status === 'DELETED') return null;
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: existing.date }, endDate: { gte: existing.date } } });
    if (period?.status !== 'CLOSED') { await deleteEntry(tx, null, existing.id, { fromSource: true }); return existing.id; }
    // Its period is closed: the entry stays and is reversed today instead.
    const revKey = `${key}:reversal`;
    if (await tx.journalEntry.findUnique({ where: { sourceKey: revKey } })) return existing.id;
    const lines = await tx.journalLine.findMany({ where: { entryId: existing.id } });
    const r = await createEntry(tx, null, { date: ymd(new Date()), type: 'CORRECTION', description: `عكس ${existing.number}: ${why}`, reference: existing.reference, lines: lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) }, { post: true, sourceType: kind, sourceId, sourceKey: revKey });
    return r.id;
  };
  if (p.do === 'undo') return { status: 'DONE', note: p.why, entryId: await remove(p.why) };
  if (p.do === 'skip') { await remove(p.note); return { status: 'SKIPPED', note: p.note }; }
  if (p.date < startDate && !existing) return { status: 'SKIPPED', note: `قبل تاريخ بدء المحاسبة (${startDate}): ضمن الأرصدة الافتتاحية` };
  const input = { date: p.date, type: p.type, description: p.description, reference: p.reference ?? null, lines: p.lines };
  if (!existing) {
    await ensureOpenPeriod(tx, dayOf(p.date));
    const e = await createEntry(tx, null, input, { post: true, sourceType: kind, sourceId, sourceKey: key });
    return { status: 'DONE', entryId: e.id };
  }
  const e = await updateEntry(tx, null, existing.id, input, { fromSource: true });
  return { status: 'DONE', entryId: e.id };
}

let chain: Promise<unknown> = Promise.resolve();
/** Turn every queued operation into its entry. Safe to call at any time: runs never overlap, a call waits for the previous one. */
export function processPending(limit = 500): Promise<{ done: number; failed: number }> {
  const run = chain.then(() => runQueue(limit), () => runQueue(limit));
  chain = run.catch(() => undefined);
  return run;
}

async function runQueue(limit: number) {
  let done = 0, failed = 0;
  try {
    const cfg = await getSetting('accounting');
    if (!cfg.startDate) return { done, failed }; // not started: the queue waits
    const events = await prisma.accountingEvent.findMany({ where: { status: 'PENDING' }, orderBy: { queuedAt: 'asc' }, take: limit });
    const m = await loadMapping();
    for (const ev of events) {
      try {
        const r = await prisma.$transaction(async (tx) => {
          const cur = await tx.$queryRaw<{ status: string; queuedAt: Date }[]>`SELECT status, "queuedAt" FROM acc_events WHERE id = ${ev.id} FOR UPDATE`;
          if (cur[0]?.status !== 'PENDING') return null;
          const p = await plan(tx, ev.kind as Kind, ev.sourceId, m);
          const res = await apply(tx, ev.sourceKey, ev.kind as Kind, ev.sourceId, p, cfg.startDate!);
          // Re-queued while we worked? Leave it pending for the next round.
          const still = (await tx.accountingEvent.findUniqueOrThrow({ where: { id: ev.id } })).queuedAt.getTime() === cur[0].queuedAt.getTime();
          await tx.accountingEvent.update({ where: { id: ev.id }, data: { status: still ? res.status : 'PENDING', note: res.note ?? null, entryId: res.entryId ?? undefined, lastError: null, processedAt: new Date(), attempts: { increment: 1 } } });
          return res;
        });
        if (r) done++;
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message.split('\n').filter(Boolean).slice(-1)[0].slice(0, 500) : String(e);
        await prisma.accountingEvent.update({ where: { id: ev.id }, data: { status: 'FAILED', lastError: msg, attempts: { increment: 1 }, processedAt: new Date() } });
      }
    }
    if (failed) await notifyPermission('accounting.settings', { type: 'SYSTEM', title: 'تعذّر ترحيل عمليات إلى الدفاتر', body: `${failed} عملية لم تُرحَّل. راجع «متابعة الربط» في النظام المحاسبي`, link: '/accounting/integration', dedupeKey: `acc-fail:${new Date().toISOString().slice(0, 13)}` }).catch(() => undefined);
  } catch (e) {
    console.error('[accounting link]', e);
  }
  return { done, failed };
}

/** Retry failed operations (they are re-queued and processed again; their entries are never duplicated). */
export async function retryFailed(ids?: string[]) {
  await prisma.accountingEvent.updateMany({ where: { status: 'FAILED', ...(ids && { id: { in: ids } }) }, data: { status: 'PENDING', queuedAt: new Date() } });
  return processPending();
}

/** Queue every operation from the start date on (first start, or a full re-check). Existing entries are reused. */
export async function resyncFrom(startDate: string) {
  const from = new Date(`${startDate}T00:00:00`);
  const day = dayOf(startDate);
  const q = async (kind: Kind, ids: { id: string }[]) => { for (const { id } of ids) await enqueue(prisma, kind, id); return ids.length; };
  const n = [
    await q('invoice', await prisma.invoice.findMany({ where: { issuedAt: { gte: from }, status: { not: 'DRAFT' } }, select: { id: true } })),
    await q('invoice-cancel', await prisma.invoice.findMany({ where: { status: 'CANCELLED', cancelledAt: { gte: from }, issuedAt: { not: null } }, select: { id: true } })),
    await q('payment', await prisma.payment.findMany({ where: { paidAt: { gte: from } }, select: { id: true } })),
    await q('expense', await prisma.expense.findMany({ where: { expenseDate: { gte: day } }, select: { id: true } })),
    await q('supplier-payment', await prisma.supplierPayment.findMany({ where: { paidAt: { gte: from } }, select: { id: true } })),
    await q('po', await prisma.purchaseOrder.findMany({ where: { status: 'RECEIVED', receivedAt: { gte: from } }, select: { id: true } })),
    await q('inv-move', await prisma.inventoryTransaction.findMany({ where: { createdAt: { gte: from }, type: { in: ['CONSUMPTION', 'ISSUE', 'RETURN', 'RECEIPT', 'ADJUSTMENT', 'STOCK_COUNT'] } }, select: { id: true } })),
    await q('ins-payment', await prisma.insurancePayment.findMany({ where: { paidAt: { gte: from } }, select: { id: true } })),
    await q('claim-event', await prisma.insuranceClaimEvent.findMany({ where: { createdAt: { gte: from }, type: { in: ['TRANSFER_TO_PATIENT', 'WRITE_OFF'] } }, select: { id: true } })),
  ].reduce((a, b) => a + b, 0);
  // Card payments from the start date on enter the Visa box (followed until they reach the bank).
  const visa = await prisma.payment.findMany({ where: { paidAt: { gte: from }, method: { code: 'VISA' } }, select: { id: true } });
  for (const p of visa) await prisma.$transaction((tx) => trackVisa(tx, 'payment', p.id));
  return n;
}

/**
 * Accounting documents (vouchers, transfers, cheques, payroll, assets…) are posted inside their own transaction:
 * the document and its entry are saved together or not at all (e.g. a closed period refuses both).
 */
export async function postDoc(tx: Tx, kind: DocKind, id: string) {
  const m = await loadMapping(tx);
  const p = await plan(tx, kind, id, m);
  return apply(tx, `${kind}:${id}`, kind, id, p, '0000-00-00');
}
