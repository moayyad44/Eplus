import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let doctor: Client, reception: Client;
beforeAll(async () => {
  [doctor, reception] = await Promise.all([login('dr.ahmad'), login('reception')]);
});

describe('medical report form', () => {
  it('stores the structured form and composes its text; free text still works', async () => {
    const p = await reception.post('/api/patients', { fullName: 'مراجع التقرير', phone: '0791112255', gender: 'FEMALE' });
    const dr = await prisma.user.findUniqueOrThrow({ where: { username: 'dr.ahmad' } });
    const v = await reception.post('/api/visits/direct', { patientId: p.body.id, doctorId: dr.id, payerType: 'SELF_PAY' });
    expect(v.status, JSON.stringify(v.body)).toBeLessThan(300);
    const fields = { complaint: 'abdominal pain', since: '2 days', given: 'Onda 8mg IV', advised: 'rest and fluids', diagnosis: '' };
    const r = await doctor.post(`/api/visits/${v.body.id}/reports`, { title: 'Medical Report', fields });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.fields).toEqual(fields);
    expect(r.body.content).toBe('Patient came to our emergency department complaining of abdominal pain\nSince 2 days\nAnd was given Onda 8mg IV\nAnd is advised to rest and fluids');
    const empty = await doctor.post(`/api/visits/${v.body.id}/reports`, { title: 'Medical Report', fields: { complaint: '' } });
    expect(empty.status).toBe(400);
    const free = await doctor.post(`/api/visits/${v.body.id}/reports`, { title: 'تقرير حر', content: 'نص التقرير الحر' });
    expect([free.status, free.body.fields]).toEqual([201, null]);
    const printed = await doctor.get(`/api/medical-reports/${r.body.id}`);
    expect(printed.body.fields.complaint).toBe('abdominal pain');
  });
});
