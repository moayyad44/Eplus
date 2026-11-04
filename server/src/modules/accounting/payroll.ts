import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, nullableStr } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { D, r3 } from '../../lib/money';
import { dateOnlyStr } from '../../lib/dates';
import { dayOf } from './journal';
import { postDoc } from './link';
import { docNumber } from './common';

/**
 * Payroll on the existing staff (no duplicate employee records). Real money only: E Coin is never money, never a
 * salary, a bonus or a liability here. A month is prepared (absences and lateness taken from attendance), reviewed,
 * approved (salary expense against salaries payable and advances recovered) and then paid from a box or a bank.
 */
export const payrollRouter = Router();
const month = z.string().regex(/^\d{4}-\d{2}$/, 'الشهر بصيغة YYYY-MM');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const allowances = z.array(z.object({ name: z.string().trim().min(1).max(60), amount: z.coerce.number().min(0).max(100000) })).max(20);

payrollRouter.get('/payroll/profiles', requireAnyPerm('accounting.payroll.view', 'accounting.payroll.manage'), ah(async (_req, res) => {
  const [users, profiles] = await Promise.all([
    prisma.user.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, fullName: true, staffType: true, specialty: true, role: { select: { name: true } } }, orderBy: { fullName: 'asc' } }),
    prisma.salaryProfile.findMany(),
  ]);
  res.json(users.map((u) => ({ user: u, profile: profiles.find((p) => p.userId === u.id) ?? null })));
}));

payrollRouter.put('/payroll/profiles/:userId', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  const b = parse(z.object({ jobTitle: nullableStr(100), basic: z.coerce.number().min(0).max(1_000_000), allowances: allowances.default([]), paymentMethod: z.enum(['CASH', 'TRANSFER', 'CHEQUE']).default('TRANSFER'), treasuryId: z.string().uuid().nullable().optional(), isActive: z.boolean().default(true) }), req.body);
  const u = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!u) throw notFound('الموظف غير موجود');
  const before = await prisma.salaryProfile.findUnique({ where: { userId: u.id } });
  const p = await prisma.salaryProfile.upsert({ where: { userId: u.id }, create: { userId: u.id, ...b, basic: r3(b.basic) }, update: { ...b, basic: r3(b.basic) } });
  await audit(prisma, req.ctx, { action: 'payroll.profile', entityType: 'salary_profile', entityId: u.id, summary: `بيانات راتب ${u.fullName}`, before, after: p });
  res.json(p);
}));

// ───── Advances ─────

payrollRouter.get('/payroll/advances', requireAnyPerm('accounting.payroll.view', 'accounting.payroll.manage'), ah(async (_req, res) => {
  const rows = await prisma.employeeAdvance.findMany({ orderBy: { date: 'desc' }, take: 500 });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, fullName: true } });
  res.json(rows.map((a) => ({ ...a, date: dateOnlyStr(a.date), user: users.find((u) => u.id === a.userId)?.fullName, remaining: D(a.amount).sub(a.recovered).toNumber() })));
}));

payrollRouter.post('/payroll/advances', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid('اختر الموظف'), date: day, amount: z.coerce.number().positive().max(1_000_000), installment: z.coerce.number().positive(), treasuryId: z.string().uuid('اختر الصندوق أو البنك'), notes: nullableStr(300) }), req.body);
  if (b.installment > b.amount) throw badRequest('القسط الشهري أكبر من السلفة');
  const a = await prisma.$transaction(async (tx) => {
    const created = await tx.employeeAdvance.create({ data: { ...b, date: dayOf(b.date), amount: r3(b.amount), installment: r3(b.installment), number: await docNumber(tx, 'ADV'), createdById: req.ctx.userId } });
    await postDoc(tx, 'advance', created.id);
    await audit(tx, req.ctx, { action: 'payroll.advance', entityType: 'employee_advance', entityId: created.id, summary: `${created.number}: ${b.amount}` });
    return created;
  });
  res.status(201).json(a);
}));

payrollRouter.post('/payroll/advances/:id/cancel', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const a = await tx.employeeAdvance.findUnique({ where: { id: req.params.id } });
    if (!a || a.status === 'CANCELLED') throw badRequest('السلفة غير موجودة أو ملغاة');
    if (D(a.recovered).gt(0)) throw badRequest('بدأ استرداد السلفة من الرواتب؛ لا يمكن إلغاؤها');
    await tx.employeeAdvance.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
    await postDoc(tx, 'advance', a.id);
    await audit(tx, req.ctx, { action: 'payroll.advance_cancel', entityType: 'employee_advance', entityId: a.id, summary: a.number });
  });
  res.json({ ok: true });
}));

// ───── Monthly payroll ─────

const net = (s: { basic: Prisma.Decimal.Value; allowances: Prisma.Decimal.Value; commission: Prisma.Decimal.Value; bonus: Prisma.Decimal.Value; overtime: Prisma.Decimal.Value; absenceDeduction: Prisma.Decimal.Value; deductions: Prisma.Decimal.Value; advance: Prisma.Decimal.Value }) =>
  r3(D(s.basic).add(s.allowances).add(s.commission).add(s.bonus).add(s.overtime).sub(s.absenceDeduction).sub(s.deductions).sub(s.advance));

async function loadRun(id: string) {
  const r = await prisma.payrollRun.findUnique({ where: { id }, include: { slips: true } });
  if (!r) throw notFound('كشف الرواتب غير موجود');
  const users = await prisma.user.findMany({ where: { id: { in: r.slips.map((s) => s.userId) } }, select: { id: true, fullName: true } });
  const entries = await prisma.journalEntry.findMany({ where: { sourceKey: { in: [`payroll:${r.id}`, `payroll-pay:${r.id}`] } }, select: { id: true, number: true, sourceKey: true, status: true } });
  return { ...r, dueDate: r.dueDate && dateOnlyStr(r.dueDate), paidDate: r.paidDate && dateOnlyStr(r.paidDate), entries, slips: r.slips.map((s) => ({ ...s, user: users.find((u) => u.id === s.userId)?.fullName ?? '' })).sort((a, b) => a.user.localeCompare(b.user, 'ar')) };
}

payrollRouter.get('/payroll/runs', requireAnyPerm('accounting.payroll.view', 'accounting.payroll.manage'), ah(async (_req, res) => {
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: 'desc' }, include: { slips: { select: { net: true } } } });
  res.json(runs.map((r) => ({ ...r, slips: undefined, employees: r.slips.length, total: r.slips.reduce((t, s) => t.add(s.net), D(0)).toNumber() })));
}));
payrollRouter.get('/payroll/runs/:id', requireAnyPerm('accounting.payroll.view', 'accounting.payroll.manage'), ah(async (req, res) => res.json(await loadRun(req.params.id))));

/** Prepare a month: every employee with an active salary profile; absences and lateness from attendance; advance installments. */
payrollRouter.post('/payroll/runs', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  const b = parse(z.object({ month, dueDate: day.nullable().optional() }), req.body);
  const [y, m] = b.month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)), to = new Date(Date.UTC(y, m, 0));
  const run = await prisma.$transaction(async (tx) => {
    if (await tx.payrollRun.findUnique({ where: { month: b.month } })) throw badRequest('كشف هذا الشهر موجود');
    const profiles = await tx.salaryProfile.findMany({ where: { isActive: true, basic: { gt: 0 } } });
    if (!profiles.length) throw badRequest('لا يوجد موظفون لهم بيانات راتب');
    const att = await tx.attendance.findMany({ where: { userId: { in: profiles.map((p) => p.userId) }, date: { gte: from, lte: to } } });
    const adv = await tx.employeeAdvance.findMany({ where: { status: 'ACTIVE', userId: { in: profiles.map((p) => p.userId) } } });
    const created = await tx.payrollRun.create({ data: { month: b.month, dueDate: b.dueDate ? dayOf(b.dueDate) : to, createdById: req.ctx.userId } });
    for (const p of profiles) {
      const mine = att.filter((a) => a.userId === p.userId);
      const absenceDays = mine.filter((a) => a.status === 'ABSENT').length;
      const lateMinutes = mine.reduce((t, a) => t + a.lateMinutes, 0);
      const allow = (p.allowances as { amount: number }[]).reduce((t, a) => t.add(a.amount), D(0));
      const absenceDeduction = r3(D(p.basic).div(30).mul(absenceDays));
      const advance = r3(adv.filter((a) => a.userId === p.userId).reduce((t, a) => t.add(Prisma.Decimal.min(a.installment, D(a.amount).sub(a.recovered))), D(0)));
      const s = { basic: p.basic, allowances: allow, commission: 0, bonus: 0, overtime: 0, absenceDeduction, deductions: 0, advance };
      await tx.payslip.create({ data: { runId: created.id, userId: p.userId, jobTitle: p.jobTitle, absenceDays, lateMinutes, ...s, net: net(s) } });
    }
    await audit(tx, req.ctx, { action: 'payroll.prepare', entityType: 'payroll_run', entityId: created.id, summary: `إعداد رواتب ${b.month}: ${profiles.length} موظف` });
    return created;
  });
  res.status(201).json(await loadRun(run.id));
}));

payrollRouter.put('/payroll/runs/:id/slips/:slipId', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  const b = parse(z.object({ commission: z.coerce.number().min(0), bonus: z.coerce.number().min(0), overtime: z.coerce.number().min(0), absenceDeduction: z.coerce.number().min(0), deductions: z.coerce.number().min(0), advance: z.coerce.number().min(0), notes: nullableStr(300) }).partial(), req.body);
  await prisma.$transaction(async (tx) => {
    const s = await tx.payslip.findUnique({ where: { id: req.params.slipId }, include: { run: true } });
    if (!s || s.runId !== req.params.id) throw notFound();
    if (s.run.status !== 'DRAFT') throw badRequest('الكشف معتمد؛ أعد فتحه للتعديل');
    const merged = { ...s, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'notes').map(([k, v]) => [k, r3(v as number)])) };
    if (b.advance !== undefined) {
      const open = (await tx.employeeAdvance.findMany({ where: { userId: s.userId, status: 'ACTIVE' } })).reduce((t, a) => t.add(D(a.amount).sub(a.recovered)), D(0));
      if (D(b.advance).gt(open)) throw badRequest(`استرداد السلف أكبر من المتبقي (${open.toFixed(3)})`);
    }
    const n = net(merged);
    if (n.lt(0)) throw badRequest('صافي الراتب سالب');
    await tx.payslip.update({ where: { id: s.id }, data: { ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k === 'notes' ? v : r3(v as number)])), net: n } });
  });
  res.json(await loadRun(req.params.id));
}));

/** Advances recovered by an approved month (oldest first). */
async function recover(tx: Tx, runId: string, sign: 1 | -1) {
  const slips = await tx.payslip.findMany({ where: { runId, advance: { gt: 0 } } });
  for (const s of slips) {
    let left = D(s.advance);
    const advs = await tx.employeeAdvance.findMany({ where: { userId: s.userId, status: 'ACTIVE' }, orderBy: { date: sign > 0 ? 'asc' : 'desc' } });
    for (const a of advs) {
      if (left.lte(0)) break;
      const room = sign > 0 ? D(a.amount).sub(a.recovered) : D(a.recovered);
      const take = Prisma.Decimal.min(room, left);
      if (take.gt(0)) await tx.employeeAdvance.update({ where: { id: a.id }, data: { recovered: D(a.recovered).add(take.mul(sign)) } });
      left = left.sub(take);
    }
  }
}

payrollRouter.post('/payroll/runs/:id/approve', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const r = await tx.payrollRun.findUnique({ where: { id: req.params.id } });
    if (!r || r.status !== 'DRAFT') throw badRequest('الكشف غير موجود أو معتمد');
    await tx.payrollRun.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedById: req.ctx.userId } });
    await recover(tx, r.id, 1);
    await postDoc(tx, 'payroll', r.id);
    await audit(tx, req.ctx, { action: 'payroll.approve', entityType: 'payroll_run', entityId: r.id, summary: `اعتماد رواتب ${r.month}` });
  });
  res.json(await loadRun(req.params.id));
}));

payrollRouter.post('/payroll/runs/:id/reopen', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const r = await tx.payrollRun.findUnique({ where: { id: req.params.id } });
    if (!r || r.status !== 'APPROVED') throw badRequest('يمكن إعادة فتح كشف معتمد غير مدفوع فقط');
    await tx.payrollRun.update({ where: { id: r.id }, data: { status: 'DRAFT', approvedById: null } });
    await recover(tx, r.id, -1);
    await postDoc(tx, 'payroll', r.id);
    await audit(tx, req.ctx, { action: 'payroll.reopen', entityType: 'payroll_run', entityId: r.id, summary: `إعادة فتح رواتب ${r.month}` });
  });
  res.json(await loadRun(req.params.id));
}));

payrollRouter.post('/payroll/runs/:id/pay', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  const b = parse(z.object({ date: day, treasuryId: z.string().uuid('اختر الصندوق أو البنك') }), req.body);
  await prisma.$transaction(async (tx) => {
    const r = await tx.payrollRun.findUnique({ where: { id: req.params.id } });
    if (!r || r.status !== 'APPROVED') throw badRequest('اعتمد الكشف قبل صرفه');
    await tx.payrollRun.update({ where: { id: r.id }, data: { status: 'PAID', paidDate: dayOf(b.date), treasuryId: b.treasuryId } });
    await postDoc(tx, 'payroll-pay', r.id);
    await audit(tx, req.ctx, { action: 'payroll.pay', entityType: 'payroll_run', entityId: r.id, summary: `صرف رواتب ${r.month}` });
  });
  res.json(await loadRun(req.params.id));
}));
