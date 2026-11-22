import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { processPending } from '../src/modules/accounting/link';
import { login, type Client } from './helpers';

/**
 * External lab: its cost is owed from the day the sample is sent (lab cost / payable to the lab), and paying it from the
 * expenses screen, with its category mapped to the lab's payable, settles what is owed instead of being a second expense.
 */
let admin: Client, doctor: Client, reception: Client;
const Y = new Date().getFullYear();
let saved: unknown;
const acc: Record<string, string> = {};
const linesOf = async (key: string) => (await prisma.journalEntry.findUnique({ where: { sourceKey: key }, include: { lines: true } }));
const net = (e: { status: string; lines: { accountId: string; debit: unknown; credit: unknown }[] } | null, id: string) =>
  e && e.status === 'POSTED' ? Number(e.lines.filter((l) => l.accountId === id).reduce((t, l) => t + Number(l.debit) - Number(l.credit), 0).toFixed(3)) : 0;

beforeAll(async () => {
  [admin, doctor, reception] = await Promise.all([login('admin'), login('dr.ahmad'), login('reception')]);
  saved = (await prisma.setting.findUniqueOrThrow({ where: { key: 'accounting' } })).value;
  const cur = saved as Record<string, unknown>;
  if (!cur.startDate) await prisma.setting.update({ where: { key: 'accounting' }, data: { value: { ...cur, startDate: `${Y}-01-01` } } });
  for (const a of await prisma.account.findMany({ where: { systemKey: { in: ['EXP_LAB_COST', 'AP_LAB', 'CASH_MAIN'] } } })) acc[a.systemKey!] = a.id;
});

afterAll(async () => {
  await prisma.setting.update({ where: { key: 'accounting' }, data: { value: saved as object } });
});

describe('external lab payable', () => {
  it('the chart has the lab cost and the lab payable accounts', () => {
    expect([acc.EXP_LAB_COST, acc.AP_LAB].every(Boolean)).toBe(true);
  });

  let orderId: string;
  it('nothing is owed while the sample is not sent; sent → lab cost / owed to the lab', async () => {
    const p = await reception.post('/api/patients', { fullName: 'مريض المختبر الخارجي', phone: '0791234567', gender: 'MALE' });
    const tests = await prisma.labTest.findMany({ where: { code: { in: ['L004', 'L011'] } } });
    const cost = tests.reduce((t, x) => t + Number(x.labCost), 0);
    const o = await doctor.post('/api/lab/orders', { patientId: p.body.id, testIds: tests.map((x) => x.id) });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    orderId = o.body.id;
    await processPending(5000);
    expect(await linesOf(`lab-order:${orderId}`)).toBeNull();
    expect((await admin.post(`/api/lab/orders/${orderId}/status`, { status: 'SAMPLE_COLLECTED' })).status).toBe(200);
    await processPending(5000);
    const e = await linesOf(`lab-order:${orderId}`);
    expect([net(e, acc.EXP_LAB_COST), net(e, acc.AP_LAB)]).toEqual([cost, -cost]);
    expect(e!.lines.find((l) => l.accountId === acc.AP_LAB)!.partyName).toBe('المختبر الخارجي');
  });

  it('a cancelled order owes nothing', async () => {
    expect((await admin.post(`/api/lab/orders/${orderId}/status`, { status: 'CANCELLED', reason: 'العينة لم تصل' })).status).toBe(200);
    await processPending(5000);
    expect((await linesOf(`lab-order:${orderId}`))!.status).toBe('DELETED');
  });

  it('paying the lab from the expenses screen settles the payable (its category mapped to the liability)', async () => {
    const cat = await prisma.expenseCategory.create({ data: { name: 'المختبر الخارجي' } });
    const s = await admin.put('/api/accounting/settings', { expenseAccounts: { [cat.id]: acc.AP_LAB } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const ex = await admin.post('/api/expenses', { categoryId: cat.id, amount: 40, expenseDate: `${Y}-06-10`, description: 'دفعة للمختبر الخارجي' });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    await processPending(5000);
    const e = await linesOf(`expense:${ex.body.id}`);
    expect([net(e, acc.AP_LAB), net(e, acc.CASH_MAIN)]).toEqual([40, -40]);
    expect(net(e, acc.EXP_LAB_COST)).toBe(0); // not a second expense
  });
});
