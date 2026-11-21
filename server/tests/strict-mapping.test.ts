import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { enqueue, loadMapping, processPending } from '../src/modules/accounting/link';
import { login, type Client } from './helpers';

/** A payment method added later has no silent default: its operations wait («متعثرة») until it is mapped, then post. */
let admin: Client;
const Y = new Date().getFullYear();

beforeAll(async () => {
  admin = await login('admin');
  const cur = (await prisma.setting.findUniqueOrThrow({ where: { key: 'accounting' } })).value as Record<string, unknown>;
  if (!cur.startDate) await prisma.setting.update({ where: { key: 'accounting' }, data: { value: { ...cur, startDate: `${Y}-01-01` } } });
});

describe('strict mapping of payment methods and expense categories', () => {
  it('the methods and categories that existed keep their account (pinned once)', async () => {
    const m = await loadMapping();
    const cash = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CASH' } });
    const cashMain = await prisma.account.findUniqueOrThrow({ where: { systemKey: 'CASH_MAIN' } });
    expect(m.method(cash.id)).toBe((m.cfg.methodAccounts[cash.id]));
    expect(m.cfg.mappingPinned).toBe(true);
    expect([cashMain.id, (await loadMapping()).cfg.methodAccounts[cash.id]].length).toBe(2);
    // the starting categories (a category added later by another test is rightly «not mapped»)
    for (const c of await prisma.expenseCategory.findMany({ where: { name: { in: ['إيجار', 'كهرباء', 'مصروفات أخرى'] } } })) expect(() => m.expense(c.id)).not.toThrow();
  });

  it('a new method waits with a clear reason; mapping it posts the operation to the chosen account', async () => {
    const zain = await prisma.paymentMethod.create({ data: { code: `ZAIN-${Date.now()}`, name: 'زين كاش', requiresReference: false } });
    const company = await prisma.insuranceCompany.findFirstOrThrow();
    const p = await prisma.insurancePayment.create({ data: { receiptNumber: `INSP-Z-${Date.now()}`, companyId: company.id, amount: 30, methodId: zain.id, paidAt: new Date(`${Y}-07-01T10:00:00`) } });
    await enqueue(prisma, 'ins-payment', p.id);
    await processPending(5000);
    let ev = await prisma.accountingEvent.findUniqueOrThrow({ where: { sourceKey: `ins-payment:${p.id}` } });
    expect([ev.status, ev.lastError]).toEqual(['FAILED', expect.stringContaining('«زين كاش» غير مربوطة بحساب')]);
    const cfg = (await admin.get('/api/accounting/link/config')).body;
    expect(cfg.methods.find((x: { id: string }) => x.id === zain.id).accountId).toBeNull();

    const target = await prisma.account.findUniqueOrThrow({ where: { systemKey: 'EPAY_CLEARING' } });
    const s = await admin.put('/api/accounting/settings', { methodAccounts: { ...(await loadMapping()).cfg.methodAccounts, [zain.id]: target.id } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    ev = await prisma.accountingEvent.findUniqueOrThrow({ where: { sourceKey: `ins-payment:${p.id}` } });
    expect(ev.status).toBe('DONE');
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { sourceKey: `ins-payment:${p.id}` }, include: { lines: true } });
    expect(e.lines.find((l) => Number(l.debit) > 0)!.accountId).toBe(target.id);
  });
});
