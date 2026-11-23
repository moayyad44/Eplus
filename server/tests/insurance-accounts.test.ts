import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { enqueue, ensureInsuranceAccounts, loadMapping, processPending } from '../src/modules/accounting/link';
import { login, type Client } from './helpers';

/**
 * «ذمم شركات التأمين» as a main account with one sub-account per insurance company: an existing sub-account carrying the
 * company's name is used, a missing one is created, and the company's operations post to its own account.
 */
let admin: Client;
const Y = new Date().getFullYear();
let saved: unknown;
let group: { id: string; code: string; name: string };
let preset: { id: string };

beforeAll(async () => {
  admin = await login('admin');
  saved = (await prisma.setting.findUnique({ where: { key: 'accounting' } }))?.value;
  const parent = await prisma.account.findUniqueOrThrow({ where: { systemKey: 'AR_INSURANCE' } });
  // The clinic's case: the insurance receivable became a main account (sub-accounts were added under it).
  group = await prisma.account.create({ data: { code: '1199', name: 'ذمم شركات التأمين (فرعية)', type: 'ASSET', nature: 'DEBIT', parentId: parent.parentId, isGroup: true } });
  preset = await prisma.account.create({ data: { code: '119901', name: 'ذمم شركة النسر للتأمين', type: 'ASSET', nature: 'DEBIT', parentId: group.id } });
  const cur = (saved ?? {}) as Record<string, unknown>;
  await prisma.setting.update({ where: { key: 'accounting' }, data: { value: { ...cur, startDate: cur.startDate ?? `${Y}-01-01`, accountMap: { ...(cur.accountMap as object ?? {}), AR_INSURANCE: group.id }, insuranceAccounts: {} } } });
});

afterAll(async () => {
  await prisma.setting.update({ where: { key: 'accounting' }, data: { value: saved as object } });
});

describe('one receivable account per insurance company', () => {
  let eagle: string, falcon: string;
  it('a new company uses the sub-account carrying its name, or gets a new one; running again changes nothing', async () => {
    eagle = (await admin.post('/api/insurance/companies', { nameAr: 'النسر للتأمين' })).body.id;
    falcon = (await admin.post('/api/insurance/companies', { nameAr: 'الصقر للتأمين' })).body.id;
    const map = ((await prisma.setting.findUniqueOrThrow({ where: { key: 'accounting' } })).value as { insuranceAccounts: Record<string, string> }).insuranceAccounts;
    expect(map[eagle]).toBe(preset.id);
    const created = await prisma.account.findUniqueOrThrow({ where: { id: map[falcon] } });
    expect([created.name, created.parentId, created.isGroup, /^1199\d{2}$/.test(created.code)]).toEqual(['الصقر للتأمين', group.id, false, true]);
    // every company (the demo ones too) has its own sub-account, numbered in sequence under the main account
    const companies = await prisma.insuranceCompany.count();
    expect(new Set(Object.values(map)).size).toBe(companies);
    const before = await prisma.account.count({ where: { parentId: group.id } });
    expect(await prisma.$transaction((tx) => ensureInsuranceAccounts(tx))).toBe(0);
    expect(await prisma.account.count({ where: { parentId: group.id } })).toBe(before);
    const m = await loadMapping();
    expect([m.insurer(eagle), m.insurer(falcon)]).toEqual([preset.id, created.id]);
  });

  it('the company\'s payment posts to its own account (the operation that failed before)', async () => {
    const method = await prisma.paymentMethod.findFirstOrThrow({ where: { code: 'CASH' } });
    const p = await prisma.insurancePayment.create({ data: { receiptNumber: `INSP-T-${Date.now()}`, companyId: falcon, amount: 75, methodId: method.id, paidAt: new Date(`${Y}-06-15T10:00:00`) } });
    await enqueue(prisma, 'ins-payment', p.id);
    await processPending(5000);
    const ev = await prisma.accountingEvent.findUniqueOrThrow({ where: { sourceKey: `ins-payment:${p.id}` } });
    expect([ev.status, ev.lastError]).toEqual(['DONE', null]);
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { sourceKey: `ins-payment:${p.id}` }, include: { lines: true } });
    const credit = e.lines.find((l) => Number(l.credit) > 0)!;
    expect([credit.accountId, Number(credit.credit), credit.partyId]).toEqual([(await loadMapping()).insurer(falcon), 75, falcon]);
  });

  it('the settings screen lists every company with its account; a group account cannot be chosen', async () => {
    const cfg = (await admin.get('/api/accounting/link/config')).body;
    expect(cfg.insurers.find((x: { id: string }) => x.id === eagle)).toMatchObject({ accountId: preset.id });
    const bad = await admin.put('/api/accounting/settings', { insuranceAccounts: { [eagle]: group.id } });
    expect(bad.status).toBe(400);
  });
});
