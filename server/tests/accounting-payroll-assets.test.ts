import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, reception: Client;
const Y = new Date().getFullYear();
const OLD = Y - 3;
const acc: Record<string, string> = {};
let box: { id: string; accountId: string };
let emp: { id: string };
const n = (v: unknown) => Number(v);
const entryOf = (key: string) => prisma.journalEntry.findUnique({ where: { sourceKey: key }, include: { lines: true } });
const net = (e: { lines: { accountId: string; debit: unknown; credit: unknown }[] } | null, id: string) => Number((e?.lines ?? []).filter((l) => l.accountId === id).reduce((t, l) => t + n(l.debit) - n(l.credit), 0).toFixed(3));

beforeAll(async () => {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'receptionist' } });
  emp = await prisma.user.create({ data: { username: 'pay.emp', fullName: 'موظف الرواتب', passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id } });
  [admin, reception] = await Promise.all([login('admin'), login('reception')]);
  for (const a of await prisma.account.findMany({ where: { systemKey: { not: null } } })) acc[a.systemKey!] = a.id;
  box = (await admin.post('/api/accounting/treasuries', { kind: 'CASH', name: 'صندوق الرواتب' })).body;
});

describe('payroll', () => {
  it('advance → monthly run with absence and installment → approve entry → pay entry', async () => {
    const p = await admin.put(`/api/accounting/payroll/profiles/${emp.id}`, { jobTitle: 'موظف استقبال', basic: 600, allowances: [{ name: 'مواصلات', amount: 60 }], paymentMethod: 'CASH', treasuryId: box.id });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await reception.put(`/api/accounting/payroll/profiles/${emp.id}`, { basic: 1 })).status).toBe(403);
    const adv = await admin.post('/api/accounting/payroll/advances', { userId: emp.id, date: `${Y}-06-10`, amount: 300, installment: 100, treasuryId: box.id });
    expect(adv.status, JSON.stringify(adv.body)).toBe(201);
    const ae = await entryOf(`advance:${adv.body.id}`);
    expect([net(ae, acc.EMPLOYEE_ADVANCES), net(ae, box.accountId)]).toEqual([300, -300]);
    await prisma.attendance.create({ data: { userId: emp.id, date: new Date(`${Y}-07-08T00:00:00Z`), status: 'ABSENT' } });

    const run = await admin.post('/api/accounting/payroll/runs', { month: `${Y}-07` });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const slip = run.body.slips.find((s: { userId: string }) => s.userId === emp.id);
    expect([n(slip.absenceDays), n(slip.absenceDeduction), n(slip.advance), n(slip.net)]).toEqual([1, 20, 100, 540]);
    expect((await admin.post('/api/accounting/payroll/runs', { month: `${Y}-07` })).status).toBe(400);
    const ed = await admin.put(`/api/accounting/payroll/runs/${run.body.id}/slips/${slip.id}`, { bonus: 40 });
    expect(n(ed.body.slips.find((s: { id: string }) => s.id === slip.id).net)).toBe(580);
    expect((await admin.put(`/api/accounting/payroll/runs/${run.body.id}/slips/${slip.id}`, { advance: 500 })).status).toBe(400);

    expect((await admin.post(`/api/accounting/payroll/runs/${run.body.id}/approve`, {})).status).toBe(200);
    const pe = await entryOf(`payroll:${run.body.id}`);
    expect([net(pe, acc.SALARIES), net(pe, acc.SALARIES_PAYABLE), net(pe, acc.EMPLOYEE_ADVANCES)]).toEqual([680, -580, -100]);
    expect(n((await prisma.employeeAdvance.findUniqueOrThrow({ where: { id: adv.body.id } })).recovered)).toBe(100);
    expect((await admin.put(`/api/accounting/payroll/runs/${run.body.id}/slips/${slip.id}`, { bonus: 1 })).status).toBe(400);

    // reopening gives the advance back and removes the entry
    expect((await admin.post(`/api/accounting/payroll/runs/${run.body.id}/reopen`, {})).status).toBe(200);
    expect((await entryOf(`payroll:${run.body.id}`))!.status).toBe('DELETED');
    expect(n((await prisma.employeeAdvance.findUniqueOrThrow({ where: { id: adv.body.id } })).recovered)).toBe(0);
    await admin.post(`/api/accounting/payroll/runs/${run.body.id}/approve`, {});
    expect((await entryOf(`payroll:${run.body.id}`))!.status).toBe('POSTED');

    const pay = await admin.post(`/api/accounting/payroll/runs/${run.body.id}/pay`, { date: `${Y}-08-01`, treasuryId: box.id });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    const pp = await entryOf(`payroll-pay:${run.body.id}`);
    expect([net(pp, acc.SALARIES_PAYABLE), net(pp, box.accountId)]).toEqual([580, -580]);
  });
});

describe('fixed assets', () => {
  it('purchase → monthly depreciation (re-run is safe) → sale with a gain', async () => {
    const a = await admin.post('/api/accounting/assets', { name: 'جهاز تخطيط قلب', accountId: acc.FA_FURNITURE, purchaseDate: `${Y}-08-01`, cost: 1200, usefulLifeMonths: 12, fundingAccountId: box.accountId });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(net(await entryOf(`asset:${a.body.id}`), acc.FA_FURNITURE)).toBe(1200);
    expect((await admin.post('/api/accounting/assets', { name: 'خطأ', accountId: acc.FIXED_ASSETS_GROUP, purchaseDate: `${Y}-08-01`, cost: 10, usefulLifeMonths: 12, fundingAccountId: box.accountId })).status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const d = await admin.post('/api/accounting/assets/depreciation', { month: `${Y}-08` });
      expect([d.status, d.body.total]).toEqual([200, 100]);
    }
    const de = await entryOf(`depreciation:${Y}-08`);
    expect([net(de, acc.DEPRECIATION), net(de, acc.ACCUM_DEPRECIATION), de!.version]).toEqual([100, -100, 1]);
    expect((await admin.get(`/api/accounting/assets/${a.body.id}`)).body.bookValue).toBe(1100);
    expect((await admin.post(`/api/accounting/assets/${a.body.id}/dispose`, { date: `${Y}-09-15`, sold: true })).status).toBe(400);
    const s = await admin.post(`/api/accounting/assets/${a.body.id}/dispose`, { date: `${Y}-09-15`, sold: true, proceeds: 1150, proceedsAccountId: box.accountId });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const se = await entryOf(`asset-disposal:${a.body.id}`);
    expect([net(se, acc.ACCUM_DEPRECIATION), net(se, box.accountId), net(se, acc.FA_FURNITURE), net(se, acc.REV_OTHER)]).toEqual([100, 1150, -1200, -50]);
  });
});

describe('reports, dashboard, export and year closing', () => {
  it('aging, revenue, cash flow, dashboard and Excel export answer; reception is refused', async () => {
    for (const t of ['patients', 'insurance', 'suppliers']) expect((await admin.get(`/api/accounting/reports/aging?type=${t}`)).status).toBe(200);
    for (const by of ['doctor', 'category', 'method', 'day', 'month', 'payer']) expect((await admin.get(`/api/accounting/reports/revenue?by=${by}&from=${Y}-01-01`)).status, by).toBe(200);
    const d = await admin.get('/api/accounting/dashboard');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.balances).toHaveProperty('cash');
    const x = await admin.post('/api/accounting/export/xlsx', { title: 'تجربة', columns: [{ header: 'البند', key: 'a' }, { header: 'المبلغ', key: 'b', money: true }], rows: [{ a: 'x', b: 1.5 }], totals: ['b'] });
    expect([x.status, x.headers['content-type']]).toEqual([200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    expect((await reception.get('/api/accounting/dashboard')).status).toBe(403);
    expect((await reception.get('/api/accounting/reports/aging?type=patients')).status).toBe(403);
  });

  it('closing a year moves its result to retained earnings and locks it; reopening needs a reason and removes the entry', async () => {
    const fy = await admin.post('/api/accounting/fiscal-years', { name: `السنة ${OLD}`, startDate: `${OLD}-01-01`, endDate: `${OLD}-12-31` });
    expect(fy.status, JSON.stringify(fy.body)).toBe(201);
    const v = (body: object) => admin.post('/api/accounting/vouchers', { date: `${OLD}-05-01`, method: 'CASH', treasuryId: box.id, partyName: 'مراجع', purpose: 'اختبار', ...body });
    const v1 = await v({ kind: 'RECEIPT', amount: 500, counterAccountId: acc.REV_OTHER });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    expect((await v({ kind: 'PAYMENT', amount: 200, counterAccountId: acc.EXP_MAINTENANCE })).status).toBe(201);

    const cf = await admin.get(`/api/accounting/reports/cash-flow?from=${OLD}-01-01&to=${OLD}-12-31`);
    expect(cf.status).toBe(200);
    expect(cf.body.sections.find((s: { key: string }) => s.key === 'operating').net).toBe(300);

    const c = await admin.post(`/api/accounting/fiscal-years/${fy.body.id}/close`, {});
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const ce = await entryOf(`year-close:${fy.body.id}`);
    expect([ce!.type, net(ce, acc.REV_OTHER), net(ce, acc.EXP_MAINTENANCE), net(ce, acc.RETAINED_EARNINGS)]).toEqual(['CLOSING', 500, -200, -300]);
    expect((await v({ kind: 'RECEIPT', amount: 1, counterAccountId: acc.REV_OTHER })).status).toBe(400);
    const is = await admin.get(`/api/accounting/reports/income-statement?from=${OLD}-01-01&to=${OLD}-12-31`);
    expect(is.status).toBe(200);

    expect((await admin.post(`/api/accounting/fiscal-years/${fy.body.id}/reopen`, {})).status).toBe(400);
    expect((await admin.post(`/api/accounting/fiscal-years/${fy.body.id}/reopen`, { reason: 'تصحيح قيد' })).status).toBe(200);
    expect((await entryOf(`year-close:${fy.body.id}`))!.status).toBe('DELETED');
  });
});
