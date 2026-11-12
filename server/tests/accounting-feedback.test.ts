import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, reception: Client;
const Y = new Date().getFullYear();
const acc: Record<string, string> = {};
let bank: { id: string; accountId: string }, box: { id: string; accountId: string };
const n = (v: unknown) => Number(v);
const entryOf = (key: string) => prisma.journalEntry.findUnique({ where: { sourceKey: key }, include: { lines: true } });
const net = (e: { lines: { accountId: string; debit: unknown; credit: unknown }[] } | null, id: string) => Number((e?.lines ?? []).filter((l) => l.accountId === id).reduce((t, l) => t + n(l.debit) - n(l.credit), 0).toFixed(3));

beforeAll(async () => {
  [admin, reception] = await Promise.all([login('admin'), login('reception')]);
  for (const a of await prisma.account.findMany({ where: { systemKey: { not: null } } })) acc[a.systemKey!] = a.id;
  bank = (await admin.post('/api/accounting/treasuries', { kind: 'BANK', name: 'جاري الشيكات', bankName: 'بنك الاختبار' })).body;
  box = (await admin.post('/api/accounting/treasuries', { kind: 'CASH', name: 'صندوق الملاحظات' })).body;
});

describe('several cheques on one voucher', () => {
  const base = { kind: 'RECEIPT', method: 'CHEQUE', date: `${Y}-05-02`, partyName: 'شركة تأمين', purpose: 'دفعة مطالبات' };
  it('the voucher equals the sum of its cheques; each cheque is tracked on its own; cancelling cancels them all', async () => {
    const cheques = [
      { number: 'M-1', bankName: 'البنك العربي', dueDate: `${Y}-06-01`, amount: 300 },
      { number: 'M-2', bankName: 'البنك العربي', dueDate: `${Y}-07-01`, amount: 200.5 },
      { number: 'M-3', bankName: 'بنك الإسكان', dueDate: `${Y}-08-01`, amount: 99.5 },
    ];
    expect((await admin.post('/api/accounting/vouchers', { ...base, amount: 500, counterAccountId: acc.AR_INSURANCE, cheques })).status).toBe(400); // 600 ≠ 500
    expect((await admin.post('/api/accounting/vouchers', { ...base, amount: 600, counterAccountId: acc.AR_INSURANCE, cheques: [cheques[0], { ...cheques[0], amount: 300 }] })).status).toBe(400); // same cheque twice
    const r = await admin.post('/api/accounting/vouchers', { ...base, amount: 600, counterAccountId: acc.AR_INSURANCE, cheques });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const e = await entryOf(`voucher:${r.body.id}`);
    expect([net(e, acc.CHEQUES_ON_HAND), net(e, acc.AR_INSURANCE)]).toEqual([600, -600]);
    const v = await admin.get(`/api/accounting/vouchers/${r.body.id}`);
    expect(v.body.cheques.map((c: { number: string; amount: string }) => [c.number, n(c.amount)])).toEqual([['M-1', 300], ['M-2', 200.5], ['M-3', 99.5]]);
    const one = await prisma.cheque.findFirstOrThrow({ where: { number: 'M-2' } });
    expect((await admin.get(`/api/accounting/cheques/${one.id}`)).body.voucher.number).toBe(r.body.number);

    // collecting one cheque moves only its own amount
    const dep = await admin.post('/api/accounting/cheques/deposits', { date: `${Y}-06-02`, treasuryId: bank.id, chequeIds: [one.id] });
    expect(dep.status, JSON.stringify(dep.body)).toBe(201);
    expect((await admin.post(`/api/accounting/vouchers/${r.body.id}/cancel`, {})).status).toBe(400); // a cheque already moved

    const r2 = await admin.post('/api/accounting/vouchers', { ...base, amount: 50, counterAccountId: acc.AR_OTHER, cheques: [{ number: 'M-9', bankName: 'بنك الاتحاد', dueDate: `${Y}-06-01`, amount: 20 }, { number: 'M-10', bankName: 'بنك الاتحاد', dueDate: `${Y}-06-01`, amount: 30 }] });
    expect(r2.status).toBe(201);
    expect((await admin.post(`/api/accounting/vouchers/${r2.body.id}/cancel`, {})).status).toBe(200);
    expect((await prisma.cheque.findMany({ where: { voucherId: r2.body.id } })).map((c) => c.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('the older single-cheque form still works (whole amount)', async () => {
    const r = await admin.post('/api/accounting/vouchers', { ...base, amount: 75, counterAccountId: acc.AR_OTHER, cheque: { number: 'S-1', bankName: 'بنك الأردن', dueDate: `${Y}-06-10` } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(n((await prisma.cheque.findFirstOrThrow({ where: { number: 'S-1' } })).amount)).toBe(75);
  });

  it('an outgoing voucher with two cheques on the bank', async () => {
    const r = await admin.post('/api/accounting/vouchers', { kind: 'PAYMENT', method: 'CHEQUE', date: `${Y}-05-03`, treasuryId: bank.id, amount: 150, counterAccountId: acc.AP_SUPPLIERS, partyName: 'مورد', purpose: 'دفعات', cheques: [{ number: 'O-1', bankName: 'بنك الاختبار', dueDate: `${Y}-06-01`, amount: 100 }, { number: 'O-2', bankName: 'بنك الاختبار', dueDate: `${Y}-07-01`, amount: 50 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const cs = await prisma.cheque.findMany({ where: { voucherId: r.body.id }, orderBy: { number: 'asc' } });
    expect(cs.map((c) => [c.direction, c.status, n(c.amount), c.treasuryId])).toEqual([['OUT', 'ISSUED', 100, bank.id], ['OUT', 'ISSUED', 50, bank.id]]);
  });
});

describe('hourly employees', () => {
  it('salary = hours worked in the month × hourly rate; hours can be corrected', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'receptionist' } });
    const [h, m] = await Promise.all([
      prisma.user.create({ data: { username: 'hourly.nurse', fullName: 'ممرض بالساعة', passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id } }),
      prisma.user.create({ data: { username: 'monthly.clerk', fullName: 'موظف شهري', passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id } }),
    ]);
    expect((await admin.put(`/api/accounting/payroll/profiles/${h.id}`, { payType: 'HOURLY', hourlyRate: 0 })).status).toBe(400);
    const p = await admin.put(`/api/accounting/payroll/profiles/${h.id}`, { payType: 'HOURLY', hourlyRate: 3.5, basic: 999 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect([n(p.body.basic), n(p.body.hourlyRate)]).toEqual([0, 3.5]);
    await admin.put(`/api/accounting/payroll/profiles/${m.id}`, { basic: 450 });
    // 8h + 12h + 6.5h worked, and an absence (no deduction for an hourly employee)
    for (const [d, min, st] of [[3, 480, 'PRESENT'], [4, 720, 'PRESENT'], [5, 390, 'LATE'], [6, 0, 'ABSENT']] as const)
      await prisma.attendance.create({ data: { userId: h.id, date: new Date(`${Y}-02-0${d}T00:00:00Z`), status: st, workedMinutes: min } });
    const run = await admin.post('/api/accounting/payroll/runs', { month: `${Y}-02` });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const s = run.body.slips.find((x: { userId: string }) => x.userId === h.id);
    expect([s.payType, n(s.hours), n(s.hourlyRate), n(s.basic), n(s.absenceDeduction), n(s.net)]).toEqual(['HOURLY', 26.5, 3.5, 92.75, 0, 92.75]);
    const ms = run.body.slips.find((x: { userId: string }) => x.userId === m.id);
    expect([ms.payType, n(ms.basic)]).toEqual(['MONTHLY', 450]);
    const ed = await admin.put(`/api/accounting/payroll/runs/${run.body.id}/slips/${s.id}`, { hours: 30, bonus: 5 });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    const s2 = ed.body.slips.find((x: { id: string }) => x.id === s.id);
    expect([n(s2.hours), n(s2.basic), n(s2.net)]).toEqual([30, 105, 110]);
    expect((await admin.put(`/api/accounting/payroll/runs/${run.body.id}/slips/${ms.id}`, { hours: 10 })).status).toBe(400);
    expect((await admin.post(`/api/accounting/payroll/runs/${run.body.id}/approve`, {})).status).toBe(200);
    await prisma.salaryProfile.updateMany({ where: { userId: { in: [h.id, m.id] } }, data: { isActive: false } }); // out of other tests' months
  });
});

describe('moving an account', () => {
  it('under another main account, or under an unused sub-account (which becomes main); never under its own branch', async () => {
    const parent = await prisma.account.findUniqueOrThrow({ where: { systemKey: 'EXP_OTHER' } });
    const grp = (await prisma.account.findUniqueOrThrow({ where: { id: parent.parentId! } }));
    const a = (await admin.post('/api/accounting/accounts', { code: '99001', name: 'مصروف للنقل', parentId: grp.id })).body;
    const leaf = (await admin.post('/api/accounting/accounts', { code: '99002', name: 'أب جديد فارغ', parentId: grp.id })).body;
    const mv = await admin.put(`/api/accounting/accounts/${a.id}`, { parentId: leaf.id });
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: leaf.id } })).isGroup).toBe(true);
    expect((await admin.put(`/api/accounting/accounts/${leaf.id}`, { parentId: a.id })).status).toBe(400); // its own branch
    expect((await admin.put(`/api/accounting/accounts/${a.id}`, { parentId: acc.CASH_GROUP })).status).toBe(400); // another type
    expect((await admin.put(`/api/accounting/accounts/${a.id}`, { parentId: acc.EXP_OTHER })).status).toBe(400); // a system sub-account
    expect((await admin.put(`/api/accounting/accounts/${a.id}`, { parentId: grp.id })).status).toBe(200);
  });
});

describe('personal preferences', () => {
  it('each user keeps their own value', async () => {
    expect((await admin.get('/api/auth/prefs/acc-dashboard')).body.value).toBeNull();
    expect((await admin.put('/api/auth/prefs/acc-dashboard', { value: { hidden: ['byDoctor', 'inventory'] } })).status).toBe(200);
    expect((await admin.get('/api/auth/prefs/acc-dashboard')).body.value).toEqual({ hidden: ['byDoctor', 'inventory'] });
    expect((await reception.get('/api/auth/prefs/acc-dashboard')).body.value).toBeNull();
    expect((await admin.put('/api/auth/prefs/BAD KEY', { value: 1 })).status).toBe(400);
    await admin.put('/api/auth/prefs/acc-dashboard', { value: null });
    expect((await admin.get('/api/auth/prefs/acc-dashboard')).body.value).toBeNull();
  });
});

describe('clinic cash box: actual balances', () => {
  it('cash boxes and Visa from the books (same figures as the accounting treasuries)', async () => {
    await admin.post('/api/accounting/vouchers', { kind: 'RECEIPT', method: 'CASH', date: `${Y}-05-04`, treasuryId: box.id, amount: 40, counterAccountId: acc.REV_OTHER, partyName: 'مراجع', purpose: 'تقرير' });
    const r = await admin.get('/api/cashier/balances');
    expect(r.status).toBe(200);
    if (!r.body.started) { expect(r.body.cash).toEqual([]); return; }
    const ts = (await admin.get('/api/accounting/treasuries')).body as { accountId: string; balance: number }[];
    for (const c of r.body.cash) { const t = ts.find((x) => x.accountId === c.id); if (t) expect(c.balance).toBe(t.balance); }
    expect(r.body.cash.find((c: { id: string }) => c.id === box.accountId).balance).toBe(40);
    expect(r.body.cash.some((c: { id: string }) => c.id === acc.CASH_MAIN)).toBe(true); // where the clinic's cash goes
  });
});
