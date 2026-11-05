import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, nurse: Client, reception: Client;
let visitId: string, inj: { id: string }, ecg: { id: string; name: string }, cannula: { id: string }, fluid: { id: string };

beforeAll(async () => {
  [admin, nurse, reception] = await Promise.all([login('admin'), login('nurse.sara'), login('reception')]);
  const p = (await reception.post('/api/patients', { fullName: 'مريض الإجراءات التمريضية', phone: '0798889900', gender: 'MALE' })).body;
  const doc = await prisma.user.findUniqueOrThrow({ where: { username: 'dr.ahmad' } });
  visitId = (await prisma.visit.create({ data: { visitNumber: `V-NP-${Date.now()}`, patientId: p.id, doctorId: doc.id, status: 'WITH_NURSE', queueDate: new Date(), arrivedAt: new Date() } })).id;
  ecg = await prisma.service.findFirstOrThrow({ where: { code: 'SRV-ECG' } });
  inj = await prisma.service.create({ data: { code: `SRV-INJ-${Date.now()}`, name: 'حقنة عضل', category: 'NURSING', price: 3 } });
  cannula = await prisma.service.create({ data: { code: `SRV-CAN-${Date.now()}`, name: 'كانيولا', category: 'MEDICATION', price: 1.5 } });
  fluid = await prisma.service.create({ data: { code: `SRV-FLU-${Date.now()}`, name: 'محلول ملحي 500 مل', category: 'MEDICATION', price: 2 } });
});

describe('nursing procedures', () => {
  it('the list of quick procedures is editable; a procedure can bring several services with quantities', async () => {
    const before = (await admin.get('/api/settings/public')).body.medical.nursingProcedures;
    expect(before.length).toBeGreaterThan(0);
    // a list saved by the single-service version is still read (as one service each)
    expect((await admin.put('/api/settings/medical', { nursingProcedures: [{ name: 'حقنة عضل', serviceId: inj.id }] })).status).toBe(200);
    expect((await admin.get('/api/settings/public')).body.medical.nursingProcedures).toEqual([{ name: 'حقنة عضل', services: [{ serviceId: inj.id, quantity: 1 }] }]);
    const list = [
      { name: 'حقنة عضل', services: [{ serviceId: inj.id, quantity: 1 }] },
      { name: 'تركيب محلول وريدي', services: [{ serviceId: cannula.id, quantity: 1 }, { serviceId: fluid.id, quantity: 2 }] },
      { name: 'تخطيط قلب ECG', services: [{ serviceId: ecg.id }] },
      { name: 'قياس ضغط', services: [] },
    ];
    expect((await admin.put('/api/settings/medical', { nursingProcedures: list })).status).toBe(200);
    expect((await admin.put('/api/settings/medical', { nursingProcedures: [{ name: 'خطأ', services: [{ serviceId: '00000000-0000-4000-8000-000000000000' }] }] })).status).toBe(400);
    expect((await admin.put('/api/settings/medical', { nursingProcedures: [{ name: 'مكرر', services: [] }, { name: 'مكرر', services: [] }] })).status).toBe(400);
    expect((await nurse.put('/api/settings/medical', { nursingProcedures: [] })).status).toBe(403);
    const saved = (await nurse.get('/api/settings/public')).body.medical.nursingProcedures;
    expect(saved).toHaveLength(4);
    expect(saved[2].services).toEqual([{ serviceId: ecg.id, quantity: 1 }]);
  });

  it('several procedures are recorded with one press; all their services reach the invoice with summed quantities', async () => {
    const r = await nurse.post(`/api/visits/${visitId}/nursing-notes`, { procedures: [{ procedure: 'حقنة عضل' }, { procedure: 'حقنة عضل' }, { procedure: 'تركيب محلول وريدي' }, { procedure: 'تخطيط قلب ECG' }, { procedure: 'قياس ضغط' }], notes: 'بعد الكشف' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toHaveLength(5);
    expect(r.body.map((n: { services: unknown[] }) => n.services.length)).toEqual([1, 1, 2, 1, 0]);
    // a procedure typed by hand with services chosen for it
    const one = await nurse.post(`/api/visits/${visitId}/nursing-notes`, { procedure: 'غيار جرح كبير', services: [{ serviceId: fluid.id, quantity: 1 }], notes: null });
    expect([one.status, one.body.services.length]).toEqual([201, 1]);

    const s = (await admin.get(`/api/billing/invoices/suggest?visitId=${visitId}`)).body;
    expect(s.items).toEqual(expect.arrayContaining([{ serviceId: inj.id, quantity: 2 }, { serviceId: cannula.id, quantity: 1 }, { serviceId: fluid.id, quantity: 3 }, { serviceId: ecg.id, quantity: 1 }]));
    expect(s.items).toHaveLength(4);
    const v = (await nurse.get(`/api/visits/${visitId}`)).body;
    const iv = v.nursingNotes.find((n: { procedure: string }) => n.procedure === 'تركيب محلول وريدي');
    expect(iv.services.map((x: { service: { name: string }; quantity: string }) => [x.service.name, Number(x.quantity)])).toEqual(expect.arrayContaining([['كانيولا', 1], ['محلول ملحي 500 مل', 2]]));
  });

  it('once billed, the procedures are not suggested again', async () => {
    const templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false } })).id;
    const s = (await admin.get(`/api/billing/invoices/suggest?visitId=${visitId}`)).body;
    const p = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect((await admin.post('/api/billing/invoices', { patientId: p.patientId, visitId, templateId, items: s.items })).status).toBe(201);
    expect((await admin.get(`/api/billing/invoices/suggest?visitId=${visitId}`)).body.items).toEqual([]);
  });
});
