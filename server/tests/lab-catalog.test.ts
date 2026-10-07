import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, doctor: Client, reception: Client;
const day = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  [admin, doctor, reception] = await Promise.all([login('admin'), login('dr.ahmad'), login('reception')]);
});

describe('referral lab price list', () => {
  it('is imported once: lab price stored, patient price = (lab + 1) × 2', async () => {
    const cbc = await prisma.labTest.findUniqueOrThrow({ where: { code: 'L004' }, include: { service: true } });
    expect(cbc.name).toBe('CBC');
    expect(Number(cbc.labCost)).toBe(2);
    expect(Number(cbc.service!.price)).toBe(6);
    const fmf = await prisma.labTest.findFirstOrThrow({ where: { name: 'Familial Mediterranean Fever(FMF) PCR-22' }, include: { service: true } });
    expect(Number(fmf.service!.price)).toBe(132);
    const pkg = await prisma.labTest.findFirstOrThrow({ where: { name: 'باقة التوفير' }, include: { service: true } });
    expect(pkg.category).toBe('باقات');
    expect(Number(pkg.service!.price)).toBe(28);
    expect(await prisma.labTest.count({ where: { code: { startsWith: 'L' }, labCost: { not: null } } })).toBeGreaterThanOrEqual(150);
    expect(await prisma.counter.findUnique({ where: { key: 'import:lab-catalog-2026-10' } })).not.toBeNull();
  });

  it('an ordered test keeps the lab price of that day; the report shows what the lab will claim', async () => {
    const p = await reception.post('/api/patients', { fullName: 'مراجع المختبر', phone: '0791112233', gender: 'MALE' });
    const tests = await prisma.labTest.findMany({ where: { code: { in: ['L004', 'L011'] } } }); // CBC 2 + TSH 2.5
    const order = await doctor.post('/api/lab/orders', { patientId: p.body.id, testIds: tests.map((t) => t.id) });
    expect(order.status).toBe(201);
    // A later price change does not alter what is owed for this order.
    await prisma.labTest.update({ where: { code: 'L004' }, data: { labCost: 3 } });
    const r = await admin.get(`/api/reports/lab-costs?from=${day}&to=${day}`);
    expect(r.status).toBe(200);
    const row = r.body.orders.find((o: { id: string }) => o.id === order.body.id);
    expect(row.cost).toBe(4.5);
    expect(r.body.totals.owedToLab).toBeGreaterThanOrEqual(4.5);
    expect((await reception.get(`/api/reports/lab-costs?from=${day}&to=${day}`)).status).toBe(403);
    await prisma.labTest.update({ where: { code: 'L004' }, data: { labCost: 2 } });
  });

  it('a new price list updates lab prices, re-prices patients and adds missing tests', async () => {
    const res = await admin.post('/api/settings/lab-tests/import', {
      updatePatientPrice: true,
      rows: [{ name: 'cbc', labCost: 2.5 }, { name: 'New Test X', labCost: 4, category: 'كيمياء حيوية' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 1, updated: 1, repriced: 1 });
    const cbc = await prisma.labTest.findUniqueOrThrow({ where: { code: 'L004' }, include: { service: true } });
    expect(Number(cbc.labCost)).toBe(2.5);
    expect(Number(cbc.service!.price)).toBe(7);
    const x = await prisma.labTest.findFirstOrThrow({ where: { name: 'New Test X' }, include: { service: true } });
    expect(x.code).toMatch(/^L\d{3}$/);
    expect(Number(x.service!.price)).toBe(10);
    expect((await reception.post('/api/settings/lab-tests/import', { rows: [{ name: 'Y', labCost: 1 }] })).status).toBe(403);
  });
});
