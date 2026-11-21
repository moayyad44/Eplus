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
import { calculate, netOf, totals } from './payrollCalc';
import { empPolicySchema, getPolicy, readEmpPolicy, reevaluate } from '../staff/policy';
import { can } from '../../auth/context';

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
  const b = parse(z.object({ jobTitle: nullableStr(100), payType: z.enum(['MONTHLY', 'HOURLY']).default('MONTHLY'), basic: z.coerce.number().min(0).max(1_000_000).default(0), hourlyRate: z.coerce.number().min(0).max(10_000).default(0), allowances: allowances.default([]), paymentMethod: z.enum(['CASH', 'TRANSFER', 'CHEQUE']).default('TRANSFER'), treasuryId: z.string().uuid().nullable().optional(), isActive: z.boolean().default(true), policy: empPolicySchema.optional() }), req.body);
  const u = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!u) throw notFound('الموظف غير موجود');
  const before = await prisma.salaryProfile.findUnique({ where: { userId: u.id } });
  if (b.isActive && b.payType === 'HOURLY' && !b.hourlyRate) throw badRequest('أدخل أجر الساعة');
  const data = { ...b, basic: b.payType === 'HOURLY' ? 0 : r3(b.basic), hourlyRate: b.payType === 'HOURLY' ? r3(b.hourlyRate) : 0 };
  const p = await prisma.salaryProfile.upsert({ where: { userId: u.id }, create: { userId: u.id, ...data }, update: data });
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

async function loadRun(id: string) {
  const r = await prisma.payrollRun.findUnique({ where: { id }, include: { slips: { include: { items: { orderBy: [{ date: 'asc' }, { kind: 'asc' }] } } } } });
  if (!r) throw notFound('كشف الرواتب غير موجود');
  const users = await prisma.user.findMany({ where: { id: { in: r.slips.map((s) => s.userId) } }, select: { id: true, fullName: true } });
  const entries = await prisma.journalEntry.findMany({ where: { sourceKey: { in: [`payroll:${r.id}`, `payroll-pay:${r.id}`] } }, select: { id: true, number: true, sourceKey: true, status: true } });
  return {
    ...r, dueDate: r.dueDate && dateOnlyStr(r.dueDate), paidDate: r.paidDate && dateOnlyStr(r.paidDate), entries,
    slips: r.slips.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, date: dateOnlyStr(i.date) })), user: users.find((u) => u.id === s.userId)?.fullName ?? '' })).sort((a, b) => a.user.localeCompare(b.user, 'ar')),
  };
}

payrollRouter.get('/payroll/runs', requireAnyPerm('accounting.payroll.view', 'accounting.payroll.manage'), ah(async (_req, res) => {
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: 'desc' }, include: { slips: { select: { net: true } } } });
  res.json(runs.map((r) => ({ ...r, slips: undefined, employees: r.slips.length, total: r.slips.reduce((t, s) => t.add(s.net), D(0)).toNumber() })));
}));
payrollRouter.get('/payroll/runs/:id', requireAnyPerm('accounting.payroll.view', 'accounting.payroll.manage'), ah(async (req, res) => res.json(await loadRun(req.params.id))));

const monthRange = (month: string) => { const [y, m] = month.split('-').map(Number); return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 0)) }; };

/**
 * (Re)calculates the slips of a draft month from attendance, leaves and manual overtime. The manual amounts (commission,
 * bonus, other deductions, advance recovery, notes) are kept; lines keep their waivers; a line is never added twice.
 */
async function calculateRun(tx: Tx, runId: string, month: string, fresh: boolean) {
  const { from, to } = monthRange(month);
  const policy = await getPolicy(tx);
  const profiles = await tx.salaryProfile.findMany({ where: { isActive: true, OR: [{ basic: { gt: 0 } }, { payType: 'HOURLY', hourlyRate: { gt: 0 } }] } });
  if (!profiles.length) throw badRequest('لا يوجد موظفون لهم بيانات راتب');
  const emp = new Map(profiles.map((p) => [p.userId, readEmpPolicy(p.policy)]));
  await reevaluate(tx, profiles.map((p) => p.userId), from, to, policy, emp);
  const adv = await tx.employeeAdvance.findMany({ where: { status: 'ACTIVE', userId: { in: profiles.map((p) => p.userId) } } });
  const existing = await tx.payslip.findMany({ where: { runId }, include: { items: true } });
  for (const p of profiles) {
    const { items, fields } = await calculate(tx, p, from, to, policy, emp.get(p.userId) ?? {});
    const old = existing.find((s) => s.userId === p.userId);
    const keep = new Map((old?.items ?? []).map((i) => [`${i.kind}|${i.sourceId}`, i]));
    const lines = items.map((i) => { const k = keep.get(`${i.kind}|${i.sourceId}`); return { ...i, waived: k?.waived ?? false, waiveReason: k?.waiveReason ?? null }; });
    const manual = old
      ? { commission: old.commission, bonus: old.bonus, deductions: old.deductions, advance: old.advance, ...(!policy.payroll.autoAllowances && { allowances: old.allowances }) }
      : { commission: D(0), bonus: D(0), deductions: D(0), advance: r3(adv.filter((a) => a.userId === p.userId).reduce((t, a) => t.add(Prisma.Decimal.min(a.installment, D(a.amount).sub(a.recovered))), D(0))) };
    const data = { ...fields, ...manual, ...totals(lines) };
    const slip = old
      ? await tx.payslip.update({ where: { id: old.id }, data: { ...data, net: netOf(data) } })
      : await tx.payslip.create({ data: { runId, userId: p.userId, ...data, net: netOf(data) } });
    const now = new Set(lines.map((i) => `${i.kind}|${i.sourceId}`));
    const gone = (old?.items ?? []).filter((i) => !now.has(`${i.kind}|${i.sourceId}`)).map((i) => i.id);
    if (gone.length) await tx.payslipItem.deleteMany({ where: { id: { in: gone } } });
    for (const i of lines) {
      const k = keep.get(`${i.kind}|${i.sourceId}`);
      const { kind, sourceId, ...rest } = i;
      if (k) await tx.payslipItem.update({ where: { id: k.id }, data: rest });
      else await tx.payslipItem.create({ data: { slipId: slip.id, kind, sourceId, ...rest } });
    }
  }
  // Employees no longer paid (profile stopped) leave a draft that is recalculated.
  if (!fresh) {
    const stale = existing.filter((s) => !profiles.some((p) => p.userId === s.userId)).map((s) => s.id);
    if (stale.length) await tx.payslip.deleteMany({ where: { id: { in: stale } } });
  }
  return profiles.length;
}

payrollRouter.post('/payroll/runs', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  const b = parse(z.object({ month, dueDate: day.nullable().optional() }), req.body);
  const { to } = monthRange(b.month);
  const run = await prisma.$transaction(async (tx) => {
    if (await tx.payrollRun.findUnique({ where: { month: b.month } })) throw badRequest('كشف هذا الشهر موجود');
    const created = await tx.payrollRun.create({ data: { month: b.month, dueDate: b.dueDate ? dayOf(b.dueDate) : to, createdById: req.ctx.userId } });
    const n = await calculateRun(tx, created.id, b.month, true);
    await audit(tx, req.ctx, { action: 'payroll.prepare', entityType: 'payroll_run', entityId: created.id, summary: `إعداد رواتب ${b.month}: ${n} موظف` });
    return created;
  }, { timeout: 60_000 });
  res.status(201).json(await loadRun(run.id));
}));

payrollRouter.post('/payroll/runs/:id/recalculate', requirePerm('accounting.payroll.manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const r = await tx.payrollRun.findUnique({ where: { id: req.params.id } });
    if (!r) throw notFound('كشف الرواتب غير موجود');
    if (r.status !== 'DRAFT') throw badRequest('الكشف معتمد؛ أعد فتحه لإعادة الاحتساب');
    const n = await calculateRun(tx, r.id, r.month, false);
    await audit(tx, req.ctx, { action: 'payroll.recalculate', entityType: 'payroll_run', entityId: r.id, summary: `إعادة احتساب رواتب ${r.month} من الدوام: ${n} موظف` });
  }, { timeout: 60_000 });
  res.json(await loadRun(req.params.id));
}));

const slipEdit = z.object({ hours: z.coerce.number().min(0).max(744), hourlyRate: z.coerce.number().min(0).max(10_000), allowances: z.coerce.number().min(0), commission: z.coerce.number().min(0), bonus: z.coerce.number().min(0), deductions: z.coerce.number().min(0), advance: z.coerce.number().min(0), notes: nullableStr(300) }).partial();

/** Applies manual amounts to a slip (validated: hours only for hourly staff, advance within what is owed, net not negative). */
async function applyEdit(tx: Tx, slipId: string, b: z.infer<typeof slipEdit>) {
  const s = await tx.payslip.findUniqueOrThrow({ where: { id: slipId } });
  const { hours, hourlyRate, notes, ...money } = b;
  const hourly = s.payType === 'HOURLY';
  if (!hourly && (hours !== undefined || hourlyRate !== undefined)) throw badRequest('الساعات وأجر الساعة للموظفين بالساعة فقط');
  const hrs = hours !== undefined ? D(hours).toDecimalPlaces(2) : D(s.hours), rate = hourlyRate !== undefined ? r3(hourlyRate) : D(s.hourlyRate);
  const hourData = hourly ? { hours: hrs, hourlyRate: rate, basic: r3(hrs.mul(rate)) } : {};
  const moneyData = Object.fromEntries(Object.entries(money).filter(([, v]) => v !== undefined).map(([k, v]) => [k, r3(v as number)]));
  if (b.advance !== undefined) {
    const open = (await tx.employeeAdvance.findMany({ where: { userId: s.userId, status: 'ACTIVE' } })).reduce((t, a) => t.add(D(a.amount).sub(a.recovered)), D(0));
    if (D(b.advance).gt(open)) throw badRequest(`استرداد السلف أكبر من المتبقي (${open.toFixed(3)})`);
  }
  const merged = { ...s, ...hourData, ...moneyData };
  const n = netOf(merged);
  if (n.lt(0)) throw badRequest('صافي الراتب سالب');
  await tx.payslip.update({ where: { id: s.id }, data: { ...hourData, ...moneyData, ...(notes !== undefined && { notes }), net: n, pendingAdjust: Prisma.DbNull } });
}

async function draftSlip(tx: Tx, runId: string, slipId: string) {
  const s = await tx.payslip.findUnique({ where: { id: slipId }, include: { run: true } });
  if (!s || s.runId !== runId) throw notFound();
  if (s.run.status !== 'DRAFT') throw badRequest('الكشف معتمد؛ أعد فتحه للتعديل');
  return s;
}

payrollRouter.put('/payroll/runs/:id/slips/:slipId', requirePerm('accounting.payroll.adjust'), ah(async (req, res) => {
  const b = parse(slipEdit, req.body);
  const pending = await prisma.$transaction(async (tx) => {
    const s = await draftSlip(tx, req.params.id, req.params.slipId);
    const policy = await getPolicy(tx);
    // Additions and deductions waiting for a payroll approver (when the policy says so): the slip keeps its amounts until then.
    if (policy.payroll.adjustmentsNeedApproval && !can(req.ctx, 'accounting.payroll.approve')) {
      const { notes, ...values } = b;
      await tx.payslip.update({ where: { id: s.id }, data: { pendingAdjust: { values, byId: req.ctx.userId, byName: req.ctx.userName, at: new Date().toISOString() }, ...(notes !== undefined && { notes }) } });
      await audit(tx, req.ctx, { action: 'payroll.adjust_request', entityType: 'payslip', entityId: s.id, summary: 'تعديل على قسيمة راتب بانتظار الاعتماد', after: values });
      return true;
    }
    await applyEdit(tx, s.id, b);
    await audit(tx, req.ctx, { action: 'payroll.adjust', entityType: 'payslip', entityId: s.id, summary: 'تعديل قسيمة راتب', before: s, after: await tx.payslip.findUnique({ where: { id: s.id } }) });
    return false;
  });
  res.json({ ...(await loadRun(req.params.id)), pending });
}));

payrollRouter.post('/payroll/runs/:id/slips/:slipId/adjust-decision', requirePerm('accounting.payroll.approve'), ah(async (req, res) => {
  const b = parse(z.object({ accept: z.boolean(), reason: z.string().trim().max(300).optional() }), req.body);
  await prisma.$transaction(async (tx) => {
    const s = await draftSlip(tx, req.params.id, req.params.slipId);
    const pa = s.pendingAdjust as { values?: z.infer<typeof slipEdit> } | null;
    if (!pa?.values) throw badRequest('لا يوجد تعديل بانتظار الاعتماد');
    if (b.accept) await applyEdit(tx, s.id, slipEdit.parse(pa.values));
    else await tx.payslip.update({ where: { id: s.id }, data: { pendingAdjust: Prisma.DbNull } });
    await audit(tx, req.ctx, { action: b.accept ? 'payroll.adjust_approve' : 'payroll.adjust_reject', entityType: 'payslip', entityId: s.id, summary: `${b.accept ? 'اعتماد' : 'رفض'} تعديل قسيمة راتب${b.reason ? ` — ${b.reason}` : ''}`, before: pa.values });
  });
  res.json(await loadRun(req.params.id));
}));

/** Waives (or restores) one line of a draft slip, with the reason; the line stays visible with its original amount. */
payrollRouter.post('/payroll/runs/:id/items/:itemId/waive', requirePerm('accounting.payroll.approve'), ah(async (req, res) => {
  const b = parse(z.object({ waived: z.boolean(), reason: z.string().trim().min(3, 'اكتب سبب الإعفاء').max(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const it = await tx.payslipItem.findUnique({ where: { id: req.params.itemId } });
    if (!it) throw notFound();
    const s = await draftSlip(tx, req.params.id, it.slipId);
    await tx.payslipItem.update({ where: { id: it.id }, data: { waived: b.waived, waiveReason: b.waived ? b.reason : null } });
    const items = await tx.payslipItem.findMany({ where: { slipId: s.id } });
    const t = totals(items);
    const n = netOf({ ...s, ...t });
    if (n.lt(0)) throw badRequest('صافي الراتب سالب');
    await tx.payslip.update({ where: { id: s.id }, data: { ...t, net: n } });
    await audit(tx, req.ctx, { action: b.waived ? 'payroll.item_waive' : 'payroll.item_restore', entityType: 'payslip_item', entityId: it.id, summary: `${b.waived ? 'إعفاء من' : 'إلغاء إعفاء'} ${it.kind} ${dateOnlyStr(it.date)} (${it.amount}) — ${b.reason}` });
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

payrollRouter.post('/payroll/runs/:id/approve', requirePerm('accounting.payroll.approve'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const r = await tx.payrollRun.findUnique({ where: { id: req.params.id } });
    if (!r || r.status !== 'DRAFT') throw badRequest('الكشف غير موجود أو معتمد');
    const waiting = await tx.payslip.count({ where: { runId: r.id, pendingAdjust: { not: Prisma.DbNull } } });
    if (waiting) throw badRequest(`يوجد ${waiting} تعديل على القسائم بانتظار الاعتماد؛ اعتمدها أو ارفضها أولاً`);
    await tx.payrollRun.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedById: req.ctx.userId } });
    await recover(tx, r.id, 1);
    await postDoc(tx, 'payroll', r.id);
    await audit(tx, req.ctx, { action: 'payroll.approve', entityType: 'payroll_run', entityId: r.id, summary: `اعتماد رواتب ${r.month}` });
  });
  res.json(await loadRun(req.params.id));
}));

payrollRouter.post('/payroll/runs/:id/reopen', requirePerm('accounting.payroll.approve'), ah(async (req, res) => {
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
