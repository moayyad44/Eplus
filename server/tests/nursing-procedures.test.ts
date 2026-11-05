import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, nurse: Client, reception: Client;
let visitId: string, inj: { id: string }, ecg: { id: string };

beforeAll(async () => {
  [admin, nurse, reception] = await Promise.all([login('admin'), login('nurse.sara'), login('reception')]);
  const p = (await reception.post('/api/patients', { fullName: 'مريض الإجراءات التمريضية', phone: '0798889900', gender: 'MALE' })).body;
  const doc = await prisma.user.findUniqueOrThrow({ where: { username: 'dr.ahmad' } });
  visitId = (await prisma.visit.create({ data: { visitNumber: `V-NP-${Date.now()}`, patientId: p.id, doctorId: doc.id, status: 'WITH_NURSE', queueDate: new Date(), arrivedAt: new Date() } })).id;
  ecg = await prisma.service.findFirstOrThrow({ where: { code: 'SRV-ECG' } });
  inj = await prisma.service.create({ data: { code: `SRV-INJ-${Date.now()}`, name: 'حقنة عضل', category: 'NURSING', price: 3 } });
});

describe('nursing procedures', () => {
  it('the list of quick procedures is editable, each one optionally linked to a service', async () => {
    const before = (await admin.get('/api/settings/public')).body.medical.nursingProcedures;
    expect(before.length).toBeGreaterThan(0);
    const list = [{ name: 'حقنة عضل', serviceId: inj.id }, { name: 'تخطيط قلب ECG', serviceId: ecg.id }, { name: 'قياس ضغط', serviceId: null }];
    expect((await admin.put('/api/settings/medical', { nursingProcedures: list })).status).toBe(200);
    expect((await admin.put('/api/settings/medical', { nursingProcedures: [{ name: 'خطأ', serviceId: '00000000-0000-4000-8000-000000000000' }] })).status).toBe(400);
    expect((await admin.put('/api/settings/medical', { nursingProcedures: [{ name: 'مكرر', serviceId: null }, { name: 'مكرر', serviceId: null }] })).status).toBe(400);
    expect((await nurse.put('/api/settings/medical', { nursingProcedures: [] })).status).toBe(403);
    expect((await nurse.get('/api/settings/public')).body.medical.nursingProcedures).toHaveLength(3);
  });

  it('several procedures are recorded with one press, and the linked ones reach the invoice with their count', async () => {
    const r = await nurse.post(`/api/visits/${visitId}/nursing-notes`, { procedures: [{ procedure: 'حقنة عضل' }, { procedure: 'حقنة عضل' }, { procedure: 'تخطيط قلب ECG' }, { procedure: 'قياس ضغط' }], notes: 'بعد الكشف' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toHaveLength(4);
    expect(r.body.map((n: { serviceId: string | null }) => n.serviceId)).toEqual([inj.id, inj.id, ecg.id, null]);
    // a single procedure typed by hand still works (and links when the name is in the list)
    const one = await nurse.post(`/api/visits/${visitId}/nursing-notes`, { procedure: 'غيار جرح', notes: null });
    expect([one.status, one.body.serviceId]).toEqual([201, null]);

    const s = (await admin.get(`/api/billing/invoices/suggest?visitId=${visitId}`)).body;
    expect(s.items).toEqual(expect.arrayContaining([{ serviceId: inj.id, quantity: 2 }, { serviceId: ecg.id, quantity: 1 }]));
    expect(s.items).toHaveLength(2);
    const v = (await nurse.get(`/api/visits/${visitId}`)).body;
    expect(v.nursingNotes.find((n: { procedure: string }) => n.procedure === 'تخطيط قلب ECG').service.name).toBe(ecg.name);
  });

  it('once billed, the procedures are not suggested again', async () => {
    const templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false } })).id;
    const s = (await admin.get(`/api/billing/invoices/suggest?visitId=${visitId}`)).body;
    const p = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect((await admin.post('/api/billing/invoices', { patientId: p.patientId, visitId, templateId, items: s.items })).status).toBe(201);
    expect((await admin.get(`/api/billing/invoices/suggest?visitId=${visitId}`)).body.items).toEqual([]);
  });
});
