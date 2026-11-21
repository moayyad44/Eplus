import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, readonly: Client;
const Y = new Date().getFullYear();
const H = { 'X-Requested-With': 'EmergencyPlus' };
const binary = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); };

async function fill(template: Buffer, values: Record<string, [number | string | null, number | string | null]>, extra: unknown[][] = []) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template as never);
  const ws = wb.getWorksheet('الأرصدة الافتتاحية')!;
  ws.eachRow((row, i) => { const v = values[String(row.getCell(1).value)]; if (i > 2 && v) { row.getCell(4).value = v[0]; row.getCell(5).value = v[1]; } });
  for (const r of extra) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const preview = (c: Client, buf: Buffer, name = 'opening.xlsx') => c.agent.post('/api/accounting/opening/preview').set(H).attach('file', buf, name);

beforeAll(async () => {
  [admin] = await Promise.all([login('admin')]);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'accounting_readonly' } });
  const bcrypt = (await import('bcryptjs')).default;
  await prisma.user.upsert({ where: { username: 'acc.ro2' }, create: { username: 'acc.ro2', fullName: 'قراءة', passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id }, update: {} });
  readonly = await login('acc.ro2');
});

describe('opening balances from Excel', () => {
  let template: Buffer;
  it('downloads a ready Arabic template with every account and EmergencyPlus suggestions', async () => {
    expect((await readonly.agent.get('/api/accounting/opening/template').set(H)).status).toBe(403);
    const r = await admin.agent.get('/api/accounting/opening/template').set(H).buffer(true).parse(binary);
    expect(r.status).toBe(200);
    template = r.body as Buffer;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template as never);
    const ws = wb.getWorksheet('الأرصدة الافتتاحية')!;
    expect(ws.views[0].rightToLeft).toBe(true);
    expect(ws.getRow(2).getCell(1).value).toBe('رقم الحساب');
    const codes: string[] = []; ws.eachRow((row, i) => { if (i > 2) codes.push(String(row.getCell(1).value)); });
    expect(codes).toEqual(expect.arrayContaining(['110101', '1103', '3101']));
    expect(wb.getWorksheet('تعليمات')).toBeTruthy();
  });

  it('preview shows errors and warnings and writes nothing', async () => {
    const buf = await fill(template, { '110101': [1500, null], '3101': [null, 1500], '1107': [100, 50] }, [['999999', 'حساب غير موجود', '', 10, null], ['110101', 'مكرر', '', 5, null]]);
    const before = await prisma.journalEntry.count();
    const r = await preview(admin, buf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.rows as { code: string; errors: string[] }[];
    expect(rows.find((x) => x.code === '1107')!.errors.join()).toContain('مدين ودائن');
    expect(rows.find((x) => x.code === '999999')!.errors.join()).toContain('غير موجود');
    expect(rows.filter((x) => x.code === '110101')[1].errors.join()).toContain('مكرر');
    expect(r.body.totals).toMatchObject({ debit: 1500, credit: 1500, invalid: 3 });
    expect(await prisma.journalEntry.count()).toBe(before);
  });

  it('import refuses unbalanced balances unless the difference goes to the opening-balances account; re-import replaces', async () => {
    const accts = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
    const rows = [{ accountId: accts['110101'], debit: 2000, credit: 0 }, { accountId: accts['3101'], debit: 0, credit: 1800 }];
    expect((await admin.post('/api/accounting/opening/import', { date: `${Y}-01-01`, rows })).status).toBe(400);
    const ok = await admin.post('/api/accounting/opening/import', { date: `${Y}-01-01`, rows, fillDifference: true, fileName: 'opening.xlsx' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ok.body.id }, include: { lines: true } });
    expect([e.type, e.status, Number(e.totalDebit)]).toEqual(['OPENING', 'POSTED', 2000]);
    expect(e.lines.some((l) => l.accountId === accts['3105'] && Number(l.credit) === 200)).toBe(true);
    const again = await admin.post('/api/accounting/opening/import', { date: `${Y}-01-01`, rows: [{ accountId: accts['110101'], debit: 2500, credit: 0 }, { accountId: accts['3101'], debit: 0, credit: 2500 }] });
    expect(again.body.id).toBe(ok.body.id); // replaced, not duplicated
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: ok.body.id } })).version).toBe(2);
    expect(await prisma.journalEntry.count({ where: { type: 'OPENING', description: { contains: 'استيراد Excel' } } })).toBe(1);
  });

  it('reads CSV too, and refuses other file types', async () => {
    const csv = Buffer.from('﻿رقم الحساب,اسم الحساب,مدين,دائن\n110101,الصندوق الرئيسي,"1,250.500",\n3101,رأس المال,,1250.5\n', 'utf8');
    const r = await preview(admin, csv, 'opening.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totals).toMatchObject({ debit: 1250.5, credit: 1250.5, valid: 2 });
    expect((await preview(admin, Buffer.from('x'), 'opening.pdf')).status).toBe(400);
  });
});
