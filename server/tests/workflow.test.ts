import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, makeClient, type Client } from './helpers';

let admin: Client, reception: Client, nurse: Client, doctor: Client;
let doctorId: string;

beforeAll(async () => {
  [admin, reception, nurse, doctor] = await Promise.all([login('admin'), login('reception'), login('nurse.sara'), login('dr.ahmad')]);
  doctorId = (await prisma.user.findUniqueOrThrow({ where: { username: 'dr.ahmad' } })).id;
});

describe('authentication & security', () => {
  it('rejects unauthenticated access', async () => {
    const res = await makeClient().get('/api/patients');
    expect(res.status).toBe(401);
  });

  it('rejects wrong password with a generic message', async () => {
    const res = await makeClient().post('/api/auth/login', { username: 'admin', password: 'wrong-pass1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const res = await reception.agent.post('/api/patients').send({ fullName: 'x' });
    expect(res.status).toBe(403);
  });

  it('returns permissions with /me and never leaks password hashes', async () => {
    const res = await reception.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.permissions).toContain('patients.create');
    expect(res.body.permissions).not.toContain('medical.view');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('refresh rotates the token and logout revokes the session', async () => {
    const c = await login('nurse.sara');
    expect((await c.post('/api/auth/refresh')).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('end-to-end clinical & billing workflow', () => {
  let patientId: string, visitId: string, invoiceId: string, labOrderId: string;

  it('reception: phone lookup → not found → registers a new patient', async () => {
    const lookup = await reception.get('/api/patients/lookup?phone=٠٧٩ ٩٨٨ ٧٧٦٦');
    expect(lookup.status).toBe(200);
    expect(lookup.body.phone).toBe('0799887766');
    expect(lookup.body.items).toHaveLength(0);

    const res = await reception.post('/api/patients', { fullName: 'سامي  عبد الله', phone: '+962 79 988 7766', gender: 'MALE', dateOfBirth: '1990-05-01' });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('0799887766');
    expect(res.body.fullName).toBe('سامي عبد الله');
    expect(res.body.age).toBeGreaterThan(30);
    patientId = res.body.id;

    const again = await reception.get('/api/patients/lookup?phone=0799887766');
    expect(again.body.items[0].id).toBe(patientId);
  });

  it('prevents duplicate patient files', async () => {
    const res = await reception.post('/api/patients', { fullName: 'سامي عبد الله', phone: '0799887766', gender: 'MALE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_PATIENT');
  });

  it('reception: creates a visit and puts the patient in the queue', async () => {
    const res = await reception.post('/api/visits', { patientId, doctorId, priority: 'NORMAL', chiefComplaint: 'حرارة وسعال' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('WAITING');
    expect(res.body.queueNumber).toBeGreaterThan(0);
    visitId = res.body.id;

    const dup = await reception.post('/api/visits', { patientId, doctorId });
    expect(dup.status).toBe(409);

    const q = await reception.get('/api/visits/queue');
    expect(q.body.items.some((v: { id: string }) => v.id === visitId)).toBe(true);
  });

  it('an emergency visit jumps ahead of normal waiting patients', async () => {
    const p = await prisma.patient.findFirstOrThrow({ where: { fullName: 'ريم أحمد حداد' } });
    const res = await reception.post('/api/visits', { patientId: p.id, priority: 'EMERGENCY' });
    const q = await reception.get('/api/visits/queue?status=ACTIVE');
    const ids = q.body.items.map((v: { id: string }) => v.id);
    expect(ids.indexOf(res.body.id)).toBeLessThan(ids.indexOf(visitId));
    await reception.post(`/api/visits/${res.body.id}/status`, { status: 'CANCELLED', note: 'اختبار' });
  });

  it('reception cannot see clinical data', async () => {
    const res = await reception.get(`/api/visits/${visitId}`);
    expect(res.status).toBe(200);
    expect(res.body.canViewMedical).toBe(false);
    expect(res.body.vitalSigns).toBeUndefined();
    expect((await reception.get(`/api/patients/${patientId}/timeline`)).status).toBe(403);
  });

  it('nurse: calls the patient and records vital signs (BMI computed, validation enforced)', async () => {
    expect((await nurse.post(`/api/visits/${visitId}/status`, { status: 'CALLED' })).status).toBe(200);
    expect((await nurse.post(`/api/visits/${visitId}/status`, { status: 'WITH_NURSE' })).status).toBe(200);
    const bad = await nurse.post(`/api/visits/${visitId}/vitals`, { bpSystolic: 80, bpDiastolic: 120 });
    expect(bad.status).toBe(400);
    const res = await nurse.post(`/api/visits/${visitId}/vitals`, { bpSystolic: 120, bpDiastolic: 80, heartRate: 88, temperature: 38.4, oxygenSaturation: 97, weightKg: 80, heightCm: 180 });
    expect(res.status).toBe(201);
    expect(res.body.bmi).toBe(24.7);
    expect((await nurse.post(`/api/visits/${visitId}/status`, { status: 'WITH_DOCTOR' })).status).toBe(200);
  });

  it('nurse cannot go backwards without queue.revert, and cannot write diagnoses', async () => {
    const back = await nurse.post(`/api/visits/${visitId}/status`, { status: 'WAITING' });
    expect(back.status).toBe(400);
    const dx = await nurse.post(`/api/visits/${visitId}/diagnoses`, { description: 'x' });
    expect(dx.status).toBe(403);
  });

  it('doctor: sees own queue, writes consultation, diagnosis, prescription, report; orders labs', async () => {
    const q = await doctor.get('/api/visits/queue');
    expect(q.body.items.every((v: { doctor: { id: string } | null }) => !v.doctor || v.doctor.id === doctorId)).toBe(true);

    expect((await doctor.put(`/api/visits/${visitId}/consultation`, { chiefComplaint: 'حرارة وسعال منذ 3 أيام', examination: 'احتقان بالحلق', treatmentPlan: 'راحة وسوائل' })).status).toBe(200);
    expect((await doctor.post(`/api/visits/${visitId}/finish`)).status).toBe(400); // no diagnosis yet
    expect((await doctor.post(`/api/visits/${visitId}/diagnoses`, { icd10Code: 'j02.9', description: 'التهاب البلعوم الحاد' })).status).toBe(201);

    const drug = await prisma.drug.findFirstOrThrow({ where: { name: 'Paracetamol 500mg' } });
    const rx = await doctor.post(`/api/visits/${visitId}/prescriptions`, { items: [{ drugId: drug.id, drugName: drug.name, dose: '1 حبة', frequency: 'كل 6 ساعات', duration: '5 أيام' }] });
    expect(rx.status).toBe(201);
    const rxEdit = await doctor.put(`/api/prescriptions/${rx.body.id}`, { items: [{ drugName: 'Ibuprofen 400mg', dose: '1 حبة' }] });
    expect(rxEdit.status).toBe(200);

    expect((await doctor.post(`/api/visits/${visitId}/reports`, { title: 'تقرير طبي', content: 'المريض يعاني من التهاب بلعوم حاد.' })).status).toBe(201);

    const cbc = await prisma.labTest.findUniqueOrThrow({ where: { code: 'CBC' } });
    const lab = await doctor.post('/api/lab/orders', { visitId, patientId, testIds: [cbc.id] });
    expect(lab.status).toBe(201);
    labOrderId = lab.body.id;
    expect(await prisma.notification.count({ where: { type: 'LAB_REQUESTED', link: `/lab/${labOrderId}` } })).toBeGreaterThan(0);
  });

  it('lab: nurse collects sample and enters results → doctor is notified', async () => {
    expect((await nurse.post(`/api/lab/orders/${labOrderId}/status`, { status: 'SAMPLE_COLLECTED' })).status).toBe(200);
    const order = await nurse.get(`/api/lab/orders/${labOrderId}`);
    const itemId = order.body.items[0].id;
    const incomplete = await nurse.put(`/api/lab/orders/${labOrderId}/results`, { complete: true, items: [{ itemId, results: [] }] });
    expect(incomplete.status).toBe(400);
    const res = await nurse.put(`/api/lab/orders/${labOrderId}/results`, {
      complete: true,
      items: [{ itemId, results: [{ parameterName: 'WBC', value: '13.2', unit: '10^3/uL', referenceRange: '4.0-11.0', flag: 'HIGH' }] }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(await prisma.notification.count({ where: { userId: doctorId, type: 'LAB_RESULT_READY' } })).toBe(1);
  });

  it('doctor finishes the visit → waiting for payment; timeline holds everything', async () => {
    const res = await doctor.post(`/api/visits/${visitId}/finish`);
    expect(res.body.status).toBe('WAITING_PAYMENT');
    const tl = await doctor.get(`/api/patients/${patientId}/timeline`);
    const v = tl.body.items[0];
    expect(v.vitalSigns).toHaveLength(1);
    expect(v.diagnoses[0].icd10Code).toBe('J02.9');
    expect(v.prescriptions[0].items[0].drugName).toBe('Ibuprofen 400mg');
    expect(v.labOrders[0].items[0].results[0].value).toBe('13.2');
    expect(v.medicalReports).toHaveLength(1);
  });

  it('billing: suggested lines include ordered lab tests; mandatory consultation fee is enforced', async () => {
    const sug = await reception.get(`/api/billing/invoices/suggest?visitId=${visitId}`);
    expect(sug.status).toBe(200);
    expect(sug.body.items).toHaveLength(1);

    const tpl = await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: true } });
    const med = await prisma.service.findUniqueOrThrow({ where: { code: 'MED-PARA' } });
    const stockBefore = (await prisma.inventoryItem.findUniqueOrThrow({ where: { sku: 'MED-PARA' } })).quantity.toNumber();

    const res = await reception.post('/api/billing/invoices', {
      patientId, visitId, templateId: tpl.id, issue: true,
      items: [...sug.body.items, { serviceId: med.id, quantity: 2 }],
    });
    expect(res.status).toBe(201);
    invoiceId = res.body.id;
    const inv = res.body;
    expect(inv.invoiceNumber).toMatch(/^INV-\d{6}$/);
    expect(inv.items.some((i: { isMandatory: boolean; description: string }) => i.isMandatory && i.description === 'كشفية طبية')).toBe(true);
    // 15 (exam) + 8 (CBC) + 2 × 1.5 (medication) = 26
    expect(inv.total).toBe(26);
    expect(inv.doctor.id).toBe(doctorId);
    const stockAfter = (await prisma.inventoryItem.findUniqueOrThrow({ where: { sku: 'MED-PARA' } })).quantity.toNumber();
    expect(stockAfter).toBe(stockBefore - 2);
  });

  it('billing: reception cannot give discounts or override prices', async () => {
    const svc = await prisma.service.findUniqueOrThrow({ where: { code: 'CONS' } });
    const d = await reception.post('/api/billing/invoices', { patientId, items: [{ serviceId: svc.id, quantity: 1, discount: 5 }] });
    expect(d.status).toBe(403);
    const p = await reception.post('/api/billing/invoices', { patientId, items: [{ serviceId: svc.id, quantity: 1, unitPrice: 1 }] });
    expect(p.status).toBe(403);
  });

  it('payments: partial → outstanding, then full → PAID and the visit is completed', async () => {
    const methods = await admin.get('/api/settings/payment-methods');
    const cash = methods.body.find((m: { code: string }) => m.code === 'CASH');
    const cliq = methods.body.find((m: { code: string }) => m.code === 'CLIQ');

    const over = await reception.post(`/api/billing/invoices/${invoiceId}/payments`, { amount: 100, methodId: cash.id });
    expect(over.status).toBe(400);
    const noRef = await reception.post(`/api/billing/invoices/${invoiceId}/payments`, { amount: 5, methodId: cliq.id });
    expect(noRef.status).toBe(400);

    const p1 = await reception.post(`/api/billing/invoices/${invoiceId}/payments`, { amount: 10, methodId: cash.id });
    expect(p1.status).toBe(201);
    expect(p1.body.invoice.status).toBe('PARTIALLY_PAID');
    expect(p1.body.invoice.balance).toBe(16);

    const out = await reception.get('/api/billing/invoices/outstanding');
    expect(out.body.items.some((i: { id: string }) => i.id === invoiceId)).toBe(true);

    const p2 = await reception.post(`/api/billing/invoices/${invoiceId}/payments`, { amount: 16, methodId: cliq.id, reference: 'CLQ-778899' });
    expect(p2.body.invoice.status).toBe('PAID');
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.status).toBe('COMPLETED');

    const receipt = await reception.get(`/api/billing/payments/${p2.body.payment.id}`);
    expect(receipt.body.receiptNumber).toMatch(/^RCP-/);
  });

  it('invoices with payments cannot be cancelled; issued invoices cannot be edited or deleted', async () => {
    const cancel = await admin.post(`/api/billing/invoices/${invoiceId}/cancel`, { reason: 'اختبار الإلغاء' });
    expect(cancel.status).toBe(409);
    const edit = await admin.put(`/api/billing/invoices/${invoiceId}`, { patientId, items: [] });
    expect(edit.status).toBe(400);
    expect((await admin.del(`/api/billing/invoices/${invoiceId}`)).status).toBe(404);
  });

  it('refund returns stock-neutral money; cashier summary reflects collections by method', async () => {
    const cash = (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CASH' } })).id;
    const r = await admin.post(`/api/billing/invoices/${invoiceId}/refunds`, { amount: 3, methodId: cash, notes: 'إرجاع دواء' });
    expect(r.status).toBe(201);
    const s = await admin.get('/api/cashier/summary');
    expect(s.status).toBe(200);
    expect(s.body.collected).toBe(26);
    expect(s.body.refunded).toBe(3);
    expect(s.body.netReceipts).toBe(23);
    expect(s.body.byMethod.find((m: { code: string }) => m.code === 'CLIQ').collected).toBe(16);
    expect((await reception.get('/api/cashier/summary')).status).toBe(403);
  });

  it('a second template without a mandatory item shares the same serial', async () => {
    const tpl = await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false } });
    const svc = await prisma.service.findUniqueOrThrow({ where: { code: 'INJ-IM' } });
    const res = await reception.post('/api/billing/invoices', { patientId, templateId: tpl.id, items: [{ serviceId: svc.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    const first = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const n = (s: string) => Number(s.replace(/\D/g, ''));
    expect(n(res.body.invoiceNumber)).toBe(n(first.invoiceNumber!) + 1);
    // Unpaid invoice can be cancelled (void), never deleted
    const c = await admin.post(`/api/billing/invoices/${res.body.id}/cancel`, { reason: 'خطأ إدخال' });
    expect(c.body.status).toBe('CANCELLED');
  });

  it('every sensitive step is in the audit log, which cannot be modified', async () => {
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action);
    for (const a of ['patient.create', 'visit.create', 'visit.status', 'vitals.create', 'diagnosis.create', 'prescription.update', 'lab_result.enter', 'invoice.issue', 'payment.create', 'payment.refund', 'invoice.cancel', 'inventory.movement']) {
      expect(actions).toContain(a);
    }
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow();
    const res = await reception.get('/api/audit-logs');
    expect(res.status).toBe(403);
  });
});

describe('inventory is transaction-based', () => {
  it('item quantity cannot be edited directly; movements change it; negative stock refused', async () => {
    const created = await admin.post('/api/inventory/items', { name: 'كمامات', sku: 'MASK-1', openingQuantity: 10, minQuantity: 5 });
    expect(created.status).toBe(201);
    const id = created.body.id;
    await admin.put(`/api/inventory/items/${id}`, { quantity: 999 } as object);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantity.toNumber()).toBe(10);

    expect((await admin.post('/api/inventory/transactions', { itemId: id, type: 'CONSUMPTION', quantity: 6, reason: 'استهلاك يومي' })).status).toBe(201);
    const neg = await admin.post('/api/inventory/transactions', { itemId: id, type: 'ISSUE', quantity: 50, reason: 'صرف' });
    expect(neg.status).toBe(400);
    const txns = await prisma.inventoryTransaction.findMany({ where: { itemId: id }, orderBy: { createdAt: 'asc' } });
    expect(txns.map((t) => t.balanceAfter.toNumber())).toEqual([10, 4]);
    // dropped below minimum → low stock notification
    expect(await prisma.notification.count({ where: { type: 'LOW_STOCK', link: `/inventory/items/${id}` } })).toBeGreaterThan(0);
  });

  it('stock count only changes stock after approval', async () => {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { sku: 'MASK-1' } });
    const sc = await admin.post('/api/inventory/stock-counts', { title: 'جرد اختبار', itemIds: [item.id] });
    expect(sc.status).toBe(201);
    const detail = await admin.get(`/api/inventory/stock-counts/${sc.body.id}`);
    const row = detail.body.items[0];
    await admin.put(`/api/inventory/stock-counts/${sc.body.id}/items`, { items: [{ id: row.id, countedQuantity: 3 }] });
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity.toNumber()).toBe(4);
    expect((await admin.post(`/api/inventory/stock-counts/${sc.body.id}/approve`)).body.adjusted).toBe(1);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity.toNumber()).toBe(3);
  });

  it('receiving a purchase order adds stock and creates a supplier balance', async () => {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { sku: 'MASK-1' } });
    const supplier = await admin.post('/api/suppliers', { name: 'مورد اختبار' });
    const po = await admin.post('/api/purchases', { supplierId: supplier.body.id, items: [{ itemId: item.id, quantity: 20, unitCost: 0.5 }] });
    expect(po.status).toBe(201);
    await admin.post(`/api/purchases/${po.body.id}/status`, { status: 'RECEIVED' });
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity.toNumber()).toBe(23);
    const s = await admin.get(`/api/suppliers/${supplier.body.id}`);
    expect(s.body.balance).toBe(10);
    const cash = (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CASH' } })).id;
    await admin.post(`/api/suppliers/${supplier.body.id}/payments`, { amount: 4, methodId: cash });
    expect((await admin.get(`/api/suppliers/${supplier.body.id}`)).body.balance).toBe(6);
  });

  it('doctor cannot touch inventory unless the admin grants it per user', async () => {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { sku: 'MASK-1' } });
    const body = { itemId: item.id, type: 'CONSUMPTION', quantity: 1, reason: 'استخدام' };
    expect((await doctor.post('/api/inventory/transactions', body)).status).toBe(403);
    expect((await admin.put(`/api/users/${doctorId}/permissions`, { overrides: [{ permissionKey: 'inventory.transact', allow: true }] })).status).toBe(200);
    expect((await doctor.post('/api/inventory/transactions', body)).status).toBe(201);
    await admin.put(`/api/users/${doctorId}/permissions`, { overrides: [] });
    expect((await doctor.post('/api/inventory/transactions', body)).status).toBe(403);
  });
});

describe('appointments, staff, reports, search', () => {
  it('appointment conflicts are detected and check-in creates a queue visit', async () => {
    const p = await prisma.patient.findFirstOrThrow({ where: { fullName: 'فاطمة سليم' } });
    const start = new Date(Date.now() + 2 * 3600_000);
    const a = await reception.post('/api/appointments', { patientId: p.id, doctorId, startAt: start.toISOString(), durationMin: 30, reason: 'مراجعة ضغط' });
    expect(a.status).toBe(201);
    const clash = await reception.post('/api/appointments', { patientId: p.id, doctorId, startAt: new Date(start.getTime() + 10 * 60_000).toISOString() });
    expect(clash.status).toBe(409);
    expect((await reception.post(`/api/appointments/${a.body.id}/status`, { status: 'CONFIRMED' })).body.status).toBe('CONFIRMED');
    const v = await reception.post(`/api/appointments/${a.body.id}/check-in`);
    expect(v.status).toBe(201);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.body.id } })).status).toBe('ARRIVED');
  });

  it('scheduling + late check-in creates a LATE attendance and notifies managers', async () => {
    const shift = await prisma.shift.findFirstOrThrow({ where: { type: 'MORNING' } });
    const nurseUser = await prisma.user.findUniqueOrThrow({ where: { username: 'nurse.sara' } });
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const r = await admin.post('/api/staff/schedule/bulk', { userIds: [nurseUser.id], shiftId: shift.id, from: ymd, to: ymd, weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' });
    expect(r.body.created).toBe(1);
    const rec = await admin.post('/api/staff/attendance', { userId: nurseUser.id, date: ymd, checkIn: `${ymd}T02:00:00` });
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe('LATE');
    expect(rec.body.lateMinutes).toBe(120);
    const rep = await admin.get(`/api/reports/attendance?from=${ymd}&to=${ymd}`);
    expect(rep.body.rows.find((x: { userId: string }) => x.userId === nurseUser.id).late).toBe(1);
  });

  it('reports and dashboard are computed from live data', async () => {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dash = await admin.get('/api/dashboard/admin');
    expect(dash.status).toBe(200);
    expect(dash.body.visitsToday).toBeGreaterThanOrEqual(2);
    expect(dash.body.finance.collected).toBe(26);
    for (const r of ['patients', 'doctors', 'financial', 'inventory']) {
      const res = await admin.get(`/api/reports/${r}?from=${ymd}&to=${ymd}`);
      expect(res.status, r).toBe(200);
    }
    const doctors = await admin.get(`/api/reports/doctors?from=${ymd}&to=${ymd}`);
    expect(doctors.body.rows.find((x: { doctorId: string }) => x.doctorId === doctorId).revenue).toBe(26);
    expect((await doctor.get(`/api/reports/financial?from=${ymd}&to=${ymd}`)).status).toBe(403);
  });

  it('global search respects permissions', async () => {
    const a = await admin.get('/api/search?q=سامي');
    expect(a.body.patients.length).toBe(1);
    const n = await nurse.get('/api/search?q=INV');
    expect(n.body.invoices).toHaveLength(0);
  });

  it('background scanner is idempotent', async () => {
    const { runScan } = await import('../src/jobs/scanner');
    await runScan();
    const count = await prisma.notification.count();
    await runScan();
    expect(await prisma.notification.count()).toBe(count);
  });
});
