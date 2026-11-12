import { randomUUID } from 'node:crypto';
import { Prisma, type EInvoice, type EInvoiceStatus } from '@prisma/client';
import QRCode from 'qrcode';
import type { Ctx } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { prisma } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { nextCounter } from '../../lib/counters';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { D, r3 } from '../../lib/money';
import { dateOnly, dateOnlyStr } from '../../lib/dates';
import { notifyPermission } from '../../lib/notify';
import { credentials, endpoint, loadStored, missing, type StoredConfig } from './config';
import { buildXml, isReceivable, totals, typeCode, validate, type Buyer, type DocInput, type DocLine, type TypeCode } from './ubl';
import { postInvoice, type SendResult } from './client';

/**
 * National e-invoicing (JoFotara). An issued invoice becomes one or more national documents, prepared inside the
 * issuing transaction (fixed ID + UUID + ICV) and sent right after it commits. A document whose outcome is unknown
 * is only ever resent with the same ID and UUID: the national system then answers ALREADY_SUBMITTED with the same
 * QR instead of creating a second invoice (ISTD guide v1.5, p. 99 and guidelines 3 & 8, p. 104).
 */

type Part = 'FULL' | 'PATIENT_SHARE' | 'COMPANY_SHARE';
type InvoiceForDocs = Prisma.InvoiceGetPayload<{ include: { items: true; patient: { select: { fullName: true } }; insuranceCompany: true } }>;

/** Line → document line for one part of the invoice. Invoice-level discount is spread over the lines (guide p. 39). */
function buildLines(inv: InvoiceForDocs, part: Part, zero: 'Z' | 'O'): { lines: DocLine[]; expected: Prisma.Decimal; errors: string[] } {
  const errors: string[] = [];
  const items = [...inv.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const rows = items.map((it, k) => {
    const qty = D(it.quantity);
    const taxed = D(it.taxRate).gt(0);
    const covered = D(it.insuranceShare).gt(0);
    let unitPrice: Prisma.Decimal, discount: Prisma.Decimal, base: Prisma.Decimal;
    if (part === 'FULL' || (part === 'PATIENT_SHARE' && !covered)) {
      unitPrice = D(it.unitPrice);
      discount = D(it.discount);
      base = r3(unitPrice.mul(qty)).sub(discount); // before tax
    } else {
      const amount = part === 'PATIENT_SHARE' ? D(it.patientShare) : D(it.insuranceShare);
      if (taxed && amount.gt(0)) errors.push(`البند "${it.description}" خاضع للضريبة ومقسوم بين المريض والتأمين، ولا يمكن تقسيمه آلياً`);
      unitPrice = amount.div(qty).toDecimalPlaces(9, Prisma.Decimal.ROUND_HALF_UP);
      discount = D(0);
      base = amount;
    }
    return { it, lineId: k + 1, qty, unitPrice, discount, base, taxed };
  });
  // The clinic's invoice discount only reduces what the patient pays.
  const invDisc = part === 'COMPANY_SHARE' ? D(0) : D(inv.invoiceDiscount);
  if (invDisc.gt(0)) {
    const weighted = rows.filter((r) => r.base.gt(0));
    if (weighted.some((r) => r.taxed)) errors.push('خصم على مستوى الفاتورة مع بنود خاضعة للضريبة: يجب جعل الخصم على البنود');
    const W = weighted.reduce((t, r) => t.add(r.base), D(0));
    let left = invDisc;
    weighted.forEach((r, i) => {
      const share = i === weighted.length - 1 ? left : Prisma.Decimal.min(r3(invDisc.mul(r.base).div(W)), left);
      r.discount = r.discount.add(share);
      left = left.sub(share);
    });
  }
  const lines: DocLine[] = rows
    .filter((r) => r.base.gt(0) || r.discount.gt(0))
    .map((r) => ({
      lineId: r.lineId, itemId: r.it.id, name: r.it.description, quantity: r.qty.toString(), unitPrice: r.unitPrice.toString(),
      discount: r3(r.discount).toString(), taxPercent: D(r.it.taxRate).toString(), taxCategory: r.taxed ? 'S' : zero,
    }));
  const expected = part === 'FULL' ? D(inv.total) : part === 'PATIENT_SHARE' ? D(inv.patientShare) : D(inv.insuranceShare);
  return { lines, expected, errors };
}

function docInput(cfg: StoredConfig, d: Pick<EInvoice, 'docNumber' | 'uuid' | 'icv' | 'issueDate' | 'typeName' | 'kind' | 'reason'>, buyer: Buyer, lines: DocLine[], original?: DocInput['original']): DocInput {
  return {
    docNumber: d.docNumber, uuid: d.uuid, icv: d.icv ?? 0, issueDate: dateOnlyStr(d.issueDate), typeName: d.typeName as TypeCode, kind: d.kind,
    seller: { taxNumber: cfg.taxNumber, name: cfg.sellerName.trim(), incomeSourceSeq: cfg.incomeSourceSeq }, buyer, lines, original, reason: d.reason,
  };
}

/** Builds the XML of a document from its stored lines and the current settings; returns the problems found, if any. */
async function render(db: Tx | typeof prisma, cfg: StoredConfig, doc: EInvoice): Promise<{ xml: string; errors: string[] }> {
  let original: DocInput['original'];
  if (doc.kind === 'RETURN') {
    const o = doc.originalId ? await db.eInvoice.findUnique({ where: { id: doc.originalId } }) : null;
    if (!o) return { xml: '', errors: ['الفاتورة الأصلية غير موجودة'] };
    original = { docNumber: o.docNumber, uuid: o.uuid, total: D(o.total).toFixed(3) };
  }
  const input = docInput(cfg, doc, doc.buyer as Buyer, doc.lines as unknown as DocLine[], original);
  const errors = [...missing(cfg).map((m) => `ناقص في الإعدادات: ${m}`), ...validate(input)];
  return { xml: errors.length ? '' : buildXml(input), errors };
}

const sealedNumber = (invoiceNumber: string, party: 'PATIENT' | 'COMPANY') => (party === 'PATIENT' ? invoiceNumber : `${invoiceNumber}-C`);

/**
 * Called inside issueInvoice. Nothing happens while the integration is off (so invoices issued before it was
 * enabled are never sent). Problems found locally never block issuing: the document is kept as FAILED with the
 * reason, for the admin to see on the e-invoicing dashboard.
 */
export async function prepareSaleDocs(tx: Tx, ctx: Ctx, invoiceId: string): Promise<string[]> {
  const cfg = await loadStored(tx);
  if (!cfg.enabled) return [];
  const inv = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { items: true, patient: { select: { fullName: true } }, insuranceCompany: true },
  });
  if (!inv.invoiceNumber || !inv.issuedAt) return [];
  const parts: { party: 'PATIENT' | 'COMPANY'; part: Part }[] = [];
  if (inv.payerType !== 'INSURANCE' || !inv.insuranceCompany) parts.push({ party: 'PATIENT', part: 'FULL' });
  else {
    const mode = inv.insuranceCompany.einvoiceMode;
    if (mode === 'NONE') return []; // this company's invoices are not sent at all
    parts.push({ party: 'PATIENT', part: mode === 'FULL_TO_PATIENT' ? 'FULL' : 'PATIENT_SHARE' });
    if (mode === 'PATIENT_AND_COMPANY') parts.push({ party: 'COMPANY', part: 'COMPANY_SHARE' });
  }
  const ids: string[] = [];
  for (const { party, part } of parts) {
    const { lines, expected, errors } = buildLines(inv, part, cfg.zeroCategory);
    if (expected.lte(0) && !errors.length) continue; // nothing billed to this party (e.g. fully covered)
    const t = totals(lines);
    if (!errors.length && t.payable.sub(expected).abs().gt(0.001)) errors.push(`مجموع الفاتورة الوطنية (${t.payable.toFixed(3)}) لا يطابق مبلغ الفاتورة (${expected.toFixed(3)})`);
    const buyer: Buyer = party === 'COMPANY'
      ? { name: inv.insuranceCompany!.nameAr, taxNumber: inv.insuranceCompany!.taxNumber?.trim() || null }
      // Patients stay anonymous: the guide requires the buyer name on a cash invoice only above 10,000 JD (p. 36).
      : { name: t.payable.gt(10_000) ? inv.patient.fullName : null };
    const doc = await tx.eInvoice.create({
      data: {
        invoiceId: inv.id, kind: 'SALE', party, docNumber: sealedNumber(inv.invoiceNumber, party), uuid: randomUUID(),
        typeName: typeCode(cfg.scheme, party === 'COMPANY'), issueDate: dateOnly(inv.issuedAt),
        total: t.payable, taxTotal: t.tax, lines: lines as unknown as Prisma.InputJsonValue, buyer: buyer as Prisma.InputJsonValue,
        xml: '', status: 'PENDING', createdById: ctx.userId,
      },
    });
    // Checked now so a problem shows at once; the XML itself is built when it is sent (with its ICV).
    const r = errors.length ? { errors } : await render(tx, cfg, doc);
    if (r.errors.length) await tx.eInvoice.update({ where: { id: doc.id }, data: { status: 'FAILED', lastError: r.errors.join(' — ') } });
    ids.push(doc.id);
  }
  return ids;
}

// ── Sending ──

const BACKOFF_MIN = [1, 5, 15, 60, 180];
const stillOpen: EInvoiceStatus[] = ['PENDING', 'FAILED', 'REJECTED', 'UNKNOWN'];

async function record(doc: EInvoice, r: SendResult, xml: string, userId: string | null) {
  const attempts = doc.attempts + 1;
  const status: EInvoiceStatus = r.outcome;
  const updated = await prisma.$transaction(async (tx) => {
    await tx.eInvoiceAttempt.create({
      data: {
        eInvoiceId: doc.id, httpStatus: r.httpStatus, einvStatus: r.einvStatus, outcome: r.outcome, message: r.message,
        errors: (r.errors ?? undefined) as Prisma.InputJsonValue | undefined, durationMs: r.durationMs, userId,
      },
    });
    return tx.eInvoice.update({
      where: { id: doc.id },
      data: {
        status, attempts, lastAttemptAt: new Date(), xml: xml || doc.xml, lastError: r.message,
        nextAttemptAt: status === 'UNKNOWN' ? new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000) : null,
        ...(status === 'SUBMITTED' && {
          qr: r.qr, signedInvoice: r.signedInvoice, einvNum: r.einvNum, einvUuid: r.einvUuid, submittedAt: doc.submittedAt ?? new Date(), lastError: null,
        }),
      },
    });
  });
  if (status === 'REJECTED' || status === 'FAILED' || (status === 'UNKNOWN' && attempts >= 3)) {
    await notifyPermission('einvoice.view', {
      type: 'SYSTEM', title: `الفوترة الوطنية: لم تُعتمد ${doc.kind === 'RETURN' ? 'فاتورة الإرجاع' : 'الفاتورة'} ${doc.docNumber}`,
      body: r.message ?? undefined, link: `/einvoice?doc=${doc.id}`, dedupeKey: `einv:${doc.id}:${status}`,
    }).catch(() => undefined);
  }
  return updated;
}

/**
 * Sends one document. Automatic sends take PENDING and UNKNOWN (when due); a user may also resend FAILED and
 * REJECTED ones. Never-accepted documents are rebuilt from the current settings; a document whose outcome is
 * unknown is resent byte-for-byte. Either way the ID and UUID never change.
 */
export async function sendDocument(id: string, opts: { userId?: string | null; manual?: boolean } = {}) {
  const doc = await prisma.eInvoice.findUnique({ where: { id } });
  if (!doc) throw notFound('المستند غير موجود');
  const allowed: EInvoiceStatus[] = opts.manual ? stillOpen : ['PENDING', 'UNKNOWN'];
  if (!allowed.includes(doc.status)) return doc;
  // Claim it: a concurrent sender (another request or the background job) skips it.
  const claimed = await prisma.eInvoice.updateMany({ where: { id, status: doc.status, updatedAt: doc.updatedAt }, data: { status: 'SENDING' } });
  if (!claimed.count) return prisma.eInvoice.findUniqueOrThrow({ where: { id } });
  const local = (message: string) => record(doc, { outcome: 'FAILED', httpStatus: null, einvStatus: null, qr: null, signedInvoice: null, einvNum: null, einvUuid: null, message, errors: null, durationMs: 0 }, '', opts.userId ?? null);
  try {
    const cfg = await loadStored();
    if (!cfg.enabled) return await local('الربط مع نظام الفوترة الوطني متوقف من الإعدادات');
    const url = endpoint();
    if (!url) return await local('لا يوجد عنوان ربط مسموح في هذه البيئة (الإرسال للنظام الحقيقي يتم من الخادم الفعلي فقط)');
    const creds = credentials(cfg);
    if (!creds) return await local('بيانات الربط (Client ID / Secret Key) غير محفوظة أو تحتاج إعادة إدخال');
    let xml = doc.xml;
    if (doc.status !== 'UNKNOWN' || !xml) {
      // Never accepted: it follows the current registration setting (income 011/021 or sales 012/022).
      // A return keeps the type of the sale it returns (guide p. 47).
      if (doc.kind === 'SALE') {
        const want = typeCode(cfg.scheme, isReceivable(doc.typeName));
        if (want !== doc.typeName) {
          doc.typeName = want;
          await prisma.eInvoice.update({ where: { id }, data: { typeName: want } });
        }
      }
      const r = await render(prisma, cfg, doc);
      if (r.errors.length) return await local(r.errors.join(' — '));
      // First real send: take the next invoice counter (kept for every later resend of this document).
      if (doc.icv == null) {
        doc.icv = await nextCounter(prisma, 'einvoice-icv');
        await prisma.eInvoice.update({ where: { id }, data: { icv: doc.icv, status: 'SENDING' } });
      }
      xml = (await render(prisma, cfg, doc)).xml;
    }
    const result = await postInvoice(url, creds, xml, cfg.timeoutSec * 1000);
    return await record(doc, result, xml, opts.userId ?? null);
  } catch (e) {
    // Unexpected local error after claiming: leave it retryable without assuming anything was accepted.
    await prisma.eInvoice.update({ where: { id }, data: { status: doc.status === 'PENDING' ? 'PENDING' : 'UNKNOWN', nextAttemptAt: new Date(Date.now() + 60_000) } });
    throw e;
  }
}

/** Sends the new documents of an invoice right after its transaction commits, waiting at most `waitMs`. */
export async function flushDocs(ids: string[], waitMs = 15_000) {
  if (!ids.length) return;
  const work = (async () => {
    for (const id of ids) await sendDocument(id).catch((e) => console.error('[einvoice] send failed', (e as Error)?.message));
  })();
  await Promise.race([work, new Promise((r) => setTimeout(r, waitMs))]);
}

export async function flushInvoice(invoiceId: string, waitMs = 15_000) {
  const docs = await prisma.eInvoice.findMany({ where: { invoiceId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  await flushDocs(docs.map((d) => d.id), waitMs);
}

let running = false;
/** Background: sends pending documents and retries unknown ones when due. Safe to call often. */
export async function processQueue(limit = 25) {
  if (running) return;
  running = true;
  try {
    // A send interrupted by a restart: outcome unknown → retry with the same ID+UUID.
    await prisma.eInvoice.updateMany({ where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { status: 'UNKNOWN', nextAttemptAt: new Date() } });
    const cfg = await loadStored();
    if (!cfg.enabled) return;
    const due = await prisma.eInvoice.findMany({
      where: { OR: [{ status: 'PENDING' }, { status: 'UNKNOWN', nextAttemptAt: { lte: new Date() } }] },
      orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
    });
    for (const d of due) await sendDocument(d.id).catch((e) => console.error('[einvoice] send failed', (e as Error)?.message));
  } finally {
    running = false;
  }
}

export const kick = () => void processQueue().catch((e) => console.error('[einvoice]', (e as Error)?.message));

// ── Returns (credit notes, 381) ──

async function returnedQty(tx: Tx, saleId: string) {
  const rets = await tx.eInvoice.findMany({ where: { originalId: saleId, kind: 'RETURN', status: { not: 'VOID' } }, select: { lines: true } });
  const qty = new Map<number, Prisma.Decimal>();
  const disc = new Map<number, Prisma.Decimal>();
  for (const r of rets) {
    for (const l of r.lines as unknown as DocLine[]) {
      qty.set(l.lineId, (qty.get(l.lineId) ?? D(0)).add(l.quantity));
      disc.set(l.lineId, (disc.get(l.lineId) ?? D(0)).add(l.discount));
    }
  }
  return { qty, disc };
}

/** Quantities still returnable per line of a submitted sale document. */
export async function remainingLines(tx: Tx, sale: EInvoice) {
  const { qty } = await returnedQty(tx, sale.id);
  return (sale.lines as unknown as DocLine[]).map((l) => ({ ...l, returned: (qty.get(l.lineId) ?? D(0)).toString(), remaining: D(l.quantity).sub(qty.get(l.lineId) ?? D(0)).toString() }));
}

/**
 * A return document for quantities of a submitted sale document. The guide allows returns on quantities only,
 * never above what was sold, possibly in several returns until all is returned (p. 46). Prices are the sale's;
 * the line discount is returned in proportion (the last return of a line takes what is left of it).
 */
export async function createReturn(tx: Tx, ctx: Ctx, saleId: string, req: { lineId: number; quantity: number }[], reason: string): Promise<string> {
  const sale = await tx.eInvoice.findUnique({ where: { id: saleId } });
  if (!sale || sale.kind !== 'SALE') throw notFound('الفاتورة الوطنية غير موجودة');
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${sale.invoiceId} FOR UPDATE`;
  if (sale.status !== 'SUBMITTED') throw badRequest('لا يمكن الإرجاع إلا من فاتورة معتمدة في نظام الفوترة');
  if (!reason.trim()) throw badRequest('سبب الإرجاع مطلوب');
  const { qty, disc } = await returnedQty(tx, sale.id);
  const byId = new Map((sale.lines as unknown as DocLine[]).map((l) => [l.lineId, l]));
  const lines: DocLine[] = [];
  for (const r of req) {
    const l = byId.get(r.lineId);
    if (!l) throw badRequest('بند غير موجود في الفاتورة الأصلية');
    const q = D(r.quantity);
    if (q.lte(0)) continue;
    const done = qty.get(l.lineId) ?? D(0);
    const left = D(l.quantity).sub(done);
    if (q.gt(left)) throw badRequest(`الكمية المرتجعة من "${l.name}" أكبر من المتبقي (${left.toString()})`);
    const discount = q.eq(left) ? D(l.discount).sub(disc.get(l.lineId) ?? D(0)) : r3(D(l.discount).mul(q).div(l.quantity));
    lines.push({ ...l, quantity: q.toString(), discount: Prisma.Decimal.max(discount, 0).toString() });
  }
  if (!lines.length) throw badRequest('اختر كمية واحدة على الأقل للإرجاع');
  const t = totals(lines);
  const n = await tx.eInvoice.count({ where: { originalId: sale.id, kind: 'RETURN' } });
  const cfg = await loadStored(tx);
  const doc = await tx.eInvoice.create({
    data: {
      invoiceId: sale.invoiceId, kind: 'RETURN', party: sale.party, docNumber: `${sale.docNumber}-R${n + 1}`, uuid: randomUUID(),
      typeName: sale.typeName, issueDate: dateOnly(),
      originalId: sale.id, reason: reason.trim().slice(0, 300), total: t.payable, taxTotal: t.tax,
      lines: lines as unknown as Prisma.InputJsonValue, buyer: sale.buyer as Prisma.InputJsonValue, xml: '', status: 'PENDING', createdById: ctx.userId,
    },
  });
  const r = await render(tx, cfg, doc);
  if (r.errors.length) await tx.eInvoice.update({ where: { id: doc.id }, data: { status: 'FAILED', lastError: r.errors.join(' — ') } });
  await audit(tx, ctx, {
    action: 'einvoice.return', entityType: 'invoice', entityId: sale.invoiceId,
    summary: `فاتورة إرجاع ${doc.docNumber} في نظام الفوترة من ${sale.docNumber} بقيمة ${t.payable.toFixed(3)} — السبب: ${doc.reason}`,
    after: { docNumber: doc.docNumber, original: sale.docNumber, total: t.payable.toNumber(), lines: lines.map((l) => ({ line: l.lineId, name: l.name, qty: l.quantity })) },
  });
  return doc.id;
}

/**
 * Cancelling an invoice: documents never accepted are voided; accepted ones get a return for everything not yet
 * returned. Refused while an outcome is still unknown (it might have been accepted).
 */
export async function onInvoiceCancel(tx: Tx, ctx: Ctx, invoiceId: string, reason: string): Promise<string[]> {
  const docs = await tx.eInvoice.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } });
  if (docs.some((d) => d.status === 'SENDING' || d.status === 'UNKNOWN')) {
    throw conflict('لا يمكن الإلغاء الآن: نتيجة إرسال الفاتورة لنظام الفوترة الوطني غير معروفة بعد. أعد الإرسال من بطاقة «الفوترة الوطنية» ثم ألغِ الفاتورة');
  }
  const ids: string[] = [];
  for (const d of docs) {
    if (d.kind === 'SALE' && ['PENDING', 'FAILED', 'REJECTED'].includes(d.status)) {
      await tx.eInvoice.update({ where: { id: d.id }, data: { status: 'VOID', nextAttemptAt: null, lastError: 'أُلغيت الفاتورة قبل اعتمادها في نظام الفوترة' } });
    }
    if (d.kind === 'SALE' && d.status === 'SUBMITTED') {
      const left = (await remainingLines(tx, d)).filter((l) => D(l.remaining).gt(0));
      if (left.length) ids.push(await createReturn(tx, ctx, d.id, left.map((l) => ({ lineId: l.lineId, quantity: D(l.remaining).toNumber() })), `إلغاء الفاتورة: ${reason}`));
    }
  }
  return ids;
}

/** Invoice date changes: refused once a national document exists that is (or may be) accepted. */
export async function onInvoiceDateChange(tx: Tx, invoiceId: string, day: string) {
  const docs = await tx.eInvoice.findMany({ where: { invoiceId, kind: 'SALE', status: { not: 'VOID' } } });
  const sent = docs.find((d) => ['SUBMITTED', 'UNKNOWN', 'SENDING'].includes(d.status));
  if (sent) {
    throw badRequest(`لا يمكن تعديل التاريخ: الفاتورة ${sent.status === 'SUBMITTED' ? 'معتمدة' : 'مرسلة'} في نظام الفوترة الوطني بتاريخ ${dateOnlyStr(sent.issueDate)}. لتصحيحها: ألغِ الفاتورة (تصدر فاتورة إرجاع تلقائياً) ثم أصدر فاتورة جديدة بالتاريخ الصحيح`);
  }
  if (docs.length) await tx.eInvoice.updateMany({ where: { id: { in: docs.map((d) => d.id) } }, data: { issueDate: dateOnly(day) } });
}

// ── Read models ──

const qrSvg = (qr: string | null) => (qr ? QRCode.toString(qr, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }) : Promise.resolve(null));

/** Documents of one invoice for its page and print (no XML). */
export async function invoiceDocs(invoiceId: string) {
  const docs = await prisma.eInvoice.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } });
  return Promise.all(docs.map(async (d) => ({
    id: d.id, kind: d.kind, party: d.party, docNumber: d.docNumber, uuid: d.uuid, icv: d.icv, typeName: d.typeName, issueDate: dateOnlyStr(d.issueDate),
    total: D(d.total).toNumber(), status: d.status, attempts: d.attempts, lastAttemptAt: d.lastAttemptAt, submittedAt: d.submittedAt,
    lastError: d.lastError, reason: d.reason, originalId: d.originalId, qrSvg: await qrSvg(d.qr),
    lines: d.kind === 'SALE' && d.status === 'SUBMITTED' ? await remainingLines(prisma as unknown as Tx, d) : (d.lines as unknown as DocLine[]),
  })));
}

export const DOC_STATUSES: EInvoiceStatus[] = ['PENDING', 'SENDING', 'SUBMITTED', 'REJECTED', 'FAILED', 'UNKNOWN', 'VOID'];
