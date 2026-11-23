import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

/**
 * The database server may run in local time (Docker TZ=Asia/Amman). The app's connections must work in UTC, or SQL
 * comparisons shift by the offset: an account statement counted the first day of its period in the opening balance too.
 */
let admin: Client;
const Y = new Date().getFullYear();

beforeAll(async () => { admin = await login('admin'); });

describe('time zone of the database connections', () => {
  it('every connection works in UTC, whatever the database server time zone', async () => {
    const rows = await Promise.all(Array.from({ length: 5 }, () => prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`));
    expect(new Set(rows.map((r) => r[0].tz))).toEqual(new Set(['UTC']));
  });

  it('an account statement opens with what came before its first day only', async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { systemKey: 'CASH_MAIN' } });
    const other = await prisma.account.findUniqueOrThrow({ where: { systemKey: 'EXP_OTHER' } });
    const day = (d: number) => `${Y}-03-${String(d).padStart(2, '0')}`;
    for (const [d, amount] of [[10, 100], [11, 30], [12, 7]] as const) {
      const r = await admin.post('/api/accounting/journal', { date: day(d), description: `حركة صندوق ${d}`, lines: [{ accountId: cash.id, debit: amount }, { accountId: other.id, credit: amount }] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const before = (await admin.get(`/api/accounting/reports/statement?accountId=${cash.id}&from=${Y}-01-01&to=${day(10)}`)).body.closing;
    const s = (await admin.get(`/api/accounting/reports/statement?accountId=${cash.id}&from=${day(11)}&to=${day(11)}`)).body;
    expect(s.opening).toBe(before);
    expect(s.rows.map((r: { debit: number }) => r.debit)).toEqual([30]);
    expect(s.closing).toBe(before + 30);
  });
});
