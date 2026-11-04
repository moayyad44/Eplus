import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, accountant: Client, readonly: Client, doctor: Client;
const Y = new Date().getFullYear();
const d = (m: number, day = 15) => `${Y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const acc: Record<string, string> = {};
const tb = async (from: string, to: string) => (await admin.get(`/api/accounting/reports/trial-balance?from=${from}&to=${to}`)).body;
const entry = (lines: [string, number, number][], extra: object = {}) => ({
  date: d(3), description: 'قيد اختبار', lines: lines.map(([k, debit, credit]) => ({ accountId: acc[k], debit, credit })), ...extra,
});

beforeAll(async () => {
  for (const [username, roleKey] of [['acc.accountant', 'accountant'], ['acc.readonly', 'accounting_readonly']] as const) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.user.create({ data: { username, fullName: username, passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id } });
  }
  [admin, accountant, readonly, doctor] = await Promise.all([login('admin'), login('acc.accountant'), login('acc.readonly'), login('dr.ahmad')]);
  for (const a of await prisma.account.findMany({ where: { systemKey: { not: null } } })) acc[a.systemKey!] = a.id;
});

describe('accounting core', () => {
  it('starts with the Arabic chart of accounts (incl. Visa clearing) and an open fiscal year of 12 months', async () => {
    const r = await admin.get('/api/accounting/accounts');
    expect(r.status).toBe(200);
    expect(r.body.find((a: { systemKey: string }) => a.systemKey === 'VISA_CLEARING').name).toContain('الفيزا قيد التسوية');
    for (const k of ['CASH_MAIN', 'AR_PATIENTS', 'AR_INSURANCE', 'AP_SUPPLIERS', 'REV_LAB', 'ACCUM_DEPRECIATION', 'CHEQUES_ON_HAND', 'CHEQUES_UNDER_COLLECTION']) expect(acc[k], k).toBeTruthy();
    const years = (await admin.get('/api/accounting/fiscal-years')).body;
    expect(years[0].periods).toHaveLength(12);
    expect(years[0].status).toBe('OPEN');
  });

  it('only users with accounting permissions get in; each action needs its own permission', async () => {
    expect((await doctor.get('/api/accounting/accounts')).status).toBe(403);
    expect((await readonly.get('/api/accounting/journal')).status).toBe(200);
    expect((await readonly.post('/api/accounting/journal', entry([['CASH_MAIN', 10, 0], ['CAPITAL', 0, 10]]))).status).toBe(403);
    expect((await accountant.post('/api/accounting/accounts', { code: '9999', name: 'حساب', type: 'ASSET' })).status).toBe(403);
  });

  it('a balanced entry saved by an approver is posted at once and shows in the trial balance', async () => {
    const cash = async () => (await tb(d(1, 1), d(12, 31))).rows.find((x: { id: string }) => x.id === acc.CASH_MAIN)?.closing ?? 0;
    const before = await cash();
    const r = await admin.post('/api/accounting/journal', entry([['CASH_MAIN', 1000, 0], ['CAPITAL', 0, 1000]], { type: 'OPENING', description: 'رأس المال' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('POSTED');
    expect(r.body.number).toMatch(/^JV-\d{6}$/);
    const t = await tb(d(1, 1), d(12, 31));
    expect(t.balanced).toBe(true);
    expect(Number((await cash() - before).toFixed(3))).toBe(1000);
  });

  it('refuses unbalanced entries, one-sided or double-sided lines, and group accounts', async () => {
    const un = await admin.post('/api/accounting/journal', entry([['CASH_MAIN', 100, 0], ['CAPITAL', 0, 90]]));
    expect(un.status).toBe(400);
    expect(un.body.error.message).toContain('غير متوازن');
    expect((await admin.post('/api/accounting/journal', entry([['CASH_MAIN', 100, 100], ['CAPITAL', 0, 100]]))).status).toBe(400);
    expect((await admin.post('/api/accounting/journal', entry([['CASH_MAIN', 100, 0]]))).status).toBe(400);
    const group = await prisma.account.findFirstOrThrow({ where: { code: '1101' } });
    const g = await admin.post('/api/accounting/journal', { date: d(3), description: 'x', lines: [{ accountId: group.id, debit: 5 }, { accountId: acc.CAPITAL, credit: 5 }] });
    expect(g.status).toBe(400);
  });

  it('an entry by a user without the approve right waits (not in the books) until approved, then posts', async () => {
    const r = await accountant.post('/api/accounting/journal', entry([['EXP_RENT', 300, 0], ['CASH_MAIN', 0, 300]], { description: 'إيجار آذار', type: 'EXPENSE' }));
    expect(r.body.status).toBe('DRAFT');
    const rent = () => tb(d(3, 1), d(3, 31)).then((t) => t.rows.find((x: { id: string }) => x.id === acc.EXP_RENT)?.debit ?? 0);
    expect(await rent()).toBe(0);
    expect((await accountant.post(`/api/accounting/journal/${r.body.id}/approve`)).status).toBe(403);
    expect((await admin.post(`/api/accounting/journal/${r.body.id}/approve`)).status).toBe(200);
    expect(await rent()).toBe(300);
  });

  it('a posted entry can be edited by an authorised user (no reason asked); ledger follows; every version is kept', async () => {
    const r = await admin.post('/api/accounting/journal', entry([['EXP_UTILITIES', 50, 0], ['CASH_MAIN', 0, 50]], { description: 'كهرباء' }));
    expect((await accountant.put(`/api/accounting/journal/${r.body.id}`, entry([['EXP_UTILITIES', 70, 0], ['CASH_MAIN', 0, 70]], { description: 'كهرباء' }))).status).toBe(403);
    const ed = await admin.put(`/api/accounting/journal/${r.body.id}`, entry([['EXP_UTILITIES', 60, 0], ['EXP_TELECOM', 15, 0], ['CASH_MAIN', 0, 75]], { description: 'كهرباء وإنترنت', date: d(3, 20) }));
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    expect(ed.body.version).toBe(2);
    const st = (await admin.get(`/api/accounting/reports/statement?accountId=${acc.EXP_TELECOM}&from=${d(3, 1)}&to=${d(3, 31)}`)).body;
    expect(st.closing).toBe(15);
    const full = (await admin.get(`/api/accounting/journal/${r.body.id}`)).body;
    expect(full.revisions.map((x: { action: string }) => x.action)).toEqual(['create_posted', 'update']);
    expect(full.revisions[1].changes.map((c: { field: string }) => c.field)).toEqual(expect.arrayContaining(['date', 'description', 'lines']));
    expect(full.updatedBy).toBeTruthy();
    expect((await admin.put(`/api/accounting/journal/${r.body.id}`, entry([['EXP_UTILITIES', 60, 0], ['CASH_MAIN', 0, 50]]))).status).toBe(400); // must stay balanced
  });

  it('deleting a posted entry removes it from every report but keeps it and its history', async () => {
    const r = await admin.post('/api/accounting/journal', entry([['EXP_MARKETING', 40, 0], ['CASH_MAIN', 0, 40]], { description: 'إعلان' }));
    expect((await accountant.del(`/api/accounting/journal/${r.body.id}`)).status).toBe(403);
    expect((await admin.del(`/api/accounting/journal/${r.body.id}`)).status).toBe(200);
    const t = await tb(d(1, 1), d(12, 31));
    expect(t.rows.find((x: { id: string }) => x.id === acc.EXP_MARKETING)).toBeUndefined();
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.id }, include: { revisions: true } });
    expect(e.status).toBe('DELETED');
    expect(e.revisions.map((x) => x.action)).toContain('delete');
    await expect(prisma.journalEntry.delete({ where: { id: r.body.id } })).rejects.toThrow(); // never removed
  });

  it('a closed period takes no new entry or edit until reopened with a reason', async () => {
    const e = await admin.post('/api/accounting/journal', entry([['EXP_ADMIN', 20, 0], ['CASH_MAIN', 0, 20]], { date: d(2) }));
    const feb = (await admin.get('/api/accounting/fiscal-years')).body[0].periods[1];
    expect((await accountant.post(`/api/accounting/periods/${feb.id}/close`)).status).toBe(403);
    expect((await admin.post(`/api/accounting/periods/${feb.id}/close`)).status).toBe(200);
    expect((await admin.post('/api/accounting/journal', entry([['EXP_ADMIN', 5, 0], ['CASH_MAIN', 0, 5]], { date: d(2) }))).status).toBe(400);
    expect((await admin.put(`/api/accounting/journal/${e.body.id}`, entry([['EXP_ADMIN', 25, 0], ['CASH_MAIN', 0, 25]], { date: d(2) }))).status).toBe(400);
    expect((await admin.del(`/api/accounting/journal/${e.body.id}`)).status).toBe(400);
    // The database itself refuses too.
    await expect(prisma.journalEntry.update({ where: { id: e.body.id }, data: { description: 'تعديل مباشر' } })).rejects.toThrow();
    expect((await admin.post(`/api/accounting/periods/${feb.id}/reopen`, {})).status).toBe(400); // reason required
    expect((await admin.post(`/api/accounting/periods/${feb.id}/reopen`, { reason: 'تصحيح فاتورة كهرباء' })).status).toBe(200);
    expect((await admin.put(`/api/accounting/journal/${e.body.id}`, entry([['EXP_ADMIN', 25, 0], ['CASH_MAIN', 0, 25]], { date: d(2) }))).status).toBe(200);
  });

  it('the database refuses an unbalanced posted entry even if the API is bypassed', async () => {
    await expect(prisma.journalEntry.create({
      data: { number: 'JV-TEST-1', date: new Date(`${d(4)}T00:00:00Z`), description: 'مباشر', status: 'POSTED', totalDebit: 10, lines: { create: [{ lineNo: 1, accountId: acc.CASH_MAIN, debit: 10 }, { lineNo: 2, accountId: acc.CAPITAL, credit: 9 }] } },
    })).rejects.toThrow(/ACC_UNBALANCED/);
  });

  it('accounts: add sub-accounts, stop instead of delete when used, never delete system accounts', async () => {
    const parent = await prisma.account.findFirstOrThrow({ where: { code: '1102' } });
    const bank = await admin.post('/api/accounting/accounts', { code: '110201', name: 'البنك العربي', parentId: parent.id });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    expect([bank.body.type, bank.body.nature]).toEqual(['ASSET', 'DEBIT']);
    await admin.post('/api/accounting/journal', { date: d(3), description: 'إيداع', lines: [{ accountId: bank.body.id, debit: 200 }, { accountId: acc.CASH_MAIN, credit: 200 }] });
    expect((await admin.del(`/api/accounting/accounts/${bank.body.id}`)).status).toBe(400);
    expect((await admin.put(`/api/accounting/accounts/${bank.body.id}`, { isActive: false })).status).toBe(200);
    expect((await admin.post('/api/accounting/journal', { date: d(3), description: 'x', lines: [{ accountId: bank.body.id, debit: 1 }, { accountId: acc.CASH_MAIN, credit: 1 }] })).status).toBe(400); // stopped
    expect((await admin.del(`/api/accounting/accounts/${acc.REV_OTHER}`)).status).toBe(400);
    expect((await admin.put(`/api/accounting/accounts/${acc.VISA_CLEARING}`, { isActive: false })).status).toBe(400);
    expect((await admin.put(`/api/accounting/accounts/${acc.VISA_CLEARING}`, { name: 'Visa Clearing — البنك' })).status).toBe(200);
  });

  it('income statement and balance sheet agree with the books', async () => {
    const is = (await admin.get(`/api/accounting/reports/income-statement?from=${d(1, 1)}&to=${d(12, 31)}`)).body;
    expect(is.totalExpense).toBeGreaterThan(0);
    expect(is.netProfit).toBe(Number((is.totalRevenue - is.totalExpense).toFixed(3)));
    const bs = (await admin.get(`/api/accounting/reports/balance-sheet?asOf=${d(12, 31)}`)).body;
    expect(bs.balanced).toBe(true);
    expect(bs.currentProfit).toBe(is.netProfit);
  });

  it('fiscal years never overlap', async () => {
    expect((await admin.post('/api/accounting/fiscal-years', { name: 'متداخلة', startDate: d(6, 1), endDate: `${Y + 1}-05-31` })).status).toBe(400);
    const next = await admin.post('/api/accounting/fiscal-years', { name: `السنة المالية ${Y + 1}`, startDate: `${Y + 1}-01-01`, endDate: `${Y + 1}-12-31` });
    expect(next.status).toBe(201);
  });
});
