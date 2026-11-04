import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, cashier: Client, reception: Client;
const Y = new Date().getFullYear();
const D1 = `${Y}-03-10`;
const acc: Record<string, string> = {};
let box: { id: string; accountId: string }, bank: { id: string; accountId: string };
const H = { 'X-Requested-With': 'EmergencyPlus' };
const n = (v: unknown) => Number(v);
const entryOf = (key: string) => prisma.journalEntry.findUnique({ where: { sourceKey: key }, include: { lines: true } });
const net = (e: { lines: { accountId: string; debit: unknown; credit: unknown }[] } | null, id: string) => Number((e?.lines ?? []).filter((l) => l.accountId === id).reduce((t, l) => t + n(l.debit) - n(l.credit), 0).toFixed(3));
const bal = async (id: string) => n((await admin.get('/api/accounting/treasuries')).body.find((t: { id: string }) => t.id === id).balance);
const voucher = (body: object) => admin.post('/api/accounting/vouchers', { date: D1, partyName: 'أحمد', purpose: 'اختبار', ...body });

beforeAll(async () => {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'cashier' } });
  await prisma.user.create({ data: { username: 'acc.cashier', fullName: 'أمين الصندوق', passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id } });
  [admin, cashier, reception] = await Promise.all([login('admin'), login('acc.cashier'), login('reception')]);
  for (const a of await prisma.account.findMany({ where: { systemKey: { not: null } } })) acc[a.systemKey!] = a.id;
});

describe('cash boxes, banks and vouchers', () => {
  it('a new cash box and bank account each get their own ledger account', async () => {
    const b1 = await admin.post('/api/accounting/treasuries', { kind: 'CASH', name: 'صندوق الاستقبال' });
    const b2 = await admin.post('/api/accounting/treasuries', { kind: 'BANK', name: 'الحساب الجاري', bankName: 'البنك الأهلي', iban: 'JO00TEST', accountNumber: '123' });
    expect([b1.status, b2.status]).toEqual([201, 201]);
    box = b1.body; bank = b2.body;
    const [a1, a2] = await Promise.all([prisma.account.findUniqueOrThrow({ where: { id: box.accountId }, include: { parent: true } }), prisma.account.findUniqueOrThrow({ where: { id: bank.accountId }, include: { parent: true } })]);
    expect([a1.parent?.systemKey, a2.parent?.systemKey]).toEqual(['CASH_GROUP', 'BANK_GROUP']);
    expect((await reception.post('/api/accounting/treasuries', { kind: 'CASH', name: 'x' })).status).toBe(403);
  });

  it('a receipt voucher posts at once; editing updates its entry and keeps old/new; cancelling keeps the voucher', async () => {
    const r = await voucher({ kind: 'RECEIPT', method: 'CASH', treasuryId: box.id, amount: 250.5, counterAccountId: acc.REV_OTHER });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.number).toMatch(/^RV-\d{6}$/);
    expect(net(await entryOf(`voucher:${r.body.id}`), box.accountId)).toBe(250.5);
    const v = (await admin.get(`/api/accounting/vouchers/${r.body.id}`)).body;
    expect(v.amountWords).toBe('مائتان وخمسون ديناراً وخمسمائة فلس فقط لا غير');
    const ed = await admin.put(`/api/accounting/vouchers/${r.body.id}`, { kind: 'RECEIPT', date: D1, method: 'CASH', treasuryId: box.id, amount: 300, counterAccountId: acc.REV_OTHER, partyName: 'أحمد', purpose: 'اختبار' });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    const e = (await entryOf(`voucher:${r.body.id}`))!;
    expect([net(e, box.accountId), e.version]).toEqual([300, 2]);
    const revs = await prisma.docRevision.findMany({ where: { docType: 'voucher', docId: r.body.id } });
    expect(revs.map((x) => x.action)).toEqual(['create', 'update']);
    expect((await cashier.put(`/api/accounting/vouchers/${r.body.id}`, {})).status).toBe(403);
    expect((await admin.post(`/api/accounting/vouchers/${r.body.id}/cancel`, {})).status).toBe(200);
    expect((await entryOf(`voucher:${r.body.id}`))!.status).toBe('DELETED');
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('CANCELLED');
  });

  it('payment vouchers check the method against the treasury; the cashier can issue vouchers', async () => {
    expect((await voucher({ kind: 'PAYMENT', method: 'CASH', treasuryId: bank.id, amount: 10, counterAccountId: acc.EXP_RENT })).status).toBe(400);
    expect((await voucher({ kind: 'PAYMENT', method: 'VISA', amount: 10, counterAccountId: acc.EXP_RENT })).status).toBe(400);
    const r = await cashier.post('/api/accounting/vouchers', { kind: 'RECEIPT', date: D1, method: 'CASH', treasuryId: box.id, amount: 1000, counterAccountId: acc.CAPITAL, partyName: 'المالك', purpose: 'تمويل' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const p = await voucher({ kind: 'PAYMENT', method: 'TRANSFER', treasuryId: bank.id, amount: 40, counterAccountId: acc.EXP_TELECOM, partyName: 'شركة الاتصالات', purpose: 'فاتورة إنترنت' });
    expect(net(await entryOf(`voucher:${p.body.id}`), bank.accountId)).toBe(-40);
  });

  it('transfers move money between treasuries (fee to bank charges); cancelling reverses', async () => {
    const [b0, k0] = [await bal(box.id), await bal(bank.id)];
    const t = await admin.post('/api/accounting/transfers', { date: D1, fromId: box.id, toId: bank.id, amount: 500, fee: 1.5, reference: 'DEP-1' });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect([await bal(box.id), await bal(bank.id)]).toEqual([b0 - 501.5, k0 + 500]);
    expect((await admin.post(`/api/accounting/transfers/${t.body.id}/cancel`, {})).status).toBe(200);
    expect([await bal(box.id), await bal(bank.id)]).toEqual([b0, k0]);
  });

  it('cash count: a difference needs a reason and changes the books only after approval', async () => {
    const book = await bal(box.id);
    const notes = Math.floor(book / 10);
    const short = { '10': notes, '0.5': 0 };
    const counted = notes * 10;
    if (counted === book) short['0.5'] = 1;
    expect((await cashier.post('/api/accounting/cash-counts', { treasuryId: box.id, date: D1, denominations: short })).status).toBe(400);
    const c = await cashier.post('/api/accounting/cash-counts', { treasuryId: box.id, date: D1, denominations: short, reason: 'فرق كسور', isClose: true });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.status).toBe('PENDING');
    expect(await bal(box.id)).toBe(book);
    expect((await cashier.post(`/api/accounting/cash-counts/${c.body.id}/decide`, { approve: true })).status).toBe(403);
    expect((await admin.post(`/api/accounting/cash-counts/${c.body.id}/decide`, { approve: true })).status).toBe(200);
    expect(await bal(box.id)).toBe(n(c.body.counted));
  });
});

describe('Visa box', () => {
  const pays: string[] = [];
  it('card payments wait in Visa clearing, never in the bank', async () => {
    const p = await prisma.patient.findFirstOrThrow();
    const tpl = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false, items: { none: {} } } })).id;
    const svc = await prisma.service.findUniqueOrThrow({ where: { code: 'SRV-ECG' } });
    const visa = (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'VISA' } })).id;
    for (const ref of ['POS-111', 'POS-222', 'POS-333']) {
      const inv = await admin.post('/api/billing/invoices', { patientId: p.id, templateId: tpl, items: [{ serviceId: svc.id, quantity: 1 }], issue: true, invoiceDate: `${Y}-01-21` });
      const pay = await admin.post(`/api/billing/invoices/${inv.body.id}/payments`, { amount: n(svc.price), methodId: visa, reference: ref, paidAt: new Date(`${Y}-01-21T10:00:00`).toISOString() });
      expect(pay.status, JSON.stringify(pay.body)).toBe(201);
      pays.push(pay.body.payment.id);
    }
    const list = (await admin.get('/api/accounting/visa/transactions?status=PENDING,PARTIAL')).body;
    expect(list.items.filter((t: { posReference: string }) => ['POS-111', 'POS-222', 'POS-333'].includes(t.posReference))).toHaveLength(3);
    expect((await admin.get('/api/accounting/visa/summary')).body.notReachedCount).toBeGreaterThanOrEqual(3);
  });

  it('a settlement covers several payments (one partly), keeps the fee apart, and puts only the net in the bank', async () => {
    const txs = await prisma.visaTransaction.findMany({ where: { posReference: { in: ['POS-111', 'POS-222'] } }, orderBy: { posReference: 'asc' } });
    const [t1, t2] = txs;
    const k0 = await bal(bank.id);
    const over = await admin.post('/api/accounting/visa/settlements', { date: `${Y}-03-11`, treasuryId: bank.id, fee: 0.5, lines: [{ transactionId: t1.id, amount: n(t1.amount) + 1 }] });
    expect(over.status).toBe(400);
    const s = await admin.post('/api/accounting/visa/settlements', { date: `${Y}-03-11`, treasuryId: bank.id, fee: 0.5, reference: 'BATCH-77', lines: [{ transactionId: t1.id, amount: n(t1.amount) }, { transactionId: t2.id, amount: 5 }] });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const gross = n(t1.amount) + 5;
    expect(await bal(bank.id)).toBe(Number((k0 + gross - 0.5).toFixed(3)));
    const e = await entryOf(`visa-settlement:${s.body.id}`);
    expect([net(e, acc.VISA_FEES), net(e, acc.VISA_CLEARING)]).toEqual([0.5, -gross]);
    const [u1, u2] = await Promise.all([prisma.visaTransaction.findUniqueOrThrow({ where: { id: t1.id } }), prisma.visaTransaction.findUniqueOrThrow({ where: { id: t2.id } })]);
    expect([u1.status, u2.status, n(u2.settled)]).toEqual(['SETTLED', 'PARTIAL', 5]);
    expect((await admin.post(`/api/accounting/visa/settlements/${s.body.id}/cancel`, { reason: 'خطأ' })).status).toBe(200);
    expect((await prisma.visaTransaction.findUniqueOrThrow({ where: { id: t1.id } })).status).toBe('PENDING');
    expect(await bal(bank.id)).toBe(k0);
  });

  it('a statement file is matched by reference or amount/date and shows what is not in the system or missing', async () => {
    const csv = Buffer.from(`﻿التاريخ,المبلغ,رقم العملية\n${Y}-01-21,20,POS-111\n${Y}-01-21,999,XX-1\n`, 'utf8');
    const r = await admin.agent.post('/api/accounting/visa/match').set(H).attach('file', csv, 'statement.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = r.body.rows as { reference: string; status: string; match: string }[];
    expect(m.find((x) => x.reference === 'POS-111')!.match).toBe('REFERENCE');
    expect(m.find((x) => x.reference === 'XX-1')!.status).toBe('NOT_IN_SYSTEM');
    expect((r.body.missingFromStatement as { posReference: string }[]).some((x) => x.posReference === 'POS-333')).toBe(true);
  });

  it('a voided card payment leaves the Visa box', async () => {
    expect((await admin.post(`/api/billing/payments/${pays[2]}/void`, { reason: 'خطأ' })).status).toBe(200);
    expect((await prisma.visaTransaction.findFirstOrThrow({ where: { posReference: 'POS-333' } })).status).toBe('CANCELLED');
  });
});

describe('cheques', () => {
  let inA: string, inB: string, out: string, vA: string;
  it('an incoming cheque is registered with its receipt voucher and stays in the safe (not in the bank)', async () => {
    const k0 = await bal(bank.id);
    const r = await voucher({ kind: 'RECEIPT', method: 'CHEQUE', amount: 700, counterAccountId: acc.AR_INSURANCE, partyName: 'شركة التأمين', purpose: 'دفعة مطالبات', cheque: { number: '100200', bankName: 'بنك الإسكان', dueDate: `${Y}-03-20` } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    vA = r.body.id;
    expect(net(await entryOf(`voucher:${r.body.id}`), acc.CHEQUES_ON_HAND)).toBe(700);
    expect(await bal(bank.id)).toBe(k0);
    const ch = await prisma.cheque.findFirstOrThrow({ where: { number: '100200' } });
    expect(ch.status).toBe('RECEIVED');
    inA = ch.id;
    const dup = await voucher({ kind: 'RECEIPT', method: 'CHEQUE', amount: 5, counterAccountId: acc.AR_OTHER, cheque: { number: '100200', bankName: 'بنك الإسكان', dueDate: `${Y}-03-20` } });
    expect(dup.status).toBe(409);
    const r2 = await voucher({ kind: 'RECEIPT', method: 'CHEQUE', amount: 300, counterAccountId: acc.AR_OTHER, partyName: 'مراجع', cheque: { number: '555', bankName: 'البنك العربي', dueDate: `${Y}-03-15` } });
    inB = (await prisma.cheque.findFirstOrThrow({ where: { number: '555' } })).id;
    expect(r2.status).toBe(201);
  });

  it('deposit → under collection (still not in the bank) → collected (now in the bank); a bounce re-opens the receivable', async () => {
    const k0 = await bal(bank.id);
    const d = await admin.post('/api/accounting/cheques/deposits', { date: `${Y}-03-12`, treasuryId: bank.id, chequeIds: [inA, inB], slipNumber: 'SLIP-9' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(await bal(bank.id)).toBe(k0);
    expect((await admin.post(`/api/accounting/vouchers/${vA}/cancel`, {})).status).toBe(400); // the cheque has moved
    expect((await admin.post(`/api/accounting/cheques/${inA}/status`, { to: 'COLLECTED', date: `${Y}-03-14` })).status).toBe(200);
    expect(await bal(bank.id)).toBe(k0 + 700);
    expect((await admin.post(`/api/accounting/cheques/${inB}/status`, { to: 'BOUNCED', date: `${Y}-03-14`, fee: 3 })).status).toBe(400); // reason
    expect((await admin.post(`/api/accounting/cheques/${inB}/status`, { to: 'BOUNCED', date: `${Y}-03-14`, fee: 3, note: 'رصيد غير كافٍ' })).status).toBe(200);
    expect(await bal(bank.id)).toBe(k0 + 697);
    const c = (await admin.get(`/api/accounting/cheques/${inB}`)).body;
    expect(c.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['RECEIVED', 'UNDER_COLLECTION', 'BOUNCED']);
    expect(c.events.every((e: { user: string | null }) => e.user)).toBe(true);
    const tb = (await admin.get(`/api/accounting/reports/trial-balance?from=${Y}-01-01&to=${Y}-12-31`)).body;
    expect(tb.balanced).toBe(true);
  });

  it('an outgoing cheque is a liability until it is cashed; then it leaves the bank', async () => {
    const k0 = await bal(bank.id);
    const r = await voucher({ kind: 'PAYMENT', method: 'CHEQUE', treasuryId: bank.id, amount: 120, counterAccountId: acc.AP_SUPPLIERS, partyName: 'مورد', purpose: 'دفعة', cheque: { number: 'OUT-1', bankName: 'البنك الأهلي', dueDate: `${Y}-03-25` } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    out = (await prisma.cheque.findFirstOrThrow({ where: { number: 'OUT-1' } })).id;
    expect(await bal(bank.id)).toBe(k0);
    expect(net(await entryOf(`voucher:${r.body.id}`), acc.CHEQUES_ISSUED)).toBe(-120);
    expect((await admin.post(`/api/accounting/cheques/${out}/status`, { to: 'CLEARED', date: `${Y}-03-26` })).status).toBe(200);
    expect(await bal(bank.id)).toBe(k0 - 120);
  });

  it('cheque inventory: every expected cheque is checked; a missing one leaves the count pending approval', async () => {
    const r3 = await voucher({ kind: 'RECEIPT', method: 'CHEQUE', amount: 50, counterAccountId: acc.AR_OTHER, partyName: 'مراجع', cheque: { number: '777', bankName: 'بنك القاهرة', dueDate: `${Y}-04-01` } });
    expect(r3.status).toBe(201);
    const expected = (await admin.get('/api/accounting/cheque-counts/expected')).body as { id: string; number: string }[];
    expect(expected.map((c) => c.number)).toContain('777');
    expect((await admin.post('/api/accounting/cheque-counts', { date: `${Y}-04-02`, lines: [] })).status).toBe(400);
    const c = await admin.post('/api/accounting/cheque-counts', { date: `${Y}-04-02`, lines: expected.map((x) => ({ chequeId: x.id, result: x.number === '777' ? 'MISSING' : 'FOUND' })), extra: [{ number: '9999', amount: 10 }] });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.status).toBe('PENDING');
    expect((await admin.post(`/api/accounting/cheque-counts/${c.body.id}/approve`)).status).toBe(200);
  });
});
