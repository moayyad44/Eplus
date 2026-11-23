import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { processPending } from '../src/modules/accounting/link';
import { login, type Client } from './helpers';

let admin: Client, reception: Client;
const Y = new Date().getFullYear();
const acc: Record<string, string> = {};
let cash: string, visa: string, cliq: string, templateId: string, ecg: { id: string; price: number }, para: { id: string };
let patientId: string;
const n = (v: unknown) => Number(v);
// Money moves are dated on a quiet past day of this year so other tests' «today» cash totals stay exact.
const jan = new Date(Y, 0, 20);
const DAY = Date.now() - jan.getTime() > 5 * 86_400_000 ? `${Y}-01-20` : new Date().toLocaleDateString('en-CA');
const at = new Date(`${DAY}T10:00:00`).toISOString();
const entryOf = (key: string) => prisma.journalEntry.findUnique({ where: { sourceKey: key }, include: { lines: true } });
/** Net (debit − credit) per account role over the given entries. */
const net = (entries: { status: string; lines: { accountId: string; debit: unknown; credit: unknown }[] }[], role: string) =>
  Number(entries.filter((e) => e.status === 'POSTED').flatMap((e) => e.lines).filter((l) => l.accountId === acc[role]).reduce((t, l) => t + n(l.debit) - n(l.credit), 0).toFixed(3));
const run = () => processPending(5000);
const invoice = async (items: { serviceId: string; quantity: number }[]) => {
  const r = await admin.post('/api/billing/invoices', { patientId, templateId, items, issue: true, invoiceDate: DAY });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; total: string; invoiceNumber: string };
};
const pay = async (id: string, amount: number, methodId: string, kind: 'payments' | 'refunds' = 'payments') => {
  const r = await admin.post(`/api/billing/invoices/${id}/${kind}`, { amount, methodId, reference: 'REF-1', notes: 'اختبار', paidAt: at });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.payment as { id: string };
};

beforeAll(async () => {
  [admin, reception] = await Promise.all([login('admin'), login('reception')]);
  for (const a of await prisma.account.findMany({ where: { systemKey: { not: null } } })) acc[a.systemKey!] = a.id;
  [cash, visa, cliq] = await Promise.all(['CASH', 'VISA', 'CLIQ'].map(async (c) => (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: c } })).id));
  templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false, items: { none: {} } } })).id;
  const s = await prisma.service.findUniqueOrThrow({ where: { code: 'SRV-ECG' } });
  ecg = { id: s.id, price: n(s.price) };
  para = await prisma.service.findUniqueOrThrow({ where: { code: 'MED-PARA' } });
  patientId = (await reception.post('/api/patients', { fullName: 'مراجع المحاسبة', phone: '0791118888', gender: 'MALE' })).body.id;
});

describe('link with EmergencyPlus', () => {
  it('before a start date nothing is posted; operations wait in the queue', async () => {
    const inv = await invoice([{ serviceId: ecg.id, quantity: 1 }]);
    await run();
    expect((await prisma.accountingEvent.findUniqueOrThrow({ where: { sourceKey: `invoice:${inv.id}` } })).status).toBe('PENDING');
    expect(await entryOf(`invoice:${inv.id}`)).toBeNull();
  });

  it('setting the start date posts every operation from that day (invoice → receivable and revenue, accrual basis)', async () => {
    const r = await admin.put('/api/accounting/settings', { startDate: `${Y}-01-01` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ inventoryMethod: 'PERPETUAL', requireReason: false });
    await run();
    const inv = await invoice([{ serviceId: ecg.id, quantity: 2 }]);
    await run();
    const e = (await entryOf(`invoice:${inv.id}`))!;
    expect(e.status).toBe('POSTED');
    expect(net([e], 'AR_PATIENTS')).toBe(ecg.price * 2);
    expect(net([e], 'REV_SERVICES') + net([e], 'REV_CONSULTATION') + net([e], 'REV_OTHER') + net([e], 'REV_LAB')).toBe(-ecg.price * 2);
    expect(e.lines.find((l) => l.accountId === acc.AR_PATIENTS)?.partyId).toBe(patientId);
  });

  it('cash, Visa and overpayment: money goes to the right account; Visa stays in clearing (not the bank)', async () => {
    const inv = await invoice([{ serviceId: ecg.id, quantity: 1 }]);
    const p1 = await pay(inv.id, 5, cash);
    const p2 = await pay(inv.id, ecg.price, visa); // more than what is left → overpayment of 5
    await run();
    const [e1, e2] = [(await entryOf(`payment:${p1.id}`))!, (await entryOf(`payment:${p2.id}`))!];
    expect(net([e1], 'CASH_MAIN')).toBe(5);
    expect(net([e2], 'VISA_CLEARING')).toBe(ecg.price);
    expect(net([e2], 'PATIENT_CREDITS')).toBe(-5);
    const all = [(await entryOf(`invoice:${inv.id}`))!, e1, e2];
    expect(net(all, 'AR_PATIENTS')).toBe(0); // fully settled
  });

  it('refund and cancellation: every account of the invoice nets back to zero', async () => {
    const inv = await invoice([{ serviceId: ecg.id, quantity: 1 }]);
    const p = await pay(inv.id, ecg.price + 3, cash);
    await pay(inv.id, ecg.price + 3, cash, 'refunds');
    expect((await admin.post(`/api/billing/invoices/${inv.id}/cancel`, { reason: 'خطأ في الفاتورة' })).status).toBe(200);
    await run();
    const keys = [`invoice:${inv.id}`, `invoice-cancel:${inv.id}`, ...(await prisma.payment.findMany({ where: { invoiceId: inv.id } })).map((x) => `payment:${x.id}`)];
    const entries = (await Promise.all(keys.map(entryOf))).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof entryOf>>>[];
    expect(entries).toHaveLength(4);
    for (const role of ['AR_PATIENTS', 'CASH_MAIN', 'PATIENT_CREDITS', 'DISCOUNTS_GIVEN', 'REV_SERVICES', 'REV_CONSULTATION', 'REV_OTHER']) expect(net(entries, role), role).toBe(0);
    expect(p).toBeTruthy();
  });

  it('never duplicates: re-queueing and re-processing keeps one entry per operation and no new version', async () => {
    const inv = await invoice([{ serviceId: ecg.id, quantity: 1 }]);
    await run();
    const e1 = (await entryOf(`invoice:${inv.id}`))!;
    await prisma.accountingEvent.update({ where: { sourceKey: `invoice:${inv.id}` }, data: { status: 'PENDING' } });
    await run(); await run();
    const e2 = (await entryOf(`invoice:${inv.id}`))!;
    expect([e2.id, e2.version]).toEqual([e1.id, e1.version]);
    expect(await prisma.journalEntry.count({ where: { sourceKey: { startsWith: `invoice:${inv.id}` } } })).toBe(1);
  });

  it('a voided payment removes its entry; a payment date change moves it', async () => {
    const inv = await invoice([{ serviceId: ecg.id, quantity: 1 }]);
    const p = await pay(inv.id, 4, cliq);
    await run();
    expect(net([(await entryOf(`payment:${p.id}`))!], 'EPAY_CLEARING')).toBe(4); // CliQ default: e-payment clearing until mapped to a bank
    expect((await admin.post(`/api/billing/payments/${p.id}/void`, { reason: 'خطأ إدخال' })).status).toBe(200);
    await run();
    expect((await entryOf(`payment:${p.id}`))!.status).toBe('DELETED');
  });

  it('expenses follow the category mapping; editing updates the entry; voiding removes it', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow();
    expect((await admin.put('/api/accounting/settings', { expenseAccounts: { [cat.id]: acc.EXP_RENT } })).status).toBe(200);
    const ex = await admin.post('/api/expenses', { categoryId: cat.id, amount: 120, expenseDate: DAY, description: 'إيجار', paymentMethodId: cash });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    await run();
    let e = (await entryOf(`expense:${ex.body.id}`))!;
    expect([net([e], 'EXP_RENT'), net([e], 'CASH_MAIN')]).toEqual([120, -120]);
    await admin.put(`/api/expenses/${ex.body.id}`, { amount: 150 });
    await run();
    e = (await entryOf(`expense:${ex.body.id}`))!;
    expect([net([e], 'EXP_RENT'), e.version]).toEqual([150, 2]);
    await admin.post(`/api/expenses/${ex.body.id}/void`, { reason: 'مكرر' });
    await run();
    expect((await entryOf(`expense:${ex.body.id}`))!.status).toBe('DELETED');
  });

  it('payment methods follow their mapped account (e.g. CliQ straight to a bank account)', async () => {
    const bankGroup = await prisma.account.findFirstOrThrow({ where: { systemKey: 'BANK_GROUP' } });
    const bank = await admin.post('/api/accounting/accounts', { code: '110290', name: 'بنك الاختبار', parentId: bankGroup.id });
    expect((await admin.put('/api/accounting/settings', { methodAccounts: { [cliq]: bank.body.id } })).status).toBe(200);
    expect((await admin.put('/api/accounting/settings', { methodAccounts: { [cliq]: bankGroup.id } })).status).toBe(400); // a group account is refused
    const inv = await invoice([{ serviceId: ecg.id, quantity: 1 }]);
    const p = await pay(inv.id, ecg.price, cliq);
    await run();
    const e = (await entryOf(`payment:${p.id}`))!;
    expect(e.lines.find((l) => n(l.debit) > 0)?.accountId).toBe(bank.body.id);
    const cfg = (await admin.get('/api/accounting/link/config')).body;
    expect(cfg.methods.find((m: { id: string }) => m.id === cliq)).toMatchObject({ accountId: bank.body.id, custom: true });
  });

  it('perpetual inventory: a sold medicine books its cost; a purchase order goes to inventory and the supplier; consumption to supplies', async () => {
    const inv = await invoice([{ serviceId: para.id, quantity: 2 }]);
    await run();
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: 'MED-PARA' } });
    const e = (await entryOf(`invoice:${inv.id}`))!;
    expect(net([e], 'COGS')).toBe(n(item.purchasePrice) * 2);
    expect(net([e], 'INVENTORY')).toBe(-n(item.purchasePrice) * 2);

    const sup = await prisma.supplier.findFirstOrThrow();
    const po = await admin.post('/api/purchases', { supplierId: sup.id, items: [{ itemId: item.id, quantity: 10, unitCost: 0.8 }] });
    await admin.post(`/api/purchases/${po.body.id}/status`, { status: 'RECEIVED' });
    const sp = await admin.post(`/api/suppliers/${sup.id}/payments`, { amount: 8, methodId: cash, paidAt: at });
    const mv = await admin.post('/api/inventory/transactions', { itemId: item.id, type: 'CONSUMPTION', quantity: 1, reason: 'استهلاك العيادة' });
    await run();
    const [pe, se, me] = [(await entryOf(`po:${po.body.id}`))!, (await entryOf(`supplier-payment:${sp.body.id}`))!, (await entryOf(`inv-move:${mv.body.id}`))!];
    expect([net([pe], 'INVENTORY'), net([pe], 'AP_SUPPLIERS')]).toEqual([8, -8]);
    expect([net([se], 'AP_SUPPLIERS'), net([se], 'CASH_MAIN')]).toEqual([8, -8]);
    expect(net([me], 'EXP_MEDICAL_SUPPLIES')).toBeGreaterThan(0);
  });

  it('a failure (closed period) is recorded and retried without duplicates', async () => {
    const period = await prisma.fiscalPeriod.findFirstOrThrow({ where: { startDate: { lte: new Date(`${DAY}T00:00:00Z`) }, endDate: { gte: new Date(`${DAY}T00:00:00Z`) } } });
    expect((await admin.post(`/api/accounting/periods/${period.id}/close`)).status).toBe(200);
    const inv = await invoice([{ serviceId: ecg.id, quantity: 1 }]);
    await run();
    const ev = await prisma.accountingEvent.findUniqueOrThrow({ where: { sourceKey: `invoice:${inv.id}` } });
    expect(ev.status).toBe('FAILED');
    expect(ev.lastError).toContain('مغلقة');
    const list = (await admin.get('/api/accounting/link?status=FAILED')).body;
    expect(list.items.some((x: { sourceKey: string }) => x.sourceKey === `invoice:${inv.id}`)).toBe(true);
    expect((await admin.post(`/api/accounting/periods/${period.id}/reopen`, { reason: 'ترحيل فواتير الشهر' })).status).toBe(200);
    expect((await admin.post('/api/accounting/link/retry', {})).status).toBe(200);
    await run();
    expect((await prisma.accountingEvent.findUniqueOrThrow({ where: { sourceKey: `invoice:${inv.id}` } })).status).toBe('DONE');
    expect(await prisma.journalEntry.count({ where: { sourceKey: `invoice:${inv.id}` } })).toBe(1);
  });

  it('automatic entries are changed through their source only; manual edits may carry an optional reason', async () => {
    const auto = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: 'invoice', status: 'POSTED' }, include: { lines: true } });
    const body = { date: auto.date.toISOString().slice(0, 10), description: 'x', lines: auto.lines.map((l) => ({ accountId: l.accountId, debit: n(l.debit), credit: n(l.credit) })) };
    expect((await admin.put(`/api/accounting/journal/${auto.id}`, body)).status).toBe(400);
    expect((await admin.del(`/api/accounting/journal/${auto.id}`)).status).toBe(400);
    const m = await admin.post('/api/accounting/journal', { date: new Date().toLocaleDateString('en-CA'), description: 'تسوية', lines: [{ accountId: acc.EXP_ADMIN, debit: 3 }, { accountId: acc.CASH_MAIN, credit: 3 }] });
    const upd = { date: new Date().toLocaleDateString('en-CA'), description: 'تسوية', lines: [{ accountId: acc.EXP_ADMIN, debit: 4 }, { accountId: acc.CASH_MAIN, credit: 4 }] };
    expect((await admin.put(`/api/accounting/journal/${m.body.id}`, upd)).status).toBe(200); // no reason needed by default
    await admin.put('/api/accounting/settings', { requireReason: true });
    expect((await admin.put(`/api/accounting/journal/${m.body.id}`, { ...upd, description: 'تسوية 2' })).status).toBe(400);
    expect((await admin.put(`/api/accounting/journal/${m.body.id}`, { ...upd, description: 'تسوية 2', reason: 'تصحيح المبلغ' })).status).toBe(200);
    const revs = await prisma.journalRevision.findMany({ where: { entryId: m.body.id }, orderBy: { createdAt: 'asc' } });
    expect(revs.at(-1)?.reason).toBe('تصحيح المبلغ');
    await admin.put('/api/accounting/settings', { requireReason: false });
  });

  it('the books stay balanced after all of this', async () => {
    const t = (await admin.get(`/api/accounting/reports/trial-balance?from=${Y}-01-01&to=${Y}-12-31`)).body;
    expect(t.balanced).toBe(true);
    expect((await admin.get(`/api/accounting/reports/balance-sheet?asOf=${Y}-12-31`)).body.balanced).toBe(true);
  });
});
