import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

/**
 * Staff, attendance and payroll policies (Settings → Medical): lateness, early leave, overtime, leaves and absences,
 * from the attendance record to the payslip lines and the accounting entry.
 */
let admin: Client, adjuster: Client, clerk: Client;
const Y = new Date().getFullYear();
const MONTH = `${Y}-04`;
const day = (d: number) => `${MONTH}-${String(d).padStart(2, '0')}`;
const at = (d: number, hhmm: string) => new Date(`${day(d)}T${hhmm}:00`).toISOString();
const n = (v: unknown) => Number(v);
let M: string, X: string, H: string, shiftId: string;
const acc: Record<string, string> = {};

type Body = Record<string, unknown>;
const policy = async (patch: Body) => {
  const cur = (await admin.get('/api/settings/attendance')).body;
  const merged = { ...cur, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'object' && !Array.isArray(v) ? { ...cur[k], ...(v as Body) } : v])) };
  const r = await admin.put('/api/settings/attendance', { ...merged, reason: 'اختبار السياسات' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const record = (userId: string, d: number, inT: string | null, outT: string | null, extra: Body = {}) =>
  admin.post('/api/staff/attendance', { userId, date: day(d), checkIn: inT ? at(d, inT) : null, checkOut: outT ? at(d, outT) : null, ...extra });
const rowOf = (userId: string, d: number) => prisma.attendance.findUniqueOrThrow({ where: { userId_date: { userId, date: new Date(`${day(d)}T00:00:00Z`) } } });
type Item = { id: string; kind: string; state: string; amount: number; minutes: number; date: string; waived: boolean };
type Slip = { id: string; userId: string; net: string; items: Item[]; [k: string]: unknown };
const slipOf = (run: { slips: Slip[] }, userId: string) => run.slips.find((s) => s.userId === userId)!;
const item = (s: Slip, kind: string, d: number) => s.items.find((i) => i.kind === kind && i.date === day(d))!;

beforeAll(async () => {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'receptionist' } });
  const hash = await bcrypt.hash('Test@12345', 4);
  const mk = (username: string, fullName: string, roleId = role.id) => prisma.user.create({ data: { username, fullName, passwordHash: hash, roleId } });
  const adjRole = await prisma.role.create({ data: { key: 'payroll_adjust_only', name: 'معدّل رواتب', permissions: { create: ['accounting.access', 'accounting.payroll.view', 'accounting.payroll.adjust'].map((permissionKey) => ({ permissionKey })) } } });
  const [m, x, h] = await Promise.all([mk('pol.monthly', 'موظف شهري'), mk('pol.exempt', 'موظف معفى'), mk('pol.hourly', 'موظف بالساعة'), mk('pol.adjust', 'معدّل', adjRole.id), mk('pol.clerk', 'موظف يسجل حضوره')]);
  [M, X, H] = [m.id, x.id, h.id];
  [admin, adjuster, clerk] = await Promise.all([login('admin'), login('pol.adjust'), login('pol.clerk')]);
  for (const a of await prisma.account.findMany({ where: { systemKey: { not: null } } })) acc[a.systemKey!] = a.id;
  shiftId = (await prisma.shift.create({ data: { name: 'صباحي اختبار', type: 'MORNING', startTime: '08:00', endTime: '16:00' } })).id;
  for (const userId of [M, X, H]) for (let d = 1; d <= 11; d++) await prisma.shiftAssignment.create({ data: { userId, shiftId, date: new Date(`${day(d)}T00:00:00Z`), startTime: '08:00', endTime: '16:00' } });
  expect((await admin.put(`/api/accounting/payroll/profiles/${M}`, { basic: 600 })).status).toBe(200);
  expect((await admin.put(`/api/accounting/payroll/profiles/${X}`, { basic: 600, policy: { lateExempt: true } })).status).toBe(200);
  expect((await admin.put(`/api/accounting/payroll/profiles/${H}`, { payType: 'HOURLY', hourlyRate: 4 })).status).toBe(200);
  await policy({ method: 'CLOCK', graceMinutes: 5, late: { deduct: false, rounding: 'MINUTE', method: 'HOUR_VALUE', mode: 'AUTO' }, early: { deduct: false }, overtime: { enabled: false, minMinutes: 30, method: 'MULTIPLIER', multiplier: 1.5, needsApproval: true, requireCheckout: true }, payroll: { dayDivisor: 30, dailyHours: 8, adjustmentsNeedApproval: false, lockOnApproval: true } });
});

describe('settings', () => {
  it('needs its own permission and a reason; unknown values are refused', async () => {
    expect((await clerk.put('/api/settings/attendance', { graceMinutes: 1, reason: 'محاولة' })).status).toBe(403);
    expect((await admin.put('/api/settings/attendance', { graceMinutes: 5 })).status).toBe(400);
    expect((await admin.put('/api/settings/attendance', { late: { rounding: 'Q7' }, reason: 'قيمة خاطئة' })).status).toBe(400);
    const log = await prisma.auditLog.findFirst({ where: { action: 'settings.update', entityId: 'attendance' }, orderBy: { createdAt: 'desc' } });
    expect(log?.summary).toContain('اختبار السياسات');
  });
});

describe('attendance', () => {
  it('1-3: on time, late within the grace period, late after it', async () => {
    expect((await record(M, 1, '07:58', '16:00')).status).toBe(200);
    expect(await rowOf(M, 1)).toMatchObject({ status: 'PRESENT', lateMinutes: 0, overtimeMinutes: 0, workedMinutes: 482 });
    await record(M, 2, '08:04', '16:00');
    expect(await rowOf(M, 2)).toMatchObject({ status: 'PRESENT', lateMinutes: 0 });
    await record(M, 3, '08:20', '16:00');
    expect(await rowOf(M, 3)).toMatchObject({ status: 'LATE', lateMinutes: 20 });
    await record(X, 3, '08:30', '16:00');
    await record(H, 3, '08:20', '16:00');
    await record(M, 5, '08:40', '16:00');
  });

  it('7-8: early leave, and time after the shift end is overtime', async () => {
    await record(M, 6, '08:00', '15:00');
    expect(await rowOf(M, 6)).toMatchObject({ status: 'EARLY_LEAVE', earlyLeaveMinutes: 60 });
    await record(M, 7, '08:00', '17:00');
    expect(await rowOf(M, 7)).toMatchObject({ status: 'PRESENT', overtimeMinutes: 60, workedMinutes: 540 });
    await record(H, 7, '08:00', '17:00');
  });

  it('11-12: approved leave is never an absence; absences justified or not', async () => {
    await prisma.attendance.create({ data: { userId: M, date: new Date(`${day(8)}T00:00:00Z`), status: 'ABSENT', notes: 'تسجيل تلقائي' } });
    const l = await admin.post('/api/staff/leaves', { userId: M, type: 'ANNUAL', startDate: day(8), endDate: day(8) });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect((await rowOf(M, 8)).status).toBe('LEAVE');
    expect((await admin.post('/api/staff/leaves', { userId: M, type: 'UNPAID', startDate: day(9), endDate: day(9) })).status).toBe(201);
    expect((await record(M, 10, null, null, { status: 'ABSENT' })).status).toBe(200);
    expect((await record(M, 11, null, null, { status: 'ABSENT', excused: true })).status).toBe(200);
    expect((await rowOf(M, 11)).excused).toBe(true);
    const bal = await admin.get(`/api/staff/leaves/balances?year=${Y}`);
    expect(bal.body.rows.find((r: { user: { id: string } }) => r.user.id === M)).toMatchObject({ annualUsed: 1, annualLeft: 13, unpaidUsed: 1 });
  });

  it('13: correcting a record needs a reason, kept with the record and in the audit log', async () => {
    expect((await record(M, 2, '08:04', '16:10')).status).toBe(400);
    const r = await record(M, 2, '08:04', '16:00', { reason: 'خطأ في وقت المغادرة' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ editReason: 'خطأ في وقت المغادرة' });
    const log = await prisma.auditLog.findFirst({ where: { entityType: 'attendance', entityId: r.body.id }, orderBy: { createdAt: 'desc' } });
    expect(log?.summary).toContain('خطأ في وقت المغادرة');
  });

  it('6: lateness waived for one record (manager decision, with its reason)', async () => {
    const r = await rowOf(M, 5);
    expect((await clerk.post(`/api/staff/attendance/${r.id}/late`, { decision: 'EXEMPT', reason: 'محاولة' })).status).toBe(403);
    const d = await admin.post(`/api/staff/attendance/${r.id}/late`, { decision: 'EXEMPT', reason: 'ظرف طارئ موثق' });
    expect([d.status, d.body.lateDecision]).toEqual([200, 'EXEMPT']);
  });

  it('check-in / check-out from the employee account: no leave without arrival, no double arrival', async () => {
    const out1 = await clerk.post('/api/staff/attendance/check-out');
    expect([out1.status, out1.body.error?.message ?? out1.body.message]).toEqual([400, expect.stringContaining('سجّل الحضور أولاً')]);
    expect((await clerk.post('/api/staff/attendance/check-in')).status).toBe(200);
    expect((await clerk.post('/api/staff/attendance/check-in')).status).toBe(400);
    const me = await clerk.get('/api/staff/attendance/me');
    expect(me.body.record.checkIn).toBeTruthy();
    expect((await clerk.post('/api/staff/attendance/check-out')).status).toBe(200);
    expect((await clerk.post('/api/staff/attendance/check-out')).status).toBe(400);
    // the employee only sees his own records
    const list = await clerk.get(`/api/staff/attendance?from=${MONTH}-01&to=${Y}-12-31`);
    expect(list.body.items.every((r: { userId: string }) => r.userId === list.body.items[0].userId)).toBe(true);
  });

  it('manual overtime: with a reason, never over a shift or a period already counted', async () => {
    expect((await admin.post('/api/staff/overtime', { userId: M, date: day(7), start: '16:30', end: '17:30', reason: 'تغطية طارئة' })).status).toBe(400); // already counted from the leave time
    expect((await admin.post('/api/staff/overtime', { userId: M, date: day(4), start: '09:00', end: '10:00', reason: 'داخل الشفت' })).status).toBe(400); // inside a shift
    const ok = await admin.post('/api/staff/overtime', { userId: M, date: day(12), start: '10:00', end: '12:00', reason: 'يوم عطلة: جرد المستودع' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await admin.post('/api/staff/overtime', { userId: M, date: day(12), start: '11:00', end: '13:00', reason: 'تكرار' })).status).toBe(400);
  });
});

describe('payroll from attendance', () => {
  let run: { id: string; slips: Slip[] };
  it('4 & 9: lateness and overtime recorded but not paid / deducted while their policies are off', async () => {
    const r = await admin.post('/api/accounting/payroll/runs', { month: MONTH });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    run = r.body;
    const s = slipOf(run, M);
    expect(item(s, 'LATE', 3)).toMatchObject({ state: 'OFF', minutes: 15 });
    expect(n(item(s, 'LATE', 3).amount)).toBe(0);
    expect(item(s, 'OVERTIME', 7)).toMatchObject({ state: 'OFF', minutes: 60 });
    expect([s.lateCount, s.lateMinutes, n(s.lateDeduction), n(s.overtime)]).toEqual([2, 60, 0, 0]);
  });

  it('5, 6, 7, 10, 11, 12: with the policies on → every line follows its rule', async () => {
    await policy({ late: { deduct: true }, early: { deduct: true }, overtime: { enabled: true } });
    let r = await admin.post(`/api/accounting/payroll/runs/${run.id}/recalculate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    let s = slipOf(r.body, M);
    expect(item(s, 'LATE', 3)).toMatchObject({ state: 'DEDUCTED', amount: 0.625 }); // 20 − 5 grace = 15 min × 2.5/h
    expect(item(s, 'LATE', 5).state).toBe('EXEMPT');
    expect(item(slipOf(r.body, X), 'LATE', 3).state).toBe('EXEMPT'); // employee exempted in his profile
    expect(item(slipOf(r.body, H), 'LATE', 3).state).toBe('HOURLY'); // not paid for that time already
    expect(item(s, 'EARLY', 6)).toMatchObject({ state: 'DEDUCTED', minutes: 55, amount: 2.292 });
    expect(item(s, 'OVERTIME', 7).state).toBe('PENDING'); // needs a manager's approval
    expect(item(s, 'OVERTIME_MANUAL', 12)).toMatchObject({ state: 'PAID', amount: 7.5 }); // 2h × 2.5 × 1.5
    expect(item(s, 'LEAVE', 8)).toMatchObject({ state: 'PAID', amount: 0 });
    expect(item(s, 'LEAVE', 9)).toMatchObject({ state: 'DEDUCTED', amount: 20 });
    expect(item(s, 'ABSENCE', 10)).toMatchObject({ state: 'DEDUCTED', amount: 20 });
    expect(item(s, 'ABSENCE', 11)).toMatchObject({ state: 'PAID', amount: 0 });
    expect(s.items.some((i) => i.kind === 'ABSENCE' && i.date === day(8))).toBe(false);

    const ot = await rowOf(M, 7);
    expect((await admin.post(`/api/staff/attendance/${ot.id}/overtime`, { decision: 'APPROVED', reason: 'بقي لتغطية حالة طارئة' })).status).toBe(200);
    await admin.post(`/api/staff/attendance/${(await rowOf(H, 7)).id}/overtime`, { decision: 'APPROVED', reason: 'تغطية' });
    r = await admin.post(`/api/accounting/payroll/runs/${run.id}/recalculate`);
    s = slipOf(r.body, M);
    expect(item(s, 'OVERTIME', 7)).toMatchObject({ state: 'PAID', amount: 3.75 }); // 1h × 2.5 × 1.5
    expect([n(s.absenceDeduction), n(s.lateDeduction), n(s.earlyDeduction), n(s.overtime), s.overtimeMinutes]).toEqual([40, 0.625, 2.292, 11.25, 180]);
    expect(n(s.net)).toBe(568.333); // 600 + 11.25 − 40 − 0.625 − 2.292
    const h = slipOf(r.body, H);
    expect([n(h.hours), n(h.basic), n(h.overtime)]).toEqual([15.67, 62.68, 6]); // 460 + 480 min regular; 1h × 4 × 1.5
    run = r.body;
  });

  it('15: recalculating again adds nothing twice; a waived line stays waived', async () => {
    const before = slipOf(run, M);
    const w = await admin.post(`/api/accounting/payroll/runs/${run.id}/items/${item(before, 'LATE', 3).id}/waive`, { waived: true, reason: 'أول تأخير هذا العام' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(n(slipOf(w.body, M).net)).toBe(568.958);
    for (let i = 0; i < 2; i++) {
      const r = await admin.post(`/api/accounting/payroll/runs/${run.id}/recalculate`);
      const s = slipOf(r.body, M);
      expect([s.items.length, n(s.net), item(s, 'LATE', 3).waived]).toEqual([before.items.length, 568.958, true]);
    }
    expect(await prisma.payslipItem.count({ where: { slipId: before.id } })).toBe(before.items.length);
  });

  it('adjustments wait for an approver when the policy says so', async () => {
    await policy({ payroll: { adjustmentsNeedApproval: true } });
    const s = slipOf(run, M);
    const e = await adjuster.put(`/api/accounting/payroll/runs/${run.id}/slips/${s.id}`, { bonus: 50 });
    expect([e.status, e.body.pending]).toEqual([200, true]);
    expect(n(slipOf(e.body, M).net)).toBe(568.958);
    expect((await admin.post(`/api/accounting/payroll/runs/${run.id}/approve`)).status).toBe(400);
    expect((await adjuster.post(`/api/accounting/payroll/runs/${run.id}/slips/${s.id}/adjust-decision`, { accept: true })).status).toBe(403);
    const d = await admin.post(`/api/accounting/payroll/runs/${run.id}/slips/${s.id}/adjust-decision`, { accept: true });
    expect(n(slipOf(d.body, M).net)).toBe(618.958);
    await policy({ payroll: { adjustmentsNeedApproval: false } });
  });

  it('14 & 16: approval posts the entry, locks the month, and reopening unlocks it', async () => {
    expect((await adjuster.post(`/api/accounting/payroll/runs/${run.id}/approve`)).status).toBe(403);
    const a = await admin.post(`/api/accounting/payroll/runs/${run.id}/approve`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const slips = a.body.slips as Slip[];
    const sum = (k: string) => Number(slips.reduce((t, x) => t + n(x[k]), 0).toFixed(3));
    const expense = Number((sum('basic') + sum('allowances') + sum('commission') + sum('bonus') + sum('overtime') - sum('absenceDeduction') - sum('lateDeduction') - sum('earlyDeduction') - sum('deductions')).toFixed(3));
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { sourceKey: `payroll:${run.id}` }, include: { lines: true } });
    const net = (id: string) => 0 + Number(e.lines.filter((l) => l.accountId === id).reduce((t, l) => t + n(l.debit) - n(l.credit), 0).toFixed(3));
    expect([net(acc.SALARIES), net(acc.SALARIES_PAYABLE), net(acc.EMPLOYEE_ADVANCES)]).toEqual([expense, -sum('net'), -sum('advance') || 0]);

    expect((await record(M, 1, '07:58', '16:30', { reason: 'تصحيح' })).status).toBe(400);
    expect((await admin.post(`/api/staff/attendance/${(await rowOf(M, 3)).id}/late`, { decision: 'EXEMPT', reason: 'بعد الاعتماد' })).status).toBe(400);
    expect((await admin.post(`/api/accounting/payroll/runs/${run.id}/reopen`)).status).toBe(200);
    expect((await record(M, 1, '07:58', '16:00', { reason: 'تصحيح بعد إعادة الفتح' })).status).toBe(200);
  });

  it('schedule method: no leave time counts until the shift end; nothing recorded is not assumed present', async () => {
    await policy({ method: 'SCHEDULE' });
    await record(M, 4, '08:10', null);
    expect(await rowOf(M, 4)).toMatchObject({ lateMinutes: 10, workedMinutes: 470, overtimeMinutes: 0 });
    const list = await admin.get(`/api/staff/attendance?from=${day(4)}&to=${day(4)}&userId=${M}`);
    expect(list.body.items[0]).toMatchObject({ state: 'NO_CHECKOUT', review: 'NEEDS_REVIEW' });
    await prisma.attendance.create({ data: { userId: X, date: new Date(`${day(4)}T00:00:00Z`), status: 'NO_RECORD' } });
    const x = (await admin.get(`/api/staff/attendance?from=${day(4)}&to=${day(4)}&userId=${X}`)).body.items[0];
    expect([x.state, x.workedMinutes]).toEqual(['NO_RECORD', 0]);
    await policy({ method: 'CLOCK' });
    await prisma.salaryProfile.updateMany({ where: { userId: { in: [M, X, H] } }, data: { isActive: false } }); // out of other tests' months
  });
});
