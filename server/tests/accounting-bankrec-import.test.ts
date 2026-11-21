import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, reception: Client;
const Y = new Date().getFullYear();
const H = { 'X-Requested-With': 'EmergencyPlus' };
const acc: Record<string, string> = {};
let bank: { id: string; accountId: string }, box: { id: string; accountId: string };
const csv = (lines: (string | number)[][]) => Buffer.from(lines.map((l) => l.join(',')).join('\n'), 'utf8');
const file = (c: Client, url: string, buf: Buffer, fields: Record<string, string> = {}) => { let r = c.agent.post(url).set(H); for (const [k, v] of Object.entries(fields)) r = r.field(k, v); return r.attach('file', buf, 'data.csv'); };

beforeAll(async () => {
  [admin, reception] = await Promise.all([login('admin'), login('reception')]);
  for (const a of await prisma.account.findMany({ where: { systemKey: { not: null } } })) acc[a.systemKey!] = a.id;
  bank = (await admin.post('/api/accounting/treasuries', { kind: 'BANK', name: 'بنك المطابقة', bankName: 'بنك الاختبار' })).body;
  box = (await admin.post('/api/accounting/treasuries', { kind: 'CASH', name: 'صندوق الاستيراد' })).body;
});

describe('bank reconciliation', () => {
  it('statement matching, a balanced reconciliation with a bank-charge adjustment, approval and cancellation', async () => {
    const v = (body: object) => admin.post('/api/accounting/vouchers', { method: 'TRANSFER', treasuryId: bank.id, partyName: 'اختبار', purpose: 'مطابقة', ...body });
    expect((await v({ kind: 'RECEIPT', date: `${Y}-10-02`, amount: 1000, counterAccountId: acc.CAPITAL })).status).toBe(201);
    expect((await v({ kind: 'PAYMENT', date: `${Y}-10-05`, amount: 200, counterAccountId: acc.EXP_MAINTENANCE })).status).toBe(201);
    expect((await v({ kind: 'PAYMENT', date: `${Y}-10-06`, amount: 50, counterAccountId: acc.EXP_MAINTENANCE })).status).toBe(201);

    const m = await file(admin, '/api/accounting/bank-recs/match', csv([['التاريخ', 'البيان', 'مدين', 'دائن'], [`${Y}-10-02`, 'إيداع', '', 1000], [`${Y}-10-05`, 'حوالة', 200, ''], [`${Y}-10-31`, 'عمولة', 5, '']]), { treasuryId: bank.id, date: `${Y}-10-31` });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.totals).toEqual({ lines: 3, matched: 2, notInBooks: 1 });
    expect(m.body.bookOnly.map((l: { amount: number }) => l.amount)).toEqual([-50]);
    const cleared = m.body.rows.filter((r: { lineId: string | null }) => r.lineId).map((r: { lineId: string }) => r.lineId);

    const body = { treasuryId: bank.id, statementDate: `${Y}-10-31`, clearedLineIds: cleared, adjustments: [{ date: `${Y}-10-31`, description: 'عمولة بنكية', amount: -5, accountId: acc.BANK_CHARGES }] };
    const bad = await admin.post('/api/accounting/bank-recs', { ...body, statementBalance: 800 });
    expect([bad.status, bad.body.summary.difference]).toEqual([201, 5]);
    expect((await admin.post(`/api/accounting/bank-recs/${bad.body.id}/approve`, {})).status).toBe(400);
    await admin.post(`/api/accounting/bank-recs/${bad.body.id}/cancel`, {});

    const r = await admin.post('/api/accounting/bank-recs', { ...body, statementBalance: 795 });
    expect(r.body.summary).toMatchObject({ book: 750, adjustments: -5, outstandingPayments: 50, expectedStatement: 795, difference: 0 });
    expect((await reception.post(`/api/accounting/bank-recs/${r.body.id}/approve`, {})).status).toBe(403);
    const ok = await admin.post(`/api/accounting/bank-recs/${r.body.id}/approve`, {});
    expect([ok.status, ok.body.status]).toEqual([200, 'APPROVED']);
    const adj = await prisma.journalEntry.findUniqueOrThrow({ where: { sourceKey: `bank-rec:${r.body.id}:0` }, include: { lines: true } });
    expect(adj.lines.find((l) => l.accountId === acc.BANK_CHARGES)?.debit.toNumber()).toBe(5);
    const book = (await admin.get(`/api/accounting/bank-recs/book?treasuryId=${bank.id}&date=${Y}-10-31`)).body;
    expect([book.book, book.lines.map((l: { amount: number }) => l.amount)]).toEqual([745, [-50]]);
    expect((await admin.post('/api/accounting/bank-recs', { ...body, statementBalance: 795 })).status).toBe(400); // lines already reconciled

    expect((await admin.post(`/api/accounting/bank-recs/${r.body.id}/cancel`, { reason: 'خطأ' })).status).toBe(200);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: adj.id } })).status).toBe('DELETED');
    expect(await prisma.journalLine.count({ where: { reconId: r.body.id } })).toBe(0);
  });
});

describe('Excel import', () => {
  it('lists types and gives templates; reception cannot import', async () => {
    const l = await admin.get('/api/accounting/imports');
    expect(l.body.map((t: { key: string }) => t.key)).toEqual(expect.arrayContaining(['accounts', 'journal', 'expenses', 'suppliers', 'assets', 'cheques-in', 'cheques-out', 'transfers']));
    const t = await admin.get('/api/accounting/imports/journal/template');
    expect([t.status, t.headers['content-type']]).toEqual([200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    expect((await file(reception, '/api/accounting/imports/journal/preview', csv([['x']]))).status).toBe(403);
  });

  it('journal: preview finds errors without saving; commit is all-or-nothing; importing twice adds nothing', async () => {
    const head = ['رقم القيد في الملف', 'التاريخ', 'البيان', 'رقم الحساب', 'مدين', 'دائن', 'بيان السطر'];
    const cap = (await prisma.account.findUniqueOrThrow({ where: { id: acc.CAPITAL } })).code, exp = (await prisma.account.findUniqueOrThrow({ where: { id: acc.EXP_MAINTENANCE } })).code;
    const bad = csv([head, ['J1', `${Y}-10-10`, 'قيد مستورد', exp, 100, '', ''], ['J1', `${Y}-10-10`, '', cap, '', 90, ''], ['J2', `${Y}-10-11`, 'آخر', '999999', 10, '', '']]);
    const p = await file(admin, '/api/accounting/imports/journal/preview', bad);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.summary.errors).toBe(2);
    expect((await file(admin, '/api/accounting/imports/journal/commit', bad)).status).toBe(400);
    expect(await prisma.journalEntry.count({ where: { sourceKey: { startsWith: 'import:journal:' } } })).toBe(0);

    const good = csv([head, ['J1', `${Y}-10-10`, 'قيد مستورد', exp, 100, '', 'صيانة'], ['J1', `${Y}-10-10`, '', cap, '', 100, ''], ['J2', `10/11/${Y}`, 'آخر', exp, 10, '', ''], ['J2', `10/11/${Y}`, '', cap, '', 10, '']]);
    const c = await file(admin, '/api/accounting/imports/journal/commit', good);
    expect([c.status, c.body.imported], JSON.stringify(c.body)).toEqual([200, 2]);
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { sourceKey: 'import:journal:J2' } });
    expect(e.date.toISOString().slice(0, 10)).toBe(`${Y}-11-10`);
    const again = await file(admin, '/api/accounting/imports/journal/commit', good);
    expect([again.body.imported, again.body.skipped]).toEqual([0, 4]);
  });

  it('accounts, suppliers, transfers and incoming cheques go through the same rules as the screens', async () => {
    const a = await file(admin, '/api/accounting/imports/accounts/commit', csv([['رقم الحساب', 'اسم الحساب', 'رقم الحساب الأب', 'النوع', 'حساب رئيسي'], ['5190', 'مصروفات مستوردة', '5', '', 'نعم'], ['519001', 'قرطاسية', '5190', '', '']]));
    expect([a.status, a.body.imported], JSON.stringify(a.body)).toEqual([200, 2]);
    expect((await prisma.account.findUniqueOrThrow({ where: { code: '519001' }, include: { parent: true } })).parent?.code).toBe('5190');

    const s = await file(admin, '/api/accounting/imports/suppliers/commit', csv([['اسم المورد', 'الهاتف'], ['مورد مستورد', '0790000000'], ['مورد مستورد', '']]));
    expect([s.body.imported, s.body.skipped]).toEqual([1, 1]);

    const t = await file(admin, '/api/accounting/imports/transfers/commit', csv([['التاريخ', 'من (اسم الصندوق/البنك)', 'إلى (اسم الصندوق/البنك)', 'المبلغ', 'العمولة', 'المرجع'], [`${Y}-10-12`, 'صندوق الاستيراد', 'بنك المطابقة', 30, '', 'TR-1']]));
    expect([t.status, t.body.imported], JSON.stringify(t.body)).toEqual([200, 1]);

    const ar = (await prisma.account.findUniqueOrThrow({ where: { id: acc.AR_OTHER } })).code;
    const ch = await file(admin, '/api/accounting/imports/cheques-in/commit', csv([['رقم الشيك', 'البنك', 'المبلغ', 'تاريخ الاستلام/الإصدار', 'تاريخ الاستحقاق', 'الساحب / الدافع', 'رقم الحساب المقابل', 'البيان'], ['777001', 'بنك الإسكان', 120, `${Y}-10-12`, `${Y}-12-01`, 'شركة س', ar, 'دفعة']]));
    expect([ch.status, ch.body.imported], JSON.stringify(ch.body)).toEqual([200, 1]);
    const cq = await prisma.cheque.findFirstOrThrow({ where: { number: '777001' } });
    expect([cq.direction, cq.amount.toNumber()]).toEqual(['IN', 120]);

    const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { isActive: true } });
    const ex = csv([['التاريخ', 'التصنيف', 'المبلغ', 'الوصف'], [`${Y}-10-13`, cat.name, 12.5, 'فاتورة كهرباء مستوردة']]);
    expect((await file(admin, '/api/accounting/imports/expenses/commit', ex)).body.imported).toBe(1);
    expect((await file(admin, '/api/accounting/imports/expenses/commit', ex)).body.skipped).toBe(1);
    const fa = (await prisma.account.findUniqueOrThrow({ where: { id: acc.FA_FURNITURE } })).code, capc = (await prisma.account.findUniqueOrThrow({ where: { id: acc.CAPITAL } })).code;
    const as = await file(admin, '/api/accounting/imports/assets/commit', csv([['اسم الأصل', 'رقم حساب الفئة', 'تاريخ الشراء', 'التكلفة', 'العمر بالأشهر', 'رقم الحساب الممول'], ['مكتب استقبال', fa, `${Y}-10-01`, 600, 60, capc]]));
    expect([as.status, as.body.imported], JSON.stringify(as.body)).toEqual([200, 1]);
  });
});
