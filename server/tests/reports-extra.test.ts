import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, reception: Client;
const Y = new Date().getFullYear();
const range = `from=${Y}-01-01&to=${Y}-12-31`;

beforeAll(async () => { [admin, reception] = await Promise.all([login('admin'), login('reception')]); });

describe('extra clinic reports', () => {
  it('every new report answers with its shape for the administrator', async () => {
    const s = await admin.get(`/api/reports/services?${range}`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toHaveProperty('totals.net');
    const c = await admin.get(`/api/reports/collections?${range}`);
    expect([c.status, Array.isArray(c.body.byDay)]).toEqual([200, true]);
    const r = await admin.get('/api/reports/receivables');
    expect([r.status, typeof r.body.total]).toEqual([200, 'number']);
    const k = await admin.get(`/api/reports/control?${range}`);
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(k.body.totals).toHaveProperty('backdated');
    const a = await admin.get(`/api/reports/appointments?${range}`);
    expect(a.status).toBe(200);
    const o = await admin.get(`/api/reports/operations?${range}`);
    expect([o.status, o.body.byWeekday.length], JSON.stringify(o.body)).toEqual([200, 7]);
    const l = await admin.get(`/api/reports/lab?${range}`);
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    const e = await admin.get(`/api/reports/expenses?${range}`);
    expect([e.status, typeof e.body.total]).toEqual([200, 'number']);
  });

  it('collections add up: payments minus refunds equal the daily totals', async () => {
    const c = (await admin.get(`/api/reports/collections?${range}`)).body;
    const days = c.byDay.reduce((t: number, d: { total: number }) => t + d.total, 0);
    expect(Math.round(days * 1000) / 1000).toBe(Math.round((c.totals.payments - c.totals.refunds) * 1000) / 1000);
  });

  it('financial reports stay closed to users without the permission', async () => {
    for (const p of ['services', 'collections', 'receivables', 'control', 'expenses']) expect((await reception.get(`/api/reports/${p}?${range}`)).status, p).toBe(403);
  });

  it('with real activity on a quiet past day the figures are exact', async () => {
    const d = new Date(); d.setDate(d.getDate() - 700); const DAY = d.toISOString().slice(0, 10);
    const at = (h: number) => new Date(`${DAY}T${String(h).padStart(2, '0')}:00:00`).toISOString();
    const p = (await admin.post('/api/patients', { fullName: 'مريض التقارير الإضافية', phone: '0795554433', gender: 'FEMALE' })).body;
    const templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false } })).id;
    const svc = await prisma.service.findFirstOrThrow({ where: { code: 'SRV-ECG' } }); // 20 JD
    const cash = (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CASH' } })).id;
    const mk = (extra: object) => admin.post('/api/billing/invoices', { patientId: p.id, templateId, items: [{ serviceId: svc.id, quantity: 2, discount: 4 }], invoiceDate: DAY, ...extra });
    const a = await mk({});
    expect(a.status, JSON.stringify(a.body)).toBe(201); // 2 × 20 − 4 = 36
    expect((await admin.post(`/api/billing/invoices/${a.body.id}/payments`, { amount: 30, methodId: cash, paidAt: at(10) })).status).toBe(201);
    expect((await admin.post(`/api/billing/invoices/${a.body.id}/refunds`, { amount: 5, methodId: cash, paidAt: at(12), notes: 'إرجاع جزء' })).status).toBe(201);
    const b = await mk({});
    const pay = await admin.post(`/api/billing/invoices/${b.body.id}/payments`, { amount: 10, methodId: cash, paidAt: at(11) });
    const pid = (await prisma.payment.findFirstOrThrow({ where: { invoiceId: b.body.id } })).id;
    expect((await admin.post(`/api/billing/payments/${pid}/void`, { reason: 'خطأ في الإدخال' })).status).toBe(200);
    expect((await admin.post(`/api/billing/invoices/${b.body.id}/cancel`, { reason: 'فاتورة مكررة' })).status).toBe(200);

    const r = `from=${DAY}&to=${DAY}`;
    const s = (await admin.get(`/api/reports/services?${r}`)).body;
    expect(s.rows.find((x: { serviceId: string }) => x.serviceId === svc.id)).toMatchObject({ quantity: 2, net: 36, discount: 4, avgPrice: 18 });
    const c = (await admin.get(`/api/reports/collections?from=${DAY}&to=${DAY}`)).body;
    expect([c.totals.payments, c.totals.refunds]).toEqual([30, 5]);
    expect(c.refunds).toHaveLength(1);
    expect(pay.status).toBe(201);
    const k = (await admin.get(`/api/reports/control?from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}`)).body;
    expect(k.cancelled.some((x: { id: string; cancelReason: string }) => x.id === b.body.id && x.cancelReason === 'فاتورة مكررة')).toBe(true);
    expect(k.backdated.some((x: { id: string; days: number }) => x.id === a.body.id && x.days >= 699)).toBe(true);
    const rc = (await admin.get('/api/reports/receivables')).body;
    expect(rc.rows.find((x: { id: string }) => x.id === a.body.id)).toMatchObject({ balance: 6 }); // the invoice's own balance: 36 − 30
    expect(rc.byPatient.find((x: { patientId: string }) => x.patientId === p.id).oldest).toBeGreaterThanOrEqual(699);
  });
});
