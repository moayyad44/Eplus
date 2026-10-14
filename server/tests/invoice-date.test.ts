import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, reception: Client;
let patientId: string, templateId: string, serviceId: string, cashId: string;
// Days far in the past that no other test touches, so report totals are exact.
const dayAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const D1 = dayAgo(400), D2 = dayAgo(395), D3 = dayAgo(390);
const today = dayAgo(0);
// Payments are dated on a quiet past day so other tests' "today" cash totals stay exact.
const PAY_DAY = dayAgo(380);
const payOn = (amount: number) => ({ amount, methodId: cashId, paidAt: new Date(`${PAY_DAY}T10:00:00`).toISOString() });
const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

beforeAll(async () => {
  [admin, reception] = await Promise.all([login('admin'), login('reception')]);
  const p = await reception.post('/api/patients', { fullName: 'مراجع تاريخ الفاتورة', phone: '0791112277', gender: 'MALE' });
  patientId = p.body.id;
  templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false } })).id;
  serviceId = (await prisma.service.findFirstOrThrow({ where: { code: 'SRV-ECG' } })).id; // 20 JD
  cashId = (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CASH' } })).id;
});

const newInvoice = (c: Client, extra: object = {}) =>
  c.post('/api/billing/invoices', { patientId, templateId, items: [{ serviceId, quantity: 1 }], issue: true, ...extra });

describe('invoice date (back-dating)', () => {
  it('only a user with invoices.backdate may create an invoice with an earlier date — enforced by the API', async () => {
    const r = await newInvoice(reception, { invoiceDate: D1 });
    expect(r.status).toBe(403);
    const ok = await newInvoice(reception, { invoiceDate: today });
    expect(ok.status).toBe(201);
    expect(localDay(ok.body.issuedAt)).toBe(today);
    expect((await newInvoice(admin, { invoiceDate: dayAgo(-1) })).status).toBe(400); // never in the future
  });

  it('keeps the invoice date apart from the real creation/issue time; reports follow the invoice date, cash the payment date', async () => {
    const created = await newInvoice(admin, { invoiceDate: D1 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await admin.post(`/api/billing/invoices/${created.body.id}/payments`, payOn(20))).status).toBe(201);
    const r = { body: (await admin.get(`/api/billing/invoices/${created.body.id}`)).body };
    expect(localDay(r.body.issuedAt)).toBe(D1);
    expect(localDay(r.body.issuedRecordedAt)).toBe(today);
    expect(localDay(r.body.createdAt)).toBe(today);
    expect(r.body.status).toBe('PAID');
    expect(localDay(r.body.payments[0].paidAt)).toBe(PAY_DAY); // the payment keeps its own date

    const onD1 = await admin.get(`/api/reports/financial?from=${D1}&to=${D1}`);
    expect([onD1.body.summary.invoiceCount, onD1.body.summary.netSales, onD1.body.summary.collected]).toEqual([1, 20, 0]);
    const list = await admin.get(`/api/billing/invoices?from=${D1}&to=${D1}`);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([r.body.id]);
  });

  it('changing the date moves the invoice between periods without touching amounts, payments or status, and is audited', async () => {
    const id = (await newInvoice(admin, { invoiceDate: D1 })).body.id;
    expect((await admin.post(`/api/billing/invoices/${id}/payments`, payOn(5))).status).toBe(201);
    const inv = (await admin.get(`/api/billing/invoices/${id}`)).body;
    expect((await reception.put(`/api/billing/invoices/${inv.id}/date`, { date: D2 })).status).toBe(403);

    const r = await admin.put(`/api/billing/invoices/${inv.id}/date`, { date: D2, reason: 'تصحيح تاريخ' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.oldDate, r.body.newDate]).toEqual([D1, D2]);
    const after = r.body.invoice;
    expect(localDay(after.issuedAt)).toBe(D2);
    for (const k of ['invoiceNumber', 'total', 'paidAmount', 'balance', 'status', 'dueDate', 'issuedRecordedAt', 'createdAt']) expect(after[k]).toEqual(inv[k]);
    expect(after.payments.map((p: { paidAt: string; amount: unknown }) => [p.paidAt, p.amount])).toEqual(inv.payments.map((p: { paidAt: string; amount: unknown }) => [p.paidAt, p.amount]));

    const onD2 = await admin.get(`/api/reports/financial?from=${D2}&to=${D2}`);
    expect(onD2.body.summary.invoiceCount).toBe(1);

    expect((await admin.put(`/api/billing/invoices/${inv.id}/date`, { date: D2 })).status).toBe(400); // same date
    expect((await admin.put(`/api/billing/invoices/${inv.id}/date`, { date: dayAgo(-2) })).status).toBe(400); // future

    const hist = await admin.get(`/api/billing/invoices/${inv.id}/date-history`);
    expect(hist.body).toHaveLength(1);
    expect(hist.body[0]).toMatchObject({ invoiceNumber: inv.invoiceNumber, oldDate: D1, newDate: D2, reason: 'تصحيح تاريخ' });
    expect(hist.body[0].summary).toContain(inv.invoiceNumber);
    expect(hist.body[0].userName).toBeTruthy();
    // The audit trail is append-only at the database level.
    await expect(prisma.auditLog.delete({ where: { id: hist.body[0].id } })).rejects.toThrow();
    await expect(prisma.auditLog.update({ where: { id: hist.body[0].id }, data: { summary: 'x' } })).rejects.toThrow();
  });

  it('refuses a date after the first payment, on a cancelled invoice, and once its insurance claim was submitted', async () => {
    // Payment received on D2 → the invoice cannot be dated D3 (after the money came in).
    const inv = (await newInvoice(admin, { invoiceDate: D1 })).body;
    const pay = await admin.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 5, methodId: cashId, paidAt: new Date(`${D2}T10:00:00`).toISOString() });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const late = await admin.put(`/api/billing/invoices/${inv.id}/date`, { date: D3 });
    expect(late.status).toBe(400);
    expect(late.body.error.message).toContain('أول دفعة');

    const c = (await newInvoice(admin)).body;
    expect((await admin.post(`/api/billing/invoices/${c.id}/cancel`, { reason: 'خطأ' })).status).toBe(200);
    expect((await admin.put(`/api/billing/invoices/${c.id}/date`, { date: D1 })).status).toBe(400);

    const m = await prisma.patientInsurance.findFirstOrThrow({ where: { status: 'ACTIVE', deletedAt: null } });
    const ins = await admin.post('/api/billing/invoices', { patientId: m.patientId, templateId, payerType: 'INSURANCE', patientInsuranceId: m.id, items: [{ serviceId, quantity: 1 }], issue: true });
    expect(ins.status, JSON.stringify(ins.body)).toBe(201);
    const claim = await prisma.insuranceClaim.findUnique({ where: { invoiceId: ins.body.id } });
    if (claim) {
      expect((await admin.put(`/api/billing/invoices/${ins.body.id}/date`, { date: D1 })).status).toBe(200); // not yet sent
      await prisma.insuranceClaim.update({ where: { id: claim.id }, data: { status: 'SUBMITTED' } });
      const blocked = await admin.put(`/api/billing/invoices/${ins.body.id}/date`, { date: D2 });
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.message).toContain(claim.claimNumber);
    }
  });

  it('a draft keeps its requested date until issued; the invoice number sequence is unaffected', async () => {
    const d = await admin.post('/api/billing/invoices', { patientId, templateId, items: [{ serviceId, quantity: 1 }], issue: false, invoiceDate: D3 });
    expect([d.status, d.body.status, localDay(d.body.issuedAt)]).toEqual([201, 'DRAFT', D3]);
    // A receptionist may finish the draft as long as the date stays the same.
    const issued = await reception.put(`/api/billing/invoices/${d.body.id}`, { patientId, templateId, items: [{ serviceId, quantity: 1 }], invoiceDate: D3, issue: true });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect([issued.body.status, localDay(issued.body.issuedAt), localDay(issued.body.issuedRecordedAt)]).toEqual(['ISSUED', D3, today]);
    expect(issued.body.invoiceNumber).toMatch(/\d{6}$/);
  });
});

describe('receipt date (back-dating payments and refunds)', () => {
  const R1 = dayAgo(370), R2 = dayAgo(365), R3 = dayAgo(360);
  const at = (day: string, h = 10) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).toISOString();

  it('recording a receipt with an earlier date needs payments.backdate; never in the future or before the invoice date', async () => {
    const inv = (await newInvoice(admin, { invoiceDate: R1 })).body;
    expect((await reception.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 5, methodId: cashId, paidAt: at(R2) })).status).toBe(403);
    expect((await admin.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 5, methodId: cashId, paidAt: at(dayAgo(371)) })).status).toBe(400); // before the invoice
    expect((await admin.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 5, methodId: cashId, paidAt: at(dayAgo(-1)) })).status).toBe(400); // future
    const ok = await admin.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 5, methodId: cashId, paidAt: at(R2) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const onR2 = await admin.get(`/api/reports/financial?from=${R2}&to=${R2}`);
    expect(onR2.body.summary.collected).toBe(5);
  });

  it('changing a receipt date moves the cash between days without touching the invoice; admin only; audited', async () => {
    const inv = (await newInvoice(admin, { invoiceDate: R1 })).body;
    const pay = (await admin.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 7, methodId: cashId, paidAt: at(R2) })).body.payment;
    const before = (await admin.get(`/api/billing/invoices/${inv.id}`)).body;

    expect((await reception.put(`/api/billing/payments/${pay.id}/date`, { date: R3 })).status).toBe(403);
    const r = await admin.put(`/api/billing/payments/${pay.id}/date`, { date: R3, reason: 'استلام متأخر' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.oldDate, r.body.newDate]).toEqual([R2, R3]);

    const after = (await admin.get(`/api/billing/invoices/${inv.id}`)).body;
    for (const k of ['issuedAt', 'total', 'paidAmount', 'balance', 'status']) expect(after[k]).toEqual(before[k]);
    const p = after.payments.find((x: { id: string }) => x.id === pay.id);
    expect([localDay(p.paidAt), p.amount, p.receiptNumber]).toEqual([R3, pay.amount, pay.receiptNumber]);
    expect((await admin.get(`/api/reports/financial?from=${R3}&to=${R3}`)).body.summary.collected).toBe(7);

    expect((await admin.put(`/api/billing/payments/${pay.id}/date`, { date: R3 })).status).toBe(400); // same day
    expect((await admin.put(`/api/billing/payments/${pay.id}/date`, { date: dayAgo(375) })).status).toBe(400); // before the invoice date
    expect((await admin.put(`/api/billing/payments/${pay.id}/date`, { date: dayAgo(-1) })).status).toBe(400); // future

    const hist = (await admin.get(`/api/billing/invoices/${inv.id}/payment-date-history`)).body;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ receiptNumber: pay.receiptNumber, oldDate: R2, newDate: R3, reason: 'استلام متأخر' });
    expect(hist[0].userName).toBeTruthy();
    await expect(prisma.auditLog.delete({ where: { id: hist[0].id } })).rejects.toThrow();
  });

  it('keeps payments and refunds in order, and refuses voided receipts', async () => {
    const inv = (await newInvoice(admin, { invoiceDate: R1 })).body;
    const pay = (await admin.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 10, methodId: cashId, paidAt: at(R2) })).body.payment;
    expect((await admin.post(`/api/billing/invoices/${inv.id}/refunds`, { amount: 2, methodId: cashId, notes: 'إرجاع جزئي', paidAt: at(R1) })).status).toBe(400); // refund before the payment
    const ref = (await admin.post(`/api/billing/invoices/${inv.id}/refunds`, { amount: 2, methodId: cashId, notes: 'إرجاع جزئي', paidAt: at(R3) })).body.payment;
    expect((await admin.put(`/api/billing/payments/${pay.id}/date`, { date: dayAgo(355) })).status).toBe(400); // payment after its refund
    expect((await admin.put(`/api/billing/payments/${ref.id}/date`, { date: R1 })).status).toBe(400); // refund before the payment

    const p2 = (await admin.post(`/api/billing/invoices/${inv.id}/payments`, { amount: 1, methodId: cashId, paidAt: at(R3, 12) })).body.payment;
    expect((await admin.post(`/api/billing/payments/${p2.id}/void`, { reason: 'خطأ إدخال' })).status).toBe(200);
    expect((await admin.put(`/api/billing/payments/${p2.id}/date`, { date: R2 })).status).toBe(400);
  });
});
