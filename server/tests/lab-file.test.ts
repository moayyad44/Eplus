import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { pdfLines } from '../src/modules/lab/pdfText';
import { matchToOrder, parseHeader, parseResults } from '../src/modules/lab/labPdf';
import { login, type Client } from './helpers';

// Same layout as the referral lab's report (identifying details replaced by fictional ones).
const PDF = readFileSync(path.join(__dirname, 'fixtures/lab-report-sample.pdf'));
const H = { 'X-Requested-With': 'EmergencyPlus' };
let admin: Client, reception: Client;

describe('reading the lab report PDF', () => {
  it('reads the header and every result with value, unit, range and the arrows', async () => {
    const lines = await pdfLines(PDF);
    expect(parseHeader(lines)).toMatchObject({ patientName: 'مريض تجريبي', fileNo: 'PTN00000', gender: 'Female', sampleDate: '05/11/2026 05:49:32 PM' });
    const r = parseResults(lines);
    const by = (k: string) => r.find((x) => x.key === k)!;
    expect(r).toHaveLength(31);
    expect(by('HGB')).toMatchObject({ value: '13.7', unit: 'g/dL', referenceRange: '12-16', flag: 'NORMAL' });
    expect(by('MCV')).toMatchObject({ value: '89', flag: 'LOW' });
    expect(by('RDW')).toMatchObject({ value: '15.7', flag: 'HIGH' });
    expect(by('LYMPH_P')).toMatchObject({ value: '19', unit: '%', flag: 'LOW' });
    expect(by('LYMPH_A')).toMatchObject({ value: '1.25', unit: 'X 10^3 /uL', referenceRange: '3.000- 13.500', flag: 'LOW' });
    expect(by('ESR')).toMatchObject({ value: '17', unit: 'mm/hr', referenceRange: 'up to 20' });
    expect(by('ALT')).toMatchObject({ value: '22', unit: 'U/L', referenceRange: '<34', flag: 'NORMAL' });
    expect(by('ALP')).toMatchObject({ value: '40', unit: 'U/L', flag: 'LOW' }); // first result of a new page
    expect(by('ALB')).toMatchObject({ name: 'Albumin, Serum', value: '4.6' });
    expect(by('TP').referenceRange).toContain('Adult: 6.4 - 8.3');
    expect(by('CRP').referenceRange).toContain('low CVD risk: Less than 0.1 mg/dl');
    expect(by('FT4')).toMatchObject({ value: '1.17', unit: 'ng/dL', referenceRange: '1.0-2.01 | 0.70 - 1.48', notes: 'SI: 15.06 pmol/L' });
  });

  it('puts each result under its test: a panel without parameters, a single test, a test with defined parameters', async () => {
    const r = parseResults(await pdfLines(PDF));
    const p = matchToOrder(r, [
      { id: 'lft', testName: 'LFT 8TESTS', code: 'L002', parameters: [] },
      { id: 'tsh', testName: 'TSH', code: 'L019', parameters: [] },
      { id: 'cbc', testName: 'Complete Blood Count', code: 'CBC', parameters: [{ name: 'Hb' }, { name: 'WBC' }, { name: 'PLT' }, { name: 'Neutrophils %' }] },
      { id: 'hba1c', testName: 'HbA1c', code: 'L030', parameters: [] },
    ]);
    const of = (id: string) => p.items.find((i) => i.itemId === id)!.results;
    expect(of('lft').map((x) => x.value)).toEqual(['22', '20', '11', '40', '0.400', '0.100', '7.00', '4.6']);
    expect(of('tsh')).toEqual([expect.objectContaining({ value: '2.840', unit: 'uU/ml', flag: 'NORMAL' })]);
    const cbc = of('cbc');
    expect(cbc.find((x) => x.parameterName === 'Hb')?.value).toBe('13.7'); // the name defined in the clinic's catalogue
    expect(cbc.find((x) => x.parameterName === 'PLT')?.value).toBe('174');
    expect(cbc.find((x) => x.parameterName === 'Neutrophils %')?.value).toBe('73');
    expect(cbc.find((x) => x.parameterName === 'MCV')?.flag).toBe('LOW'); // a CBC result with no defined parameter still lands in the CBC
    expect(p.unassigned.map((x) => x.key)).toEqual(['ESR', 'CRP', 'FT4']); // in the report but not ordered
    expect(p.missing).toEqual(['HbA1c']); // ordered but not in the report
  });
});

describe('POST /lab/orders/:id/read-file', () => {
  let orderId: string;
  beforeAll(async () => {
    [admin, reception] = await Promise.all([login('admin'), login('reception')]);
    const doc = await prisma.user.findUniqueOrThrow({ where: { username: 'dr.ahmad' } });
    const pt = (await admin.post('/api/patients', { fullName: 'مريض تجريبي', phone: '0791231231', gender: 'FEMALE' })).body;
    const mk = (code: string, name: string, parameters?: object) => prisma.labTest.create({ data: { code: `${code}-${Date.now()}`, name, parameters: parameters as never } });
    const [lft, tsh] = await Promise.all([mk('L002', 'LFT 8TESTS'), mk('L019', 'TSH')]);
    const o = await prisma.labOrder.create({ data: { orderNumber: `LAB-T-${Date.now()}`, patientId: pt.id, doctorId: doc.id, items: { create: [{ labTestId: lft.id, testName: lft.name }, { labTestId: tsh.id, testName: tsh.name }] } } });
    orderId = o.id;
  });
  const send = (c: Client, id: string, buf: Buffer, name = 'results.pdf') => c.agent.post(`/api/lab/orders/${id}/read-file`).set(H).attach('file', buf, name);

  it('proposes the results for the order and recognises the patient; nothing is saved', async () => {
    const r = await send(admin, orderId, PDF);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.patientCheck, r.body.header.patientName, r.body.found]).toEqual(['match', 'مريض تجريبي', 31]);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.missing).toEqual([]);
    expect(await prisma.labResult.count({ where: { item: { labOrderId: orderId } } })).toBe(0);
    // the proposal is saved through the usual results screen
    const s = await admin.put(`/api/lab/orders/${orderId}/results`, { complete: true, items: r.body.items.map((i: { itemId: string; results: object[] }) => ({ itemId: i.itemId, notes: null, results: i.results })) });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(await prisma.labResult.count({ where: { item: { labOrderId: orderId } } })).toBe(9);
  });

  it('warns when the report is for another patient, refuses other files and users without the permission', async () => {
    const doc = await prisma.user.findUniqueOrThrow({ where: { username: 'dr.ahmad' } });
    const other = (await admin.post('/api/patients', { fullName: 'سامي خليل', phone: '0791231299', gender: 'MALE' })).body;
    const item = await prisma.labOrderItem.findFirstOrThrow({ where: { labOrderId: orderId } });
    const o2 = await prisma.labOrder.create({ data: { orderNumber: `LAB-T2-${Date.now()}`, patientId: other.id, doctorId: doc.id, items: { create: [{ labTestId: item.labTestId, testName: item.testName }] } } });
    expect((await send(admin, o2.id, PDF)).body.patientCheck).toBe('mismatch');
    expect((await send(admin, o2.id, Buffer.from('not a pdf'), 'x.txt')).status).toBe(400);
    expect((await send(admin, o2.id, Buffer.from('%PDF-1.4 broken'), 'x.pdf')).status).toBe(400);
    expect((await send(reception, o2.id, PDF)).status).toBe(403);
  });
});
