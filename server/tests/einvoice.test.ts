import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { processQueue } from '../src/modules/einvoice/service';
import { buildXml, totals, validate, type DocInput } from '../src/modules/einvoice/ubl';
import { classify } from '../src/modules/einvoice/client';
import { login, type Client } from './helpers';

/**
 * JoFotara integration against a local mock of the national system that answers like the ISTD guide v1.5
 * (section 8): SUBMITTED + QR, ALREADY_SUBMITTED for the same ID+UUID, NOT_SUBMITTED/400 with errors, 403, 504.
 * No test ever reaches the real system (the official URL is refused outside production).
 */

type Mode = 'ok' | 'lost' | 'reject' | 'forbidden';
let mode: Mode = 'ok';
const received: { clientId: string; secret: string; xml: string; id: string; uuid: string }[] = [];
const accepted = new Map<string, string>(); // `${ID}|${UUID}` → QR
const CLIENT_ID = 'test-client-0001', SECRET = 'test-secret-XYZ-987654';

const tag = (xml: string, t: string) => xml.match(new RegExp(`<cbc:${t}[^>]*>([^<]*)</cbc:${t}>`))?.[1] ?? '';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const xml = Buffer.from(JSON.parse(body).invoice, 'base64').toString('utf8');
    const id = tag(xml, 'ID'), uuid = tag(xml, 'UUID');
    received.push({ clientId: String(req.headers['client-id']), secret: String(req.headers['secret-key']), xml, id, uuid });
    const send = (code: number, json: object) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.headers['client-id'] !== CLIENT_ID || req.headers['secret-key'] !== SECRET || mode === 'forbidden') return send(403, {});
    const key = `${id}|${uuid}`;
    const ok = (status: string) => send(200, {
      EINV_RESULTS: { status: 'PASS', INFO: [], WARNINGS: [], ERRORS: [] }, EINV_STATUS: status, EINV_SINGED_INVOICE: 'c2lnbmVk',
      EINV_QR: accepted.get(key), EINV_NUM: id, EINV_INV_UUID: uuid,
    });
    if (accepted.has(key)) return ok('ALREADY_SUBMITTED');
    if (mode === 'reject') {
      return send(400, { EINV_RESULTS: { status: 'ERROR', INFO: [], WARNINGS: [], ERRORS: [{ type: 'ERROR', status: 'ERROR', EINV_CODE: 'totalGeneralTaxesAmount', EINV_CATEGORY: 'invoice', EINV_MESSAGE: 'Total General Amount is Not Correct' }] }, EINV_STATUS: 'NOT_SUBMITTED', EINV_QR: null });
    }
    accepted.set(key, Buffer.from(`QR:${id}:${uuid}`).toString('base64'));
    if (mode === 'lost') return send(504, {}); // accepted, but the answer never makes it back
    return ok('SUBMITTED');
  });
});

let admin: Client, reception: Client;
let patientId: string, templateId: string, ecgId: string, glucoId: string;

beforeAll(async () => {
  await new Promise<void>((r) => mock.listen(47999, '127.0.0.1', r));
  [admin, reception] = await Promise.all([login('admin'), login('reception')]);
  patientId = (await reception.post('/api/patients', { fullName: 'مريض الفوترة الوطنية', phone: '0791118899', gender: 'MALE' })).body.id;
  templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false, items: { none: {} } } })).id;
  ecgId = (await prisma.service.findFirstOrThrow({ where: { code: 'SRV-ECG' } })).id; // 20 JD, PROCEDURE
  glucoId = (await prisma.service.findFirstOrThrow({ where: { code: 'SRV-GLUCO' } })).id; // 2 JD
});

afterAll(async () => {
  await admin.put('/api/einvoice/config', { enabled: false });
  await new Promise((r) => mock.close(r));
});

const invoice = (extra: object = {}) =>
  admin.post('/api/billing/invoices', { patientId, templateId, items: [{ serviceId: ecgId, quantity: 2 }, { serviceId: glucoId, quantity: 1 }], issue: true, ...extra });
const docsOf = async (invoiceId: string) => (await admin.get(`/api/einvoice/invoices/${invoiceId}`)).body as {
  id: string; kind: string; party: string; docNumber: string; uuid: string; status: string; total: number; qrSvg: string | null; lastError: string | null; typeName: string;
  lines: { lineId: number; quantity: string; remaining?: string; name: string }[];
}[];
const lastXml = () => received[received.length - 1].xml;

describe('national e-invoicing settings', () => {
  it('only einvoice.settings manages it; credentials are write-only and stored encrypted', async () => {
    expect((await reception.get('/api/einvoice/config')).status).toBe(403);
    expect((await reception.put('/api/einvoice/config', { enabled: true })).status).toBe(403);
    // Cannot be switched on before it is complete
    const early = await admin.put('/api/einvoice/config', { enabled: true });
    expect(early.status).toBe(400);
    expect(early.body.error?.message ?? JSON.stringify(early.body)).toContain('Client ID');

    const r = await admin.put('/api/einvoice/config', {
      taxNumber: '12345678', sellerName: 'عيادة إيمرجنسي بلس', incomeSourceSeq: '9932895', clientId: CLIENT_ID, secretKey: SECRET,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ hasClientId: true, hasSecretKey: true, clientIdHint: '0001', missing: [], enabled: false, official: false });
    const all = JSON.stringify((await admin.get('/api/einvoice/config')).body) + JSON.stringify(r.body);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(CLIENT_ID);
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'jofotara' } });
    expect(JSON.stringify(row.value)).not.toContain(SECRET);
    // Not part of the general settings either
    expect(JSON.stringify((await admin.get('/api/settings')).body)).not.toContain('jofotara');
    const logs = await prisma.auditLog.findMany({ where: { action: 'einvoice.settings' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it('invoices issued while the integration is off are never sent', async () => {
    const inv = await invoice();
    expect(inv.status).toBe(201);
    expect(await docsOf(inv.body.id)).toEqual([]);
    expect((await admin.put('/api/einvoice/config', { enabled: true })).status).toBe(200);
    await processQueue();
    expect(await docsOf(inv.body.id)).toEqual([]);
    expect(received).toHaveLength(0);
  });
});

describe('sending', () => {
  let saleId: string, invoiceId: string;

  it('sends an issued cash invoice as UBL 2.1 and stores the official QR', async () => {
    const inv = await invoice({ invoiceDiscount: 3 });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    invoiceId = inv.body.id;
    const [d] = await docsOf(invoiceId);
    expect(d).toMatchObject({ kind: 'SALE', party: 'PATIENT', status: 'SUBMITTED', docNumber: inv.body.invoiceNumber, typeName: '012', total: 39 });
    expect(d.qrSvg).toContain('<svg');
    saleId = d.id;
    const sent = received[received.length - 1];
    expect([sent.clientId, sent.secret]).toEqual([CLIENT_ID, SECRET]);
    const xml = sent.xml;
    // Root tag on one line, profile, type, currencies, ICV, seller, income source (guide pp. 10, 33-38, 102)
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="[^"]+" xmlns:cbc="[^"]+" xmlns:ext="[^"]+">/);
    expect(xml).not.toContain('\n');
    expect(xml).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
    expect(xml).toContain('<cbc:InvoiceTypeCode name="012">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>');
    expect(xml).toMatch(/<cac:AdditionalDocumentReference><cbc:ID>ICV<\/cbc:ID><cbc:UUID>\d+<\/cbc:UUID>/);
    expect(xml).toContain('<cbc:CompanyID>12345678</cbc:CompanyID>');
    expect(xml).toContain('<cbc:RegistrationName>عيادة إيمرجنسي بلس</cbc:RegistrationName>');
    expect(xml).toContain('<cac:SellerSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>9932895</cbc:ID>');
    // Exempt medical services: category Z at 0 %, no tax added
    expect(xml.match(/schemeID="UN\/ECE 5305">Z</g)).toHaveLength(2);
    expect(xml).not.toContain('5305">S<');
    expect(xml).toContain('<cbc:TaxAmount currencyID="JO">0.000</cbc:TaxAmount>');
    // Totals: 2×20 + 2 = 42 before discount, invoice discount 3 spread on the lines, payable 39
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="JO">42.000</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="JO">3.000</cbc:AllowanceTotalAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="JO">39.000</cbc:PayableAmount>');
    // Privacy: the patient stays anonymous (name only required above 10,000 JD)
    expect(xml).not.toContain('مريض الفوترة الوطنية');
    expect(xml).not.toContain('0791118899');
    const doc = await prisma.eInvoice.findUniqueOrThrow({ where: { id: saleId }, include: { attemptsLog: true } });
    expect(doc.attemptsLog).toHaveLength(1);
    expect(doc.attemptsLog[0]).toMatchObject({ httpStatus: 200, einvStatus: 'SUBMITTED', outcome: 'SUBMITTED' });
    expect(JSON.stringify(doc.attemptsLog)).not.toContain(SECRET);
  });

  it('a lost answer is retried with the same ID+UUID and recovers the same QR (no duplicate invoice)', async () => {
    mode = 'lost';
    const inv = await invoice();
    const [d] = await docsOf(inv.body.id);
    expect(d.status).toBe('UNKNOWN');
    expect(d.qrSvg).toBeNull();
    mode = 'ok';
    await prisma.eInvoice.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await processQueue();
    const [after] = await docsOf(inv.body.id);
    expect(after).toMatchObject({ status: 'SUBMITTED', uuid: d.uuid, docNumber: d.docNumber });
    const sends = received.filter((r) => r.id === d.docNumber);
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((s) => s.uuid)).size).toBe(1);
    expect(sends[0].xml).toBe(sends[1].xml); // resent byte-for-byte
    expect([...accepted.keys()].filter((k) => k.startsWith(`${d.docNumber}|`))).toHaveLength(1);
    const attempts = await prisma.eInvoiceAttempt.findMany({ where: { eInvoiceId: d.id }, orderBy: { at: 'asc' } });
    expect(attempts.map((a) => [a.httpStatus, a.outcome, a.einvStatus])).toEqual([[504, 'UNKNOWN', null], [200, 'SUBMITTED', 'ALREADY_SUBMITTED']]);
  });

  it('cannot cancel while an outcome is unknown', async () => {
    mode = 'lost';
    const inv = await invoice();
    mode = 'ok';
    const c = await admin.post(`/api/billing/invoices/${inv.body.id}/cancel`, { reason: 'خطأ في الإدخال' });
    expect(c.status).toBe(409);
    expect((await admin.get(`/api/billing/invoices/${inv.body.id}`)).body.status).not.toBe('CANCELLED');
    const [d] = await docsOf(inv.body.id);
    expect((await admin.post(`/api/einvoice/documents/${d.id}/send`)).status).toBe(200);
    expect((await docsOf(inv.body.id))[0].status).toBe('SUBMITTED');
  });

  it('a rejected invoice shows the reason; only einvoice.send may resend it, keeping its number and UUID', async () => {
    mode = 'reject';
    const inv = await invoice();
    const [d] = await docsOf(inv.body.id);
    expect(d.status).toBe('REJECTED');
    expect(d.lastError).toContain('Total General Amount is Not Correct');
    expect((await reception.post(`/api/einvoice/documents/${d.id}/send`)).status).toBe(403);
    expect((await reception.get(`/api/einvoice/documents`)).status).toBe(403);
    expect((await reception.get(`/api/einvoice/invoices/${inv.body.id}`)).status).toBe(200); // shown on the invoice
    mode = 'ok';
    const r = await admin.post(`/api/einvoice/documents/${d.id}/send`);
    expect(r.body.status).toBe('SUBMITTED');
    const [after] = await docsOf(inv.body.id);
    expect([after.docNumber, after.uuid]).toEqual([d.docNumber, d.uuid]);
    const audit = await prisma.auditLog.findMany({ where: { action: 'einvoice.resend', entityId: inv.body.id } });
    expect(audit).toHaveLength(1);
  });

  it('wrong credentials are reported without leaking them', async () => {
    mode = 'forbidden';
    const inv = await invoice();
    const [d] = await docsOf(inv.body.id);
    expect(d.status).toBe('FAILED');
    expect(d.lastError).toContain('Client ID');
    mode = 'ok';
    const full = (await admin.get(`/api/einvoice/documents/${d.id}`)).body;
    expect(JSON.stringify(full)).not.toContain(SECRET);
    expect((await admin.post('/api/einvoice/retry')).body.tried).toBeGreaterThanOrEqual(1);
    expect((await docsOf(inv.body.id))[0].status).toBe('SUBMITTED');
  });

  it('a submitted invoice keeps its date; corrections go through a return', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    const r = await admin.put(`/api/billing/invoices/${invoiceId}/date`, { date: day, reason: 'تجربة' });
    expect(r.status).toBe(400);
    expect(r.body.error?.message ?? '').toContain('نظام الفوترة');
  });

  it('partial returns by quantity (381) reference the original; never more than sold', async () => {
    expect((await reception.post(`/api/einvoice/documents/${saleId}/returns`, { reason: 'إرجاع', lines: [{ lineId: 1, quantity: 1 }] })).status).toBe(403);
    const r1 = await admin.post(`/api/einvoice/documents/${saleId}/returns`, { reason: 'خدمة لم تُقدَّم', lines: [{ lineId: 1, quantity: 1 }] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.status).toBe('SUBMITTED');
    const xml = lastXml();
    const sale = await prisma.eInvoice.findUniqueOrThrow({ where: { id: saleId } });
    expect(xml).toContain('<cbc:InvoiceTypeCode name="012">381</cbc:InvoiceTypeCode>');
    expect(xml).toContain(`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${sale.docNumber}</cbc:ID><cbc:UUID>${sale.uuid}</cbc:UUID><cbc:DocumentDescription>39.000</cbc:DocumentDescription>`);
    expect(xml).toContain('<cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode><cbc:InstructionNote>خدمة لم تُقدَّم</cbc:InstructionNote>');
    expect(xml).toContain('<cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">1.000</cbc:InvoicedQuantity>');
    expect((await admin.post(`/api/einvoice/documents/${saleId}/returns`, { reason: 'زيادة', lines: [{ lineId: 1, quantity: 2 }] })).status).toBe(400);
    const docs = await docsOf(invoiceId);
    expect(docs.find((d) => d.id === saleId)!.lines.find((l) => l.lineId === 1)!.remaining).toBe('1');
  });

  it('cancelling an accepted invoice returns whatever is left of it automatically', async () => {
    const c = await admin.post(`/api/billing/invoices/${invoiceId}/cancel`, { reason: 'إلغاء بطلب المريض' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const docs = await docsOf(invoiceId);
    const rets = docs.filter((d) => d.kind === 'RETURN');
    expect(rets).toHaveLength(2);
    expect(rets.every((d) => d.status === 'SUBMITTED')).toBe(true);
    const sale = docs.find((d) => d.id === saleId)!;
    expect(sale.lines.every((l) => l.remaining === '0')).toBe(true);
    // Discount returned in full over the two returns: 39 sold = 39 returned
    expect(rets.reduce((t, d) => t + d.total, 0)).toBeCloseTo(39, 3);
  });

  it('an invoice cancelled before it was accepted is voided, not returned', async () => {
    mode = 'reject';
    const inv = await invoice();
    mode = 'ok';
    expect((await admin.post(`/api/billing/invoices/${inv.body.id}/cancel`, { reason: 'خطأ' })).status).toBe(200);
    const docs = await docsOf(inv.body.id);
    expect(docs.map((d) => [d.kind, d.status])).toEqual([['SALE', 'VOID']]);
  });
});

describe('insurance invoices, per company setting', () => {
  let companyId: string, membershipId: string, insPatient: string;
  const insInvoice = () => admin.post('/api/billing/invoices', {
    patientId: insPatient, templateId, payerType: 'INSURANCE', patientInsuranceId: membershipId, items: [{ serviceId: ecgId, quantity: 1 }], issue: true,
  });
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    companyId = (await admin.post('/api/insurance/companies', { nameAr: 'شركة الفوترة للتأمين', taxNumber: '55667788' })).body.id;
    const k = await admin.post(`/api/insurance/companies/${companyId}/contracts`, {
      name: 'عقد', coveragePercent: 80, startDate: day(-30), endDate: day(365), rules: [{ category: 'PROCEDURE', covered: true, coveragePercent: 90 }],
    });
    insPatient = (await reception.post('/api/patients', { fullName: 'مؤمَّن الفوترة', phone: '0791118800', gender: 'FEMALE' })).body.id;
    const m = await reception.post(`/api/insurance/patients/${insPatient}/memberships`, { contractId: k.body.id, memberId: 'F-1', startDate: day(-10), endDate: day(200) });
    membershipId = m.body.memberships[0].id;
  });

  it('default: only the patient share goes to the national system', async () => {
    const inv = await insInvoice();
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const docs = await docsOf(inv.body.id);
    expect(docs.map((d) => [d.party, d.typeName, d.total, d.status])).toEqual([['PATIENT', '012', 2, 'SUBMITTED']]);
  });

  it('patient + company: a second, receivable invoice to the company with its name and tax number', async () => {
    const c = (await admin.get(`/api/insurance/companies/${companyId}`)).body;
    expect((await admin.put(`/api/insurance/companies/${companyId}`, { ...c, einvoiceMode: 'PATIENT_AND_COMPANY' })).status).toBe(200);
    const inv = await insInvoice();
    const docs = await docsOf(inv.body.id);
    expect(docs.map((d) => [d.party, d.typeName, d.total, d.status])).toEqual([['PATIENT', '012', 2, 'SUBMITTED'], ['COMPANY', '022', 18, 'SUBMITTED']]);
    const xml = lastXml();
    expect(xml).toContain('<cbc:InvoiceTypeCode name="022">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:ID schemeID="TN">55667788</cbc:ID>');
    expect(xml).toContain('<cbc:RegistrationName>شركة الفوترة للتأمين</cbc:RegistrationName>');
    expect(xml).not.toContain('مؤمَّن الفوترة');
  });

  it('none: nothing at all goes to the national system for this company', async () => {
    const c = (await admin.get(`/api/insurance/companies/${companyId}`)).body;
    expect((await admin.put(`/api/insurance/companies/${companyId}`, { ...c, einvoiceMode: 'NONE' })).status).toBe(200);
    const before = received.length;
    const inv = await insInvoice();
    expect(inv.status).toBe(201);
    expect(await docsOf(inv.body.id)).toEqual([]);
    await processQueue();
    expect(received.length).toBe(before);
    // and cancelling such an invoice needs no national return
    expect((await admin.post(`/api/billing/invoices/${inv.body.id}/cancel`, { reason: 'تجربة' })).status).toBe(200);
    expect(await docsOf(inv.body.id)).toEqual([]);
  });

  it('full amount to the patient', async () => {
    const c = (await admin.get(`/api/insurance/companies/${companyId}`)).body;
    await admin.put(`/api/insurance/companies/${companyId}`, { ...c, einvoiceMode: 'FULL_TO_PATIENT' });
    const docs = await docsOf((await insInvoice()).body.id);
    expect(docs.map((d) => [d.party, d.total])).toEqual([['PATIENT', 20]]);
  });
});

describe('invoice counter (ICV)', () => {
  it('is given on the first real send: unique and sequential from 1, unchanged by resends', async () => {
    const docs = await prisma.eInvoice.findMany({ where: { icv: { not: null } }, select: { icv: true, docNumber: true } });
    const icvs = docs.map((d) => d.icv!).sort((a, b) => a - b);
    expect(icvs).toEqual(icvs.map((_, i) => i + 1));
    // Every send of a document carried its own, single ICV
    for (const d of docs) {
      const sent = new Set(received.filter((r) => r.id === d.docNumber).map((r) => r.xml.match(/<cbc:ID>ICV<\/cbc:ID><cbc:UUID>(\d+)</)?.[1]));
      expect([...sent]).toEqual([String(d.icv)]);
    }
  });
});

describe('UBL builder and response handling (unit)', () => {
  const base: DocInput = {
    docNumber: 'EIN0001', uuid: '0043e15e-740b-4e1b-889d-504afdb1d1d2', icv: 1, issueDate: '2023-11-20', typeName: '012', kind: 'SALE',
    seller: { taxNumber: '12345678', name: 'Seller', incomeSourceSeq: '9932895' }, buyer: {},
    lines: [
      { lineId: 1, itemId: 'a', name: 'Biscuit', quantity: '33', unitPrice: '2', discount: '2', taxPercent: '7', taxCategory: 'S' },
      { lineId: 2, itemId: 'b', name: 'Choclate', quantity: '10', unitPrice: '5', discount: '0', taxPercent: '0', taxCategory: 'Z' },
    ],
  };
  it('reproduces the totals of the guide example (pp. 40, 43-44)', () => {
    const t = totals(base.lines);
    expect([t.taxExclusive, t.discount, t.tax, t.inclusive].map((v) => v.toFixed(3))).toEqual(['116.000', '2.000', '4.480', '118.480']);
    const xml = buildXml(base);
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="JO">64.000</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:RoundingAmount currencyID="JO">68.480</cbc:RoundingAmount>');
  });
  it('flags what the national system would reject', () => {
    expect(validate({ ...base, typeName: '022' })).toContain('اسم المشتري إجباري في فاتورة الذمم');
    expect(validate({ ...base, lines: [{ ...base.lines[0], taxPercent: '6' }] }).join()).toContain('غير معتمدة');
    expect(validate({ ...base, lines: [base.lines[0], { ...base.lines[1], lineId: 1 }] }).join()).toContain('مكرر');
    expect(validate(base)).toEqual([]);
  });
  it('classifies answers by EINV_STATUS, not by the HTTP code alone', () => {
    expect(classify(200, { EINV_STATUS: 'SUBMITTED', EINV_QR: 'x' }, null, 1).outcome).toBe('SUBMITTED');
    expect(classify(200, { EINV_STATUS: ' ALREADY_SUBMITTED ', EINV_QR: 'x' }, null, 1).outcome).toBe('SUBMITTED');
    expect(classify(200, { EINV_STATUS: 'SUBMITTED', EINV_QR: null }, null, 1).outcome).toBe('UNKNOWN');
    expect(classify(400, { EINV_STATUS: 'NOT_SUBMITTED' }, null, 1).outcome).toBe('REJECTED');
    expect(classify(403, null, null, 1).outcome).toBe('FAILED');
    expect(classify(504, null, null, 1).outcome).toBe('UNKNOWN');
    expect(classify(null, null, 'timeout', 1).outcome).toBe('UNKNOWN');
  });
});
