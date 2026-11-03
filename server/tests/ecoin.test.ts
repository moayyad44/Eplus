import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { awardForInvoice } from '../src/modules/ecoin/earn';
import { processExpiry } from '../src/modules/ecoin/wallet';
import { evaluatePenalties } from '../src/modules/ecoin/penalty';
import { buyShift } from '../src/modules/shiftx/actions';
import { addDays, dateOnly } from '../src/lib/dates';
import { login, type Client } from './helpers';

/**
 * E Coin & shift exchange, end to end through the API (and a few engine calls for time-based rules).
 * Shifts are created relative to "now" so every time rule (started / within one hour / ended) is exact.
 */

let admin: Client, ahmad: Client, lina: Client, omar: Client, sara: Client, huda: Client, reception: Client;
const id: Record<string, string> = {};
let templateId: string;
let tpl = 0;

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inMinutes = (m: number) => { const d = new Date(Date.now() + m * 60_000); d.setSeconds(0, 0); return d; };

/** A distributed shift (own template, so it never collides) starting at `start` for `hours`. */
async function slot(userId: string | null, start: Date, hours = 8, staffType: 'DOCTOR' | 'NURSE' = 'DOCTOR') {
  const end = new Date(start.getTime() + hours * 3_600_000);
  const shift = await prisma.shift.create({ data: { name: `T${++tpl}`, type: 'CUSTOM', startTime: hhmm(start), endTime: hhmm(end) } });
  return prisma.shiftAssignment.create({
    data: { userId, shiftId: shift.id, date: dateOnly(localDay(start)), startTime: hhmm(start), endTime: hhmm(end), staffType, originalUserId: userId, holding: userId ? 'ASSIGNED' : 'VACANT' },
  });
}
const balance = async (userId: string) => (await prisma.eCoinWallet.findUnique({ where: { userId } }))?.balance ?? 0;
const give = (userId: string, amount: number) => admin.post('/api/ecoin/adjust', { userId, amount, reason: 'رصيد للاختبار' });
const DAY = 24 * 60;

beforeAll(async () => {
  [admin, ahmad, lina, sara, reception] = await Promise.all([login('admin'), login('dr.ahmad'), login('dr.lina'), login('nurse.sara'), login('reception')]);
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));
  for (const [username, fullName, role, staffType] of [['dr.omar', 'د. عمر', 'doctor', 'DOCTOR'], ['nurse.huda', 'هدى', 'nurse', 'NURSE']] as const) {
    const r = await admin.post('/api/users', { username, fullName, roleId: roles[role], staffType, password: 'Test@12345', mustChangePassword: false });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  [omar, huda] = await Promise.all([login('dr.omar'), login('nurse.huda')]);
  for (const u of await prisma.user.findMany({ where: { username: { in: ['dr.ahmad', 'dr.lina', 'dr.omar', 'nurse.sara', 'nurse.huda', 'admin'] } } })) id[u.username] = u.id;
  templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false, items: { none: {} } } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('earning E Coins from lab invoices', () => {
  let patientId: string;
  const labInvoice = async (codes: string[], extraServiceCode?: string) => {
    const v = await reception.post('/api/visits/direct', { patientId, doctorId: id['dr.lina'], payerType: 'SELF_PAY' });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const tests = await prisma.labTest.findMany({ where: { code: { in: codes } } });
    if (tests.length) expect((await ahmad.post('/api/lab/orders', { visitId: v.body.id, patientId, testIds: tests.map((t) => t.id) })).status).toBe(201);
    const items = tests.map((t) => ({ serviceId: t.serviceId!, quantity: 1 }));
    if (extraServiceCode) items.push({ serviceId: (await prisma.service.findFirstOrThrow({ where: { code: extraServiceCode } })).id, quantity: 1 });
    // Created by reception, doctor on the invoice is Lina — the coin must go to Ahmad, who ordered the tests.
    const inv = await reception.post('/api/billing/invoices', { patientId, visitId: v.body.id, doctorId: id['dr.lina'], templateId, items, issue: true });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    return inv.body;
  };

  beforeAll(async () => {
    patientId = (await reception.post('/api/patients', { fullName: 'مريض العملات', phone: '0791231231', gender: 'MALE' })).body.id;
  });

  it('1. one lab test → 1 E Coin to the doctor who ordered it, linked to the invoice', async () => {
    const before = await balance(id['dr.ahmad']);
    const inv = await labInvoice(['L004']);
    expect(await balance(id['dr.ahmad'])).toBe(before + 1);
    expect(await balance(id['dr.lina'])).toBe(0);
    const lot = await prisma.eCoinLot.findUniqueOrThrow({ where: { invoiceId: inv.id } });
    expect(lot).toMatchObject({ userId: id['dr.ahmad'], amount: 1, source: 'LAB_INVOICE' });
    expect(Math.round((lot.expiresAt.getTime() - lot.earnedAt.getTime()) / 86_400_000)).toBe(30);
    const txn = await prisma.eCoinTxn.findFirstOrThrow({ where: { invoiceId: inv.id, type: 'EARN' } });
    expect(txn.balanceAfter).toBe(txn.balanceBefore + 1);
    const me = await ahmad.get('/api/ecoin/transactions');
    expect(me.body.items.find((t: { invoiceNumber: string }) => t.invoiceNumber === inv.invoiceNumber)).toBeTruthy();
  });

  it('2. several lab tests → still exactly 1 E Coin', async () => {
    const before = await balance(id['dr.ahmad']);
    await labInvoice(['L004', 'L011']);
    expect(await balance(id['dr.ahmad'])).toBe(before + 1);
  });

  it('3. no lab test → no coin', async () => {
    const before = await balance(id['dr.ahmad']);
    const inv = await labInvoice([], 'SRV-ECG');
    expect(await balance(id['dr.ahmad'])).toBe(before);
    expect(await prisma.eCoinLot.findUnique({ where: { invoiceId: inv.id } })).toBeNull();
  });

  it('4. never twice for the same invoice; a cancelled invoice takes its coin back (history kept)', async () => {
    const inv = await labInvoice(['L004']);
    const before = await balance(id['dr.ahmad']);
    expect(await prisma.$transaction((tx) => awardForInvoice(tx, null, inv.id))).toBeNull();
    expect(await balance(id['dr.ahmad'])).toBe(before);
    expect((await admin.post(`/api/billing/invoices/${inv.id}/cancel`, { reason: 'خطأ في الإدخال' })).status).toBe(200);
    expect(await balance(id['dr.ahmad'])).toBe(before - 1);
    const types = (await prisma.eCoinTxn.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: 'asc' } })).map((t) => t.type);
    expect(types).toEqual(['EARN', 'CLAWBACK']);
  });
});

describe('expiry and the wallet ledger', () => {
  it('5. each lot expires on its own date (not the whole balance); soonest-to-expire is spent first', async () => {
    const u = id['dr.omar'];
    await give(u, 2);
    await give(u, 3);
    const lots = await prisma.eCoinLot.findMany({ where: { userId: u }, orderBy: { createdAt: 'asc' } });
    await prisma.eCoinLot.update({ where: { id: lots[0].id }, data: { expiresAt: new Date(Date.now() - 1000) } }); // the 2-coin lot is 30 days old
    await prisma.eCoinLot.update({ where: { id: lots[1].id }, data: { expiresAt: addDays(new Date(), 3) } });
    await processExpiry();
    expect(await balance(u)).toBe(3);
    const exp = await prisma.eCoinTxn.findFirstOrThrow({ where: { userId: u, type: 'EXPIRE' } });
    expect([exp.amount, exp.balanceBefore, exp.balanceAfter]).toEqual([-2, 5, 3]);
    await give(u, 4); // newer lot, expires later
    const s = await slot(id['dr.lina'], inMinutes(3 * DAY), 8);
    expect((await omar.post(`/api/shifts/${s.id}/buy`, {})).status).toBe(200);
    const after = await prisma.eCoinLot.findMany({ where: { userId: u }, orderBy: { createdAt: 'asc' } });
    expect(after.map((l) => l.remaining)).toEqual([0, 1, 4]); // the 3-day lot paid first
    const w = await omar.get('/api/ecoin/me');
    expect(w.body).toMatchObject({ balance: 5, expired: 2, spentOnPurchases: 2 });
    expect(w.body.expiringSoon.map((l: { remaining: number }) => l.remaining)).toEqual([1]);
  });

  it('the ledger is append-only and the balance can never go negative', async () => {
    const t = await prisma.eCoinTxn.findFirstOrThrow();
    await expect(prisma.eCoinTxn.update({ where: { id: t.id }, data: { reason: 'x' } })).rejects.toThrow(/append-only/);
    await expect(prisma.eCoinTxn.delete({ where: { id: t.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.eCoinWallet.update({ where: { userId: id['dr.omar'] }, data: { balance: -1 } })).rejects.toThrow();
    const r = await admin.post('/api/ecoin/adjust', { userId: id['dr.omar'], amount: -999, reason: 'خصم أكبر من الرصيد' });
    expect(r.status).toBe(409);
    expect((await admin.post('/api/ecoin/adjust', { userId: id['dr.omar'], amount: 1, reason: '' })).status).toBe(400); // reason is mandatory
  });
});

describe('buying and securing shifts', () => {
  it('6-8. a doctor buys another doctor’s unsecured shift: price taken, holder changes, the loser gets nothing', async () => {
    await give(id['dr.ahmad'], 5);
    const s = await slot(id['dr.lina'], inMinutes(4 * DAY), 8); // 8 h → 2 E Coins
    const a0 = await balance(id['dr.ahmad']), l0 = await balance(id['dr.lina']);
    const board = await ahmad.get(`/api/shifts/board?from=${localDay(inMinutes(4 * DAY))}&to=${localDay(inMinutes(4 * DAY))}`);
    const cell = board.body.slots.find((x: { id: string }) => x.id === s.id);
    expect(cell).toMatchObject({ status: 'AVAILABLE', canBuy: true, price: { price: 2 } });
    const r = await ahmad.post(`/api/shifts/${s.id}/buy`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ price: 2, balance: a0 - 2 });
    expect(await balance(id['dr.ahmad'])).toBe(a0 - 2);
    expect(await balance(id['dr.lina'])).toBe(l0);
    expect(await prisma.eCoinTxn.count({ where: { userId: id['dr.lina'], assignmentId: s.id } })).toBe(0);
    const after = await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: s.id } });
    expect([after.userId, after.holding]).toEqual([id['dr.ahmad'], 'PURCHASED']);
    const hist = await ahmad.get(`/api/shifts/${s.id}`);
    expect(hist.body.events.map((e: { type: string; from: string; to: string }) => [e.type, e.from, e.to])).toEqual([['PURCHASED', 'د. لينا منصور', 'د. أحمد الخطيب']]);
    expect(await prisma.notification.count({ where: { userId: id['dr.lina'], title: 'خسرت شفتاً' } })).toBeGreaterThan(0);
    // A purchased shift is protected: a third doctor cannot buy it again.
    await give(id['dr.omar'], 3);
    expect((await omar.post(`/api/shifts/${s.id}/buy`, {})).status).toBe(400);
  });

  it('9 & 14. a doctor secures his own shift for 1 E Coin; nobody can buy it then', async () => {
    await give(id['dr.lina'], 2);
    const s = await slot(id['dr.lina'], inMinutes(5 * DAY), 12);
    const l0 = await balance(id['dr.lina']);
    const r = await lina.post(`/api/shifts/${s.id}/secure`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await balance(id['dr.lina'])).toBe(l0 - 1);
    expect((await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: s.id } })).holding).toBe('SECURED');
    const b = await ahmad.post(`/api/shifts/${s.id}/buy`, {});
    expect(b.status).toBe(400);
    expect(b.body.error?.message ?? '').toContain('تأمينه');
    const board = await ahmad.get(`/api/shifts/board?from=${localDay(inMinutes(5 * DAY))}&to=${localDay(inMinutes(5 * DAY))}`);
    const cell = board.body.slots.find((x: { id: string }) => x.id === s.id);
    expect(cell).toMatchObject({ status: 'SECURED', canBuy: false, price: { price: 3 } });
    expect(cell.lockReason).toBeTruthy();
    // Someone else's shift cannot be secured
    expect((await ahmad.post(`/api/shifts/${s.id}/secure`, {})).status).toBe(400);
  });

  it('10-12. started, starting within an hour, or ended → refused', async () => {
    await give(id['dr.ahmad'], 6);
    const started = await slot(id['dr.lina'], inMinutes(-60), 8);
    const soon = await slot(id['dr.lina'], inMinutes(60), 8);
    const ended = await slot(id['dr.lina'], inMinutes(-20 * 60), 8);
    const a0 = await balance(id['dr.ahmad']);
    for (const [s, word] of [[started, 'بدأ'], [soon, 'دقيقة'], [ended, 'انتهى']] as const) {
      const r = await ahmad.post(`/api/shifts/${s.id}/buy`, {});
      expect(r.status).toBe(400);
      expect(r.body.error?.message ?? '').toContain(word);
    }
    expect(await balance(id['dr.ahmad'])).toBe(a0);
  });

  it('13. a month not yet distributed has nothing to buy (shown as not distributed)', async () => {
    const day = localDay(addDays(new Date(), 70));
    const b = await ahmad.get(`/api/shifts/board?from=${day}&to=${day}`);
    expect(b.body.slots.filter((x: { date: string }) => x.date === day)).toEqual([]);
    expect(b.body.unassigned.filter((x: { date: string }) => x.date === day).length).toBeGreaterThan(0);
  });

  it('not enough balance → refused, nothing changes', async () => {
    const s = await slot(id['dr.lina'], inMinutes(6 * DAY), 12); // 3 coins
    const u = id['dr.omar'];
    const have = await balance(u);
    if (have >= 3) await admin.post('/api/ecoin/adjust', { userId: u, amount: -(have - 1), reason: 'تقليل للاختبار' });
    const r = await omar.post(`/api/shifts/${s.id}/buy`, {});
    expect(r.status).toBe(409);
    expect(r.body.error?.message ?? '').toContain('غير كافٍ');
    expect((await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: s.id } })).userId).toBe(id['dr.lina']);
  });
});

describe('releasing a shift', () => {
  it('15. releasing a secured shift: no refund, the slot becomes vacant and buyable, management is told', async () => {
    await give(id['dr.lina'], 1);
    const s = await slot(id['dr.lina'], inMinutes(7 * DAY), 8);
    expect((await lina.post(`/api/shifts/${s.id}/secure`, {})).status).toBe(200);
    const l0 = await balance(id['dr.lina']);
    expect((await lina.post(`/api/shifts/${s.id}/release`, {})).status).toBe(400); // confirmation required
    const r = await lina.post(`/api/shifts/${s.id}/release`, { confirm: true, reason: 'ظرف عائلي' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await balance(id['dr.lina'])).toBe(l0);
    const a = await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: s.id } });
    expect([a.userId, a.holding]).toEqual([null, 'VACANT']);
    expect(await prisma.notification.count({ where: { userId: id.admin, title: 'شفت شاغر' } })).toBeGreaterThan(0);
    await give(id['dr.ahmad'], 2);
    expect((await ahmad.post(`/api/shifts/${s.id}/buy`, {})).status).toBe(200);
    const ev = (await prisma.shiftEvent.findMany({ where: { assignmentId: s.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
    expect(ev).toEqual(['SECURED', 'RELEASED', 'PURCHASED']);
  });
});

describe('incentive rule (no coins during the last 5 worked shifts)', () => {
  it('16-17. after 5 worked shifts without coins: purchases cost 1 less for the next 5 purchases, then back to normal; evaluated once', async () => {
    const u = id['dr.omar'];
    await prisma.eCoinWallet.upsert({ where: { userId: u }, create: { userId: u, penaltyCheckedThrough: addDays(new Date(), -12) }, update: { penaltyCheckedThrough: addDays(new Date(), -12) } });
    for (let d = 7; d >= 3; d--) await slot(u, inMinutes(-d * DAY), 8); // five shifts he worked, all over
    await evaluatePenalties();
    await evaluatePenalties(); // the same five shifts are never judged twice
    const pens = await prisma.eCoinPenalty.findMany({ where: { userId: u } });
    expect(pens).toHaveLength(1);
    expect(pens[0]).toMatchObject({ status: 'ACTIVE', discount: 1, usesLeft: 5, coinsEarned: 0 });
    expect((pens[0].windowShifts as unknown[]).length).toBe(5);
    expect((await admin.get('/api/ecoin/penalties')).body.some((p: { userId: string }) => p.userId === u)).toBe(true);

    await give(u, 20);
    const prices: number[] = [];
    for (let i = 0; i < 6; i++) {
      const s = await slot(id['dr.lina'], inMinutes((10 + i) * DAY), 8); // 2 E Coins each
      if (i === 0) {
        const b = await omar.get(`/api/shifts/board?from=${localDay(inMinutes(10 * DAY))}&to=${localDay(inMinutes(10 * DAY))}`);
        expect(b.body.slots.find((x: { id: string }) => x.id === s.id).price).toMatchObject({ base: 2, discount: 1, price: 1 });
      }
      const r = await omar.post(`/api/shifts/${s.id}/buy`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      prices.push(r.body.price);
    }
    expect(prices).toEqual([1, 1, 1, 1, 1, 2]);
    expect(await prisma.eCoinPenalty.findFirstOrThrow({ where: { userId: u } })).toMatchObject({ status: 'ENDED', usesLeft: 0 });
    expect(await prisma.notification.count({ where: { userId: u, title: 'انتهت فترة التخفيض' } })).toBe(1);
  });

  it('a doctor who earned coins during those shifts gets no discount', async () => {
    const u = id['dr.lina'];
    await prisma.eCoinWallet.upsert({ where: { userId: u }, create: { userId: u, penaltyCheckedThrough: addDays(new Date(), -12) }, update: { penaltyCheckedThrough: addDays(new Date(), -12) } });
    const s = [];
    for (let d = 8; d >= 4; d--) s.push(await slot(u, inMinutes(-d * DAY - 120), 8));
    await prisma.eCoinLot.create({ data: { userId: u, source: 'LAB_INVOICE', amount: 1, remaining: 0, activityAt: inMinutes(-6 * DAY - 60), expiresAt: addDays(new Date(), -1) } });
    await evaluatePenalties();
    expect(await prisma.eCoinPenalty.count({ where: { userId: u } })).toBe(0);
  });
});

describe('swaps, partial coverage, delays (doctors and nurses)', () => {
  it('18. swap with the other side’s consent; 19. a refused swap changes nothing', async () => {
    const a = await slot(id['nurse.sara'], inMinutes(3 * DAY), 8, 'NURSE');
    const b = await slot(id['nurse.huda'], inMinutes(3 * DAY + 600), 8, 'NURSE');
    const r = await sara.post('/api/shifts/swaps', { fromAssignmentId: a.id, toAssignmentId: b.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await prisma.notification.count({ where: { userId: id['nurse.huda'], title: { startsWith: 'طلب تبديل' } } })).toBe(1);
    expect((await sara.post(`/api/shifts/swaps/${r.body.id}/respond`, { decision: 'ACCEPT' })).status).toBe(403); // only the other side
    expect((await huda.post(`/api/shifts/swaps/${r.body.id}/respond`, { decision: 'ACCEPT' })).status).toBe(200);
    const [a1, b1] = await Promise.all([prisma.shiftAssignment.findUniqueOrThrow({ where: { id: a.id } }), prisma.shiftAssignment.findUniqueOrThrow({ where: { id: b.id } })]);
    expect([a1.userId, b1.userId]).toEqual([id['nurse.huda'], id['nurse.sara']]);
    expect((await huda.post(`/api/shifts/swaps/${r.body.id}/respond`, { decision: 'ACCEPT' })).status).toBe(400); // once only

    const c = await slot(id['nurse.sara'], inMinutes(4 * DAY), 8, 'NURSE');
    const d = await slot(id['nurse.huda'], inMinutes(4 * DAY + 600), 8, 'NURSE');
    const r2 = await sara.post('/api/shifts/swaps', { fromAssignmentId: c.id, toAssignmentId: d.id });
    expect((await huda.post(`/api/shifts/swaps/${r2.body.id}/respond`, { decision: 'REJECT' })).status).toBe(200);
    expect((await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: c.id } })).userId).toBe(id['nurse.sara']);
    expect((await prisma.shiftSwap.findUniqueOrThrow({ where: { id: r2.body.id } })).status).toBe('REJECTED');
    // A started shift cannot be swapped; a doctor cannot be swapped with a nurse
    const started = await slot(id['nurse.sara'], inMinutes(-30), 8, 'NURSE');
    expect((await sara.post('/api/shifts/swaps', { fromAssignmentId: started.id, toAssignmentId: d.id })).status).toBe(400);
    const doc = await slot(id['dr.lina'], inMinutes(20 * DAY), 8);
    expect((await sara.post('/api/shifts/swaps', { fromAssignmentId: c.id, toAssignmentId: doc.id })).status).toBe(400);
  });

  it('a swapped secured shift keeps its protection (documented in its history)', async () => {
    await give(id['dr.ahmad'], 1);
    const mine = await slot(id['dr.ahmad'], inMinutes(25 * DAY), 8);
    const theirs = await slot(id['dr.lina'], inMinutes(26 * DAY), 8);
    expect((await ahmad.post(`/api/shifts/${mine.id}/secure`, {})).status).toBe(200);
    const r = await ahmad.post('/api/shifts/swaps', { fromAssignmentId: mine.id, toAssignmentId: theirs.id });
    expect((await lina.post(`/api/shifts/swaps/${r.body.id}/respond`, { decision: 'ACCEPT' })).status).toBe(200);
    const m = await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: mine.id } });
    expect([m.userId, m.holding]).toEqual([id['dr.lina'], 'SECURED']);
    expect((await prisma.shiftEvent.findMany({ where: { assignmentId: mine.id } })).map((e) => e.type)).toEqual(['SECURED', 'SWAPPED']);
  });

  it('20. partial coverage: the previous shift covers the first hour of the next one, after acceptance; 21. refused', async () => {
    const t = inMinutes(2 * DAY);
    await slot(id['nurse.sara'], new Date(t.getTime() - 8 * 3_600_000), 8, 'NURSE'); // ends at t
    const next = await slot(id['nurse.huda'], t, 8, 'NURSE');
    const r = await sara.post('/api/shifts/coverages', { assignmentId: next.id, minutes: 60 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await huda.post(`/api/shifts/coverages/${r.body.id}/respond`, { decision: 'ACCEPT' })).status).toBe(200);
    const c = await prisma.shiftCoverage.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(c).toMatchObject({ status: 'ACCEPTED', minutes: 60 });
    expect(c.endAt.getTime() - c.startAt.getTime()).toBe(3_600_000);
    expect((await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: next.id } })).userId).toBe(id['nurse.huda']); // holder unchanged
    // Overlapping second request refused; a shift not right after mine refused
    expect((await sara.post('/api/shifts/coverages', { assignmentId: next.id, minutes: 30 })).status).toBe(400);
    const far = await slot(id['nurse.huda'], inMinutes(9 * DAY), 8, 'NURSE');
    expect((await sara.post('/api/shifts/coverages', { assignmentId: far.id, minutes: 30 })).status).toBe(400);

    const t2 = inMinutes(5 * DAY);
    await slot(id['nurse.sara'], new Date(t2.getTime() - 8 * 3_600_000), 8, 'NURSE');
    const next2 = await slot(id['nurse.huda'], t2, 8, 'NURSE');
    const r2 = await sara.post('/api/shifts/coverages', { assignmentId: next2.id, minutes: 60 });
    expect((await huda.post(`/api/shifts/coverages/${r2.body.id}/respond`, { decision: 'REJECT' })).status).toBe(200);
    expect((await prisma.shiftCoverage.findUniqueOrThrow({ where: { id: r2.body.id } })).status).toBe('REJECTED');
    expect(await prisma.eCoinTxn.count({ where: { assignmentId: { in: [next.id, next2.id] } } })).toBe(0); // no coins involved
  });

  it('22. late 45 min + previous doctor extended 45 min, recorded by an authorised user without fingerprint', async () => {
    const t = inMinutes(-30); // the next shift started 30 minutes ago
    const prev = await slot(id['dr.ahmad'], new Date(t.getTime() - 8 * 3_600_000), 8);
    const next = await slot(id['dr.lina'], t, 8);
    expect((await ahmad.post('/api/shifts/handovers', { nextAssignmentId: next.id, lateMinutes: 45, extendedMinutes: 45 })).status).toBe(403);
    const r = await admin.post('/api/shifts/handovers', { nextAssignmentId: next.id, lateMinutes: 45, extendedMinutes: 45, reason: 'ازدحام مروري' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ prevAssignmentId: prev.id, prevUserId: id['dr.ahmad'], nextUserId: id['dr.lina'], lateMinutes: 45, extendedMinutes: 45, recordedById: id.admin });
    expect(new Date(r.body.actualStart).getTime() - new Date(r.body.plannedStart).getTime()).toBe(45 * 60_000);
    expect(new Date(r.body.actualEnd).getTime() - new Date(r.body.plannedEnd).getTime()).toBe(45 * 60_000);
    expect((await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: next.id } })).userId).toBe(id['dr.lina']);
    expect(await prisma.eCoinTxn.count({ where: { assignmentId: { in: [prev.id, next.id] } } })).toBe(0);
    const rep = await admin.get('/api/shifts/handovers/list');
    expect(rep.body.items.some((h: { id: string; prev: string; next: string }) => h.id === r.body.id && h.prev === 'د. أحمد الخطيب')).toBe(true);
    expect(rep.body.totals.lateMinutes).toBeGreaterThanOrEqual(45);
  });
});

describe('permissions and safety', () => {
  it('23. nurses use the shared shift functions but never E Coin', async () => {
    expect((await sara.get('/api/ecoin/me')).status).toBe(403);
    expect((await sara.get('/api/ecoin/transactions')).status).toBe(403);
    const s = await slot(id['dr.lina'], inMinutes(30 * DAY), 8);
    expect((await sara.post(`/api/shifts/${s.id}/buy`, {})).status).toBe(403);
    const b = await sara.get(`/api/shifts/board?from=${localDay(inMinutes(30 * DAY))}&to=${localDay(inMinutes(30 * DAY))}`);
    expect(b.status).toBe(200);
    const cell = b.body.slots.find((x: { id: string }) => x.id === s.id);
    expect(cell.price).toBeNull();
    expect(cell.canBuy).toBe(false);
    expect(b.body.viewer.balance).toBeNull();
    // Even if a nurse were given ecoin.use by mistake, the server refuses (doctors only)
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'nurse' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: 'ecoin.use' } });
    const sara2 = await login('nurse.sara');
    expect((await sara2.post(`/api/shifts/${s.id}/buy`, {})).status).toBe(403);
    expect((await sara2.get('/api/ecoin/me')).status).toBe(403);
    await prisma.rolePermission.delete({ where: { roleId_permissionKey: { roleId: role.id, permissionKey: 'ecoin.use' } } });
  });

  it('24. doctors cannot touch balances, prices, others’ wallets or reports; administration can', async () => {
    expect((await ahmad.post('/api/ecoin/adjust', { userId: id['dr.ahmad'], amount: 100, reason: 'محاولة تلاعب' })).status).toBe(403);
    expect((await ahmad.get('/api/ecoin/wallets')).status).toBe(403);
    expect((await ahmad.get('/api/ecoin/reports')).status).toBe(403);
    expect((await ahmad.put('/api/ecoin/settings', { securePrice: 0 })).status).toBe(403);
    expect((await ahmad.post('/api/ecoin/price-rules', { shiftId: templateId, weekday: 5, price: 0 })).status).toBe(403);
    const others = await ahmad.get(`/api/ecoin/transactions?userId=${id['dr.lina']}`);
    expect(others.body.items.every((t: { userId: string }) => t.userId === id['dr.ahmad'])).toBe(true);
    expect((await reception.post('/api/shifts/swaps', {})).status).toBe(403);
    expect((await reception.get('/api/ecoin/me')).status).toBe(403);
    expect((await admin.get('/api/ecoin/wallets')).status).toBe(200);
    const rep = await admin.get('/api/ecoin/reports');
    expect(rep.status).toBe(200);
    expect(rep.body.totals.purchases).toBeGreaterThan(0);
    expect(rep.body.rows.find((r: { id: string }) => r.id === id['dr.lina']).lost).toBeGreaterThan(0);
  });

  it('per-shift prices: a Friday rule and a date rule change only that shift', async () => {
    const s = await slot(id['dr.lina'], inMinutes(15 * DAY), 8);
    const other = await slot(id['dr.lina'], inMinutes(15 * DAY + 600), 8);
    const weekday = s.date.getUTCDay();
    expect((await admin.post('/api/ecoin/price-rules', { shiftId: s.shiftId, weekday, price: 3 })).status).toBe(201);
    expect((await admin.post('/api/ecoin/price-rules', { shiftId: s.shiftId, weekday, price: 4 })).status).toBe(400); // duplicate
    const day = localDay(inMinutes(15 * DAY));
    let p = (await admin.get(`/api/ecoin/prices?from=${day}&to=${day}`)).body;
    expect(p.find((x: { id: string }) => x.id === s.id)).toMatchObject({ price: 3, source: 'WEEKDAY' });
    expect(p.find((x: { id: string }) => x.id === other.id)).toMatchObject({ price: 2, source: 'DURATION' });
    expect((await admin.post('/api/ecoin/price-rules', { shiftId: s.shiftId, date: day, price: 5 })).status).toBe(201);
    p = (await admin.get(`/api/ecoin/prices?from=${day}&to=${day}`)).body;
    expect(p.find((x: { id: string }) => x.id === s.id)).toMatchObject({ price: 5, source: 'DATE' });
    expect((await admin.post('/api/ecoin/price-rules', { shiftId: s.shiftId, weekday: 1, date: day, price: 1 })).status).toBe(400); // one or the other
  });

  it('25. two doctors buying the same shift at the same moment: exactly one wins, one charge', async () => {
    await give(id['dr.ahmad'], 3);
    await give(id['dr.omar'], 3);
    const s = await slot(id['dr.lina'], inMinutes(40 * DAY), 8);
    const [a0, o0] = [await balance(id['dr.ahmad']), await balance(id['dr.omar'])];
    const [r1, r2] = await Promise.all([ahmad.post(`/api/shifts/${s.id}/buy`, {}), omar.post(`/api/shifts/${s.id}/buy`, {})]);
    expect([r1.status, r2.status].sort()).toEqual([200, 400]);
    const winner = r1.status === 200 ? id['dr.ahmad'] : id['dr.omar'];
    expect((await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: s.id } })).userId).toBe(winner);
    expect(await prisma.eCoinTxn.count({ where: { assignmentId: s.id, type: 'PURCHASE' } })).toBe(1);
    expect((a0 - (await balance(id['dr.ahmad']))) + (o0 - (await balance(id['dr.omar'])))).toBe(2);
  });

  it('26. an error in the middle of a purchase rolls everything back', async () => {
    await give(id['dr.ahmad'], 2);
    const s = await slot(id['dr.lina'], inMinutes(41 * DAY), 8);
    const a0 = await balance(id['dr.ahmad']);
    const ctx = { userId: id['dr.ahmad'], userName: 'د. أحمد', username: 'dr.ahmad', roleKey: 'doctor', staffType: 'DOCTOR' as const, branchId: null, sessionId: 'x', perms: new Set(['ecoin.use']) };
    await expect(prisma.$transaction(async (tx) => { await buyShift(tx, ctx, s.id); throw new Error('انقطاع'); })).rejects.toThrow('انقطاع');
    expect(await balance(id['dr.ahmad'])).toBe(a0);
    const a = await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: s.id } });
    expect([a.userId, a.holding]).toEqual([id['dr.lina'], 'ASSIGNED']);
    expect(await prisma.shiftEvent.count({ where: { assignmentId: s.id } })).toBe(0);
  });

  it('27. resending the same request (lost answer, double click) never charges twice', async () => {
    await give(id['dr.ahmad'], 2);
    const s = await slot(id['dr.lina'], inMinutes(42 * DAY), 8);
    const a0 = await balance(id['dr.ahmad']);
    const requestId = '7f0d6c8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
    const [r1, r2] = await Promise.all([ahmad.post(`/api/shifts/${s.id}/buy`, { requestId }), ahmad.post(`/api/shifts/${s.id}/buy`, { requestId })]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect([r1.body.replayed, r2.body.replayed].sort()).toEqual([false, true]);
    const r3 = await ahmad.post(`/api/shifts/${s.id}/buy`, { requestId });
    expect(r3.body).toMatchObject({ replayed: true, txnId: r1.body.txnId === r2.body.txnId ? r1.body.txnId : expect.any(String) });
    expect(await balance(id['dr.ahmad'])).toBe(a0 - 2);
    expect(await prisma.eCoinTxn.count({ where: { assignmentId: s.id, type: 'PURCHASE' } })).toBe(1);
  });

  it('administrative reversal of a wrong purchase: coins back, shift back, original rows kept, once only', async () => {
    await give(id['dr.ahmad'], 2);
    const s = await slot(id['dr.lina'], inMinutes(43 * DAY), 8);
    const a0 = await balance(id['dr.ahmad']);
    const buy = await ahmad.post(`/api/shifts/${s.id}/buy`, {});
    expect((await ahmad.post(`/api/ecoin/transactions/${buy.body.txnId}/reverse`, { reason: 'شراء بالخطأ' })).status).toBe(403);
    expect((await admin.post(`/api/ecoin/transactions/${buy.body.txnId}/reverse`, { reason: '' })).status).toBe(400);
    const r = await admin.post(`/api/ecoin/transactions/${buy.body.txnId}/reverse`, { reason: 'شراء بالخطأ بإقرار الطبيب' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await balance(id['dr.ahmad'])).toBe(a0);
    const a = await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: s.id } });
    expect([a.userId, a.holding]).toEqual([id['dr.lina'], 'ASSIGNED']);
    expect(await prisma.eCoinTxn.findUnique({ where: { id: buy.body.txnId } })).toBeTruthy();
    expect((await admin.post(`/api/ecoin/transactions/${buy.body.txnId}/reverse`, { reason: 'مرة ثانية' })).status).toBe(400);
  });

  it('a shift with E Coin history cannot be deleted from the schedule (traceability)', async () => {
    const s = await slot(id['dr.lina'], inMinutes(44 * DAY), 8);
    await give(id['dr.lina'], 1);
    expect((await lina.post(`/api/shifts/${s.id}/secure`, {})).status).toBe(200);
    expect((await admin.del(`/api/staff/schedule/${s.id}`)).status).toBe(400);
    await expect(prisma.shiftEvent.deleteMany({ where: { assignmentId: s.id } })).rejects.toThrow(/append-only/);
  });

  it('expiry warnings and stale requests are handled by the background job', async () => {
    const u = id['dr.lina'];
    await give(u, 1);
    const lot = await prisma.eCoinLot.findFirstOrThrow({ where: { userId: u, remaining: { gt: 0 } }, orderBy: { createdAt: 'desc' } });
    await prisma.eCoinLot.update({ where: { id: lot.id }, data: { expiresAt: addDays(new Date(), 2) } });
    await processExpiry();
    expect(await prisma.notification.count({ where: { userId: u, dedupeKey: `ecoin-warn:${lot.id}` } })).toBe(1);
  });
});
