import { Prisma } from '@prisma/client';

/**
 * UBL 2.1 invoice XML for the Jordanian national invoicing system (JoFotara), exactly as laid out in the ISTD
 * technical guide v1.5, in its two forms:
 *  - income invoice (فاتورة الدخل, taxpayers not registered in sales tax): codes 011/021, no tax elements (pp. 11-31);
 *  - general sales invoice (فاتورة المبيعات العامة): codes 012/022, with tax per line (pp. 32-56).
 * Pure functions: no database, no network.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const R3 = (v: Prisma.Decimal) => v.toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);

/** Tax percentages the guide lists as accepted for general sales tax (p. 42). */
export const ALLOWED_PERCENTS = [0, 1, 2, 3, 4, 5, 7, 8, 10, 16];

export interface DocLine {
  /** Unique within the document; kept from the sale on its returns (guide p. 104). */
  lineId: number;
  /** InvoiceItem this line comes from. */
  itemId: string;
  name: string;
  quantity: string;
  /** Unit price before tax, up to 9 decimals. */
  unitPrice: string;
  /** Discount on the whole line (positive). */
  discount: string;
  taxPercent: string;
  /** Z exempt, O zero-rated, S taxed (guide p. 42). */
  taxCategory: 'Z' | 'O' | 'S';
}

/** Buyer. Anonymous (all empty) is the guide's fixed buyer block; name is required for receivable invoices. */
export interface Buyer { name?: string | null; taxNumber?: string | null }

export type Scheme = 'INCOME' | 'SALES';
export type TypeCode = '011' | '021' | '012' | '022';
/** Invoice type code for the taxpayer's registration (guide pp. 12, 33): cash for patients, receivable for companies. */
export const typeCode = (scheme: Scheme, receivable: boolean): TypeCode =>
  scheme === 'INCOME' ? (receivable ? '021' : '011') : receivable ? '022' : '012';
export const isIncome = (t: string) => t.endsWith('1');
export const isReceivable = (t: string) => t[1] === '2';

export interface DocInput {
  docNumber: string;
  uuid: string;
  icv: number;
  issueDate: string; // yyyy-mm-dd
  /** Income: 011 cash / 021 receivable. General sales: 012 cash / 022 receivable (all local). */
  typeName: TypeCode;
  kind: 'SALE' | 'RETURN';
  seller: { taxNumber: string; name: string; incomeSourceSeq: string };
  buyer: Buyer;
  lines: DocLine[];
  /** Return documents only. */
  original?: { docNumber: string; uuid: string; total: string };
  reason?: string | null;
}

export interface LineAmounts { gross: Prisma.Decimal; ext: Prisma.Decimal; tax: Prisma.Decimal; rounding: Prisma.Decimal }

/** Line amounts by the guide's formulas (pp. 39-42), rounded to 3 decimals (tolerance 0.001 is allowed). */
export function lineAmounts(l: DocLine): LineAmounts {
  const gross = D(l.quantity).mul(l.unitPrice);
  const extExact = gross.sub(l.discount);
  const ext = R3(extExact);
  const tax = R3(extExact.mul(l.taxPercent).div(100));
  return { gross, ext, tax, rounding: ext.add(tax) };
}

export function totals(lines: DocLine[]) {
  let gross = D(0), discount = D(0), tax = D(0), inclusive = D(0);
  for (const l of lines) {
    const a = lineAmounts(l);
    gross = gross.add(a.gross);
    discount = discount.add(l.discount);
    tax = tax.add(a.tax);
    inclusive = inclusive.add(a.rounding);
  }
  return { taxExclusive: R3(gross), discount: R3(discount), tax: R3(tax), inclusive: R3(inclusive), payable: R3(inclusive) };
}

/** Local checks before sending, mirroring the rules and common 400 errors in the guide (pp. 36-42, 101-102). */
export function validate(doc: DocInput): string[] {
  const e: string[] = [];
  if (!doc.lines.length) e.push('لا توجد بنود في الفاتورة');
  const ids = new Set<number>();
  for (const l of doc.lines) {
    if (ids.has(l.lineId)) e.push(`رقم البند ${l.lineId} مكرر`);
    ids.add(l.lineId);
    if (!(D(l.quantity).gt(0))) e.push(`كمية البند "${l.name}" يجب أن تكون أكبر من صفر`);
    if (D(l.unitPrice).lt(0)) e.push(`سعر البند "${l.name}" سالب`);
    if (D(l.discount).lt(0)) e.push(`خصم البند "${l.name}" سالب`);
    if (D(l.discount).gt(D(l.quantity).mul(l.unitPrice))) e.push(`خصم البند "${l.name}" أكبر من قيمته`);
    const pct = D(l.taxPercent).toNumber();
    if (isIncome(doc.typeName)) { if (!l.name.trim()) e.push('وصف البند فارغ'); continue; }
    if (!ALLOWED_PERCENTS.includes(pct)) e.push(`نسبة الضريبة ${pct}% على "${l.name}" غير معتمدة في نظام الفوترة`);
    if (pct === 0 && l.taxCategory === 'S') e.push('النسبة 0% لا تكون بفئة S');
    if (pct > 0 && l.taxCategory !== 'S') e.push('النسبة الموجبة تكون بفئة S');
    if (!l.name.trim()) e.push('وصف البند فارغ');
  }
  if (isIncome(doc.typeName) && doc.lines.some((l) => D(l.taxPercent).gt(0))) e.push('فاتورة الدخل لا تحمل ضريبة: يوجد بند بنسبة ضريبة أكبر من صفر');
  if (isReceivable(doc.typeName) && !doc.buyer.name?.trim()) e.push('اسم المشتري إجباري في فاتورة الذمم');
  if (!isReceivable(doc.typeName) && totals(doc.lines).payable.gt(10_000) && !doc.buyer.name?.trim()) e.push('اسم المشتري إجباري في الفاتورة النقدية التي تزيد على 10,000 دينار');
  if (doc.buyer.taxNumber && !/^\d{1,20}$/.test(doc.buyer.taxNumber)) e.push('الرقم الضريبي للمشتري يجب أن يكون أرقاماً فقط');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.issueDate)) e.push('تاريخ الفاتورة غير صالح');
  if (doc.kind === 'RETURN' && (!doc.original || !doc.reason?.trim())) e.push('فاتورة الإرجاع تحتاج الفاتورة الأصلية وسبب الإرجاع');
  return e;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const money = (v: Prisma.Decimal) => R3(v).toFixed(3);
/** Up to 9 decimals, at least 3 (guide: "3 to 9 decimals"). */
const price = (v: Prisma.Decimal.Value) => {
  const s = D(v).toDecimalPlaces(9, Prisma.Decimal.ROUND_HALF_UP).toFixed(9).replace(/0+$/, '');
  const [i, f = ''] = s.split('.');
  return `${i}.${f.padEnd(3, '0')}`;
};
const qty = (v: Prisma.Decimal.Value) => price(v);
const amt = (tag: string, v: Prisma.Decimal) => `<cbc:${tag} currencyID="JO">${money(v)}</cbc:${tag}>`;

/**
 * The root tag is written on one line (the guide's "Invalid Invoice Minification" error) and the whole document
 * is emitted without line breaks.
 */
export function buildXml(doc: DocInput): string {
  const t = totals(doc.lines);
  const x: string[] = [];
  x.push('<?xml version="1.0" encoding="UTF-8"?>');
  x.push('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">');
  x.push('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
  x.push(`<cbc:ID>${esc(doc.docNumber)}</cbc:ID>`);
  x.push(`<cbc:UUID>${esc(doc.uuid)}</cbc:UUID>`);
  x.push(`<cbc:IssueDate>${doc.issueDate}</cbc:IssueDate>`);
  x.push(`<cbc:InvoiceTypeCode name="${doc.typeName}">${doc.kind === 'RETURN' ? '381' : '388'}</cbc:InvoiceTypeCode>`);
  x.push('<cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>');
  x.push('<cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>');
  if (doc.kind === 'RETURN' && doc.original) {
    x.push('<cac:BillingReference><cac:InvoiceDocumentReference>');
    x.push(`<cbc:ID>${esc(doc.original.docNumber)}</cbc:ID><cbc:UUID>${esc(doc.original.uuid)}</cbc:UUID>`);
    x.push(`<cbc:DocumentDescription>${money(D(doc.original.total))}</cbc:DocumentDescription>`);
    x.push('</cac:InvoiceDocumentReference></cac:BillingReference>');
  }
  x.push(`<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${doc.icv}</cbc:UUID></cac:AdditionalDocumentReference>`);
  // Seller (p. 35)
  x.push('<cac:AccountingSupplierParty><cac:Party><cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>');
  x.push(`<cac:PartyTaxScheme><cbc:CompanyID>${esc(doc.seller.taxNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`);
  x.push(`<cac:PartyLegalEntity><cbc:RegistrationName>${esc(doc.seller.name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>`);
  // Buyer (pp. 36-37; anonymous form as in the guide's fixed example p. 49)
  x.push('<cac:AccountingCustomerParty><cac:Party>');
  if (doc.buyer.taxNumber) x.push(`<cac:PartyIdentification><cbc:ID schemeID="TN">${esc(doc.buyer.taxNumber)}</cbc:ID></cac:PartyIdentification>`);
  x.push('<cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>');
  x.push('<cac:PartyTaxScheme><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>');
  x.push(`<cac:PartyLegalEntity>${doc.buyer.name ? `<cbc:RegistrationName>${esc(doc.buyer.name)}</cbc:RegistrationName>` : ''}</cac:PartyLegalEntity>`);
  x.push('</cac:Party></cac:AccountingCustomerParty>');
  // Income source sequence (p. 38)
  x.push(`<cac:SellerSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>${esc(doc.seller.incomeSourceSeq)}</cbc:ID></cac:PartyIdentification></cac:Party></cac:SellerSupplierParty>`);
  // Return reason (p. 50)
  if (doc.kind === 'RETURN') {
    x.push(`<cac:PaymentMeans><cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode><cbc:InstructionNote>${esc(doc.reason ?? '')}</cbc:InstructionNote></cac:PaymentMeans>`);
  }
  // Totals (pp. 39-40): the discount is the sum of line discounts (no invoice-level discount is accepted).
  x.push(`<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>${amt('Amount', t.discount)}</cac:AllowanceCharge>`);
  const income = isIncome(doc.typeName);
  // Income invoices carry no tax elements at all (guide p. 18); sales invoices do (p. 39).
  if (!income) x.push(`<cac:TaxTotal>${amt('TaxAmount', t.tax)}</cac:TaxTotal>`);
  x.push(`<cac:LegalMonetaryTotal>${amt('TaxExclusiveAmount', t.taxExclusive)}${amt('TaxInclusiveAmount', t.inclusive)}${amt('AllowanceTotalAmount', t.discount)}${amt('PayableAmount', t.payable)}</cac:LegalMonetaryTotal>`);
  // Lines (pp. 41-44)
  for (const l of doc.lines) {
    const a = lineAmounts(l);
    x.push('<cac:InvoiceLine>');
    x.push(`<cbc:ID>${l.lineId}</cbc:ID>`);
    x.push(`<cbc:InvoicedQuantity unitCode="PCE">${qty(l.quantity)}</cbc:InvoicedQuantity>`);
    x.push(amt('LineExtensionAmount', a.ext));
    if (!income) {
      x.push(`<cac:TaxTotal>${amt('TaxAmount', a.tax)}${amt('RoundingAmount', a.rounding)}`);
      x.push(`<cac:TaxSubtotal>${amt('TaxAmount', a.tax)}<cac:TaxCategory><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${l.taxCategory}</cbc:ID>`);
      x.push(`<cbc:Percent>${D(l.taxPercent).toFixed(2)}</cbc:Percent><cac:TaxScheme><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>`);
    }
    x.push(`<cac:Item><cbc:Name>${esc(l.name)}</cbc:Name></cac:Item>`);
    x.push(`<cac:Price><cbc:PriceAmount currencyID="JO">${price(l.unitPrice)}</cbc:PriceAmount>`);
    x.push(`<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>${amt('Amount', D(l.discount))}</cac:AllowanceCharge></cac:Price>`);
    x.push('</cac:InvoiceLine>');
  }
  x.push('</Invoice>');
  return x.join('');
}
