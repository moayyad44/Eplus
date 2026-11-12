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

    const det = (await admin.get(`/api/reports/invoice-details?from=${DAY}&to=${DAY}`)).body;
    const row = det.rows.find((x: { id: string }) => x.id === a.body.id);
    expect(row).toMatchObject({ discount: 4, total: 36, paid: 30, refunded: 5, balance: 6, patient: { name: 'مريض التقارير الإضافية', phone: '0795554433', gender: 'أنثى' }, methods: [expect.any(String)] });
    expect(row.payments[0]).toMatchObject({ amount: 30 });
    expect(row.refunds[0]).toMatchObject({ amount: 5, notes: 'إرجاع جزء' });
    expect(det.rows.find((x: { id: string }) => x.id === b.body.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'فاتورة مكررة' });
    expect(det.totals.total).toBe(36); // the cancelled invoice is listed but not counted
    const x = await admin.get(`/api/reports/invoice-details?from=${DAY}&to=${DAY}&format=xlsx`);
    expect([x.status, x.headers['content-type']]).toEqual([200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    expect((await reception.get(`/api/reports/invoice-details?from=${DAY}&to=${DAY}`)).status).toBe(403);
  });

  it('the detailed invoice report gathers the visit: nurse, diagnosis, prescription, medical report, lab tests and cost', async () => {
    const d = new Date(); d.setDate(d.getDate() - 710); const DAY = d.toISOString().slice(0, 10);
    const [doc, nurse] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { username: 'dr.ahmad' } }), prisma.user.findUniqueOrThrow({ where: { username: 'nurse.sara' } })]);
    const pt = (await admin.post('/api/patients', { fullName: 'مريض التقرير المفصل', phone: '0796667788', gender: 'MALE', dateOfBirth: '1990-05-01' })).body;
    const lt = await prisma.labTest.findFirstOrThrow({ where: { serviceId: { not: null } } });
    await prisma.labTest.update({ where: { id: lt.id }, data: { labCost: 3.5 } });
    const v = await prisma.visit.create({ data: { visitNumber: `V-RX-${Date.now()}`, patientId: pt.id, doctorId: doc.id, status: 'COMPLETED', queueDate: new Date(`${DAY}T00:00:00Z`), arrivedAt: new Date(`${DAY}T09:00:00`), chiefComplaint: 'صداع' } });
    await prisma.vitalSigns.create({ data: { visitId: v.id, patientId: pt.id, bpSystolic: 120, bpDiastolic: 80, recordedById: nurse.id } });
    await prisma.diagnosis.create({ data: { visitId: v.id, patientId: pt.id, icd10Code: 'R51', description: 'صداع', type: 'PRIMARY' } });
    await prisma.prescription.create({ data: { visitId: v.id, patientId: pt.id, doctorId: doc.id, items: { create: [{ drugName: 'Paracetamol 500mg', dose: '1 حبة', frequency: 'كل 8 ساعات', duration: '3 أيام', sortOrder: 0 }] } } });
    await prisma.medicalReport.create({ data: { visitId: v.id, patientId: pt.id, doctorId: doc.id, title: 'تقرير طبي', content: 'المريض بحاجة لراحة يومين' } });
    await prisma.labOrder.create({ data: { orderNumber: `LO-RX-${Date.now()}`, visitId: v.id, patientId: pt.id, doctorId: doc.id, requestedAt: new Date(`${DAY}T09:30:00`), items: { create: [{ labTestId: lt.id, testName: lt.name }] } } });
    const templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false } })).id;
    const inv = await admin.post('/api/billing/invoices', { patientId: pt.id, visitId: v.id, doctorId: doc.id, templateId, items: [{ serviceId: lt.serviceId, quantity: 1 }], invoiceDate: DAY });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const row = (await admin.get(`/api/reports/invoice-details?from=${DAY}&to=${DAY}`)).body.rows.find((x: { id: string }) => x.id === inv.body.id);
    expect(row).toMatchObject({ doctor: doc.fullName, nurses: [nurse.fullName], visitNumber: v.visitNumber, chiefComplaint: 'صداع', diagnoses: ['R51 صداع'], labCost: 3.5, orderedTests: [lt.name], patient: { dateOfBirth: '1990-05-01' } });
    expect(row.prescription[0]).toContain('Paracetamol 500mg');
    expect(row.reports[0]).toMatchObject({ title: 'تقرير طبي' });
    expect(row.labTests).toHaveLength(1);
    expect(row.labRevenue).toBe(row.total);
    expect(row.vitals).toContain('120/80');
  });
});
