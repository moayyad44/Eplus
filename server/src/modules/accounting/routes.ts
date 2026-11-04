import { Router } from 'express';
import { z } from 'zod';
import { JournalStatus, JournalType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { getSetting, settingSchemas } from '../../lib/settings';
import { can } from '../../auth/context';
import { NATURE_OF } from './chart';
import { approveEntry, createEntry, dayOf, dayStr, deleteEntry, updateEntry } from './journal';
import { accountBalances, accountStatement, balanceSheet, incomeStatement, parseDay, trialBalance } from './ledger';
import { openingRouter } from './opening';
import { treasuryRouter } from './treasury';
import { visaRouter } from './visa';
import { chequesRouter } from './cheques';
import { payrollRouter } from './payroll';
import { assetsRouter } from './assets';
import { analyticsRouter } from './analytics';
import { REVENUE_DEFAULT, ROLES, loadMapping, processPending, resyncFrom, retryFailed } from './link';

/** EmergencyPlus Accounting API. Every route needs `accounting.access` plus its own permission. */
export const accountingRouter = Router();
accountingRouter.use(requirePerm('accounting.access'));
accountingRouter.use(openingRouter);
accountingRouter.use(treasuryRouter);
accountingRouter.use(visaRouter);
accountingRouter.use(chequesRouter);
accountingRouter.use(payrollRouter);
accountingRouter.use(assetsRouter);
accountingRouter.use(analyticsRouter);

const today = () => dayOf(new Date().toLocaleDateString('en-CA'));
const monthStart = () => dayOf(`${new Date().toLocaleDateString('en-CA').slice(0, 7)}-01`);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');
const money = z.union([z.number(), z.string()]).optional().nullable();

// ───────────── Settings ─────────────

accountingRouter.get('/settings', ah(async (_req, res) => res.json(await getSetting('accounting'))));
accountingRouter.put('/settings', requirePerm('accounting.settings'), ah(async (req, res) => {
  const current = await getSetting('accounting');
  const value = settingSchemas.accounting.parse({ ...current, ...req.body });
  // Every mapped account must be a real, active sub-account.
  const mapped = [...Object.values(value.accountMap), ...Object.values(value.methodAccounts), ...Object.values(value.expenseAccounts), ...Object.values(value.revenueAccounts)];
  if (mapped.length) {
    const found = await prisma.account.findMany({ where: { id: { in: mapped } } });
    for (const id of new Set(mapped)) {
      const a = found.find((x) => x.id === id);
      if (!a) throw badRequest('أحد الحسابات المختارة غير موجود');
      if (a.isGroup) throw badRequest(`«${a.name}» حساب رئيسي؛ اختر حساباً فرعياً`);
      if (!a.isActive) throw badRequest(`الحساب «${a.name}» موقوف`);
    }
  }
  if (current.startDate && value.startDate !== current.startDate && (await prisma.journalEntry.count({ where: { sourceType: { not: null }, status: 'POSTED' } }))) {
    throw badRequest('بدأ الترحيل التلقائي بالفعل؛ لا يمكن تغيير تاريخ البدء');
  }
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({ where: { key: 'accounting' }, create: { key: 'accounting', value, updatedBy: req.ctx.userId }, update: { value, updatedBy: req.ctx.userId } });
    await audit(tx, req.ctx, { action: 'accounting.settings', entityType: 'setting', entityId: 'accounting', before: current, after: value });
  });
  // Starting (or a new start date): queue every operation from that day on.
  if (value.startDate && value.startDate !== current.startDate) { await resyncFrom(value.startDate); void processPending(); }
  res.json(value);
}));

// ───────────── Link with EmergencyPlus ─────────────

/** What the mapping screen needs: every role / method / category with the account it uses now. */
accountingRouter.get('/link/config', requirePerm('accounting.settings'), ah(async (_req, res) => {
  const [m, methods, cats] = await Promise.all([loadMapping(), prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } }), prisma.expenseCategory.findMany({ orderBy: { name: 'asc' } })]);
  const safe = (f: () => string) => { try { return f(); } catch { return null; } };
  res.json({
    roles: ROLES.map((k) => ({ key: k, accountId: safe(() => m.role(k)), custom: !!m.cfg.accountMap[k] })),
    methods: methods.map((x) => ({ id: x.id, code: x.code, name: x.name, isActive: x.isActive, accountId: safe(() => m.method(x.id)), custom: !!m.cfg.methodAccounts[x.id] })),
    expenses: cats.map((x) => ({ id: x.id, name: x.name, isActive: x.isActive, accountId: safe(() => m.expense(x.id)), custom: !!m.cfg.expenseAccounts[x.id] })),
    revenues: (Object.keys(REVENUE_DEFAULT) as (keyof typeof REVENUE_DEFAULT)[]).map((c) => ({ key: c, accountId: safe(() => m.revenue(c)), custom: !!m.cfg.revenueAccounts[c] })),
  });
}));

accountingRouter.get('/link', requireAnyPerm('accounting.settings', 'accounting.journal.view'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.enum(['PENDING', 'DONE', 'FAILED', 'SKIPPED']).optional(), kind: z.string().optional() }), req.query);
  const where: Prisma.AccountingEventWhereInput = { ...(q.status && { status: q.status }), ...(q.kind && { kind: q.kind }) };
  const [items, total, counts, cfg] = await Promise.all([
    prisma.accountingEvent.findMany({ where, orderBy: { queuedAt: 'desc' }, ...paginate(q) }),
    prisma.accountingEvent.count({ where }),
    prisma.accountingEvent.groupBy({ by: ['status'], _count: true }),
    getSetting('accounting'),
  ]);
  const entries = await prisma.journalEntry.findMany({ where: { id: { in: items.map((i) => i.entryId).filter(Boolean) as string[] } }, select: { id: true, number: true, status: true } });
  res.json({
    ...paged(items.map((i) => ({ ...i, entry: entries.find((e) => e.id === i.entryId) ?? null })), total, q),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])), startDate: cfg.startDate,
  });
}));

accountingRouter.post('/link/retry', requirePerm('accounting.settings'), ah(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(1000).optional() }), req.body);
  res.json(await retryFailed(ids));
}));

accountingRouter.post('/link/resync', requirePerm('accounting.settings'), ah(async (req, res) => {
  const cfg = await getSetting('accounting');
  if (!cfg.startDate) throw badRequest('حدّد تاريخ بدء المحاسبة أولاً');
  const queued = await resyncFrom(cfg.startDate);
  await audit(prisma, req.ctx, { action: 'accounting.resync', entityType: 'setting', entityId: 'accounting', summary: `إعادة فحص الربط منذ ${cfg.startDate}: ${queued} عملية` });
  const r = await processPending(5000);
  res.json({ queued, ...r });
}));

// ───────────── Chart of accounts ─────────────

accountingRouter.get('/accounts', requireAnyPerm('accounting.accounts.view', 'accounting.journal.view'), ah(async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional() }), req.query);
  const to = parseDay(q.to, today());
  const from = parseDay(q.from, dayOf(`${dayStr(to).slice(0, 4)}-01-01`));
  const [rows, used] = await Promise.all([
    accountBalances(from, to),
    prisma.journalLine.groupBy({ by: ['accountId'], _count: true }),
  ]);
  res.json(rows.map((r) => ({ ...r, lines: used.find((u) => u.accountId === r.id)?._count ?? 0 })));
}));

const accountBody = z.object({
  code: z.string().trim().min(1, 'رقم الحساب مطلوب').max(20).regex(/^[0-9A-Za-z.-]+$/, 'رقم الحساب: أرقام وأحرف إنجليزية فقط'),
  name: z.string().trim().min(2, 'اسم الحساب مطلوب').max(150),
  parentId: z.string().uuid().nullable().optional(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']).optional(),
  nature: z.enum(['DEBIT', 'CREDIT']).optional(),
  isGroup: z.boolean().optional(),
  description: nullableStr(500),
});

accountingRouter.post('/accounts', requirePerm('accounting.accounts.manage'), ah(async (req, res) => {
  const b = parse(accountBody, req.body);
  const a = await prisma.$transaction(async (tx) => {
    if (await tx.account.findUnique({ where: { code: b.code } })) throw badRequest('رقم الحساب مستخدم');
    const parent = b.parentId ? await tx.account.findUnique({ where: { id: b.parentId } }) : null;
    if (b.parentId && !parent) throw badRequest('الحساب الأب غير موجود');
    if (parent && !parent.isGroup) {
      // A leaf becoming a parent must not already carry entries (they would be hidden under a total).
      if (await tx.journalLine.count({ where: { accountId: parent.id } })) throw badRequest(`«${parent.name}» عليه قيود؛ لا يمكن جعله حساباً رئيسياً`);
      await tx.account.update({ where: { id: parent.id }, data: { isGroup: true } });
    }
    const type = parent?.type ?? b.type;
    if (!type) throw badRequest('اختر نوع الحساب');
    if (parent && b.type && b.type !== parent.type) throw badRequest('نوع الحساب الفرعي يتبع نوع الحساب الأب');
    const created = await tx.account.create({ data: { code: b.code, name: b.name, type, nature: b.nature ?? (parent?.type === type && parent.nature !== NATURE_OF[type] ? parent.nature : NATURE_OF[type]), parentId: parent?.id ?? null, isGroup: !!b.isGroup, description: b.description } });
    await audit(tx, req.ctx, { action: 'account.create', entityType: 'account', entityId: created.id, summary: `${created.code} ${created.name}`, after: created });
    return created;
  });
  res.status(201).json(a);
}));

accountingRouter.put('/accounts/:id', requirePerm('accounting.accounts.manage'), ah(async (req, res) => {
  const b = parse(accountBody.partial().extend({ isActive: z.boolean().optional() }), req.body);
  const a = await prisma.$transaction(async (tx) => {
    const before = await tx.account.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('الحساب غير موجود');
    const used = await tx.journalLine.count({ where: { accountId: before.id } });
    if (b.code && b.code !== before.code && (await tx.account.findUnique({ where: { code: b.code } }))) throw badRequest('رقم الحساب مستخدم');
    if (b.type && b.type !== before.type && (used || before.isSystem)) throw badRequest('لا يمكن تغيير نوع حساب عليه قيود أو حساب أساسي');
    if (b.nature && b.nature !== before.nature && used) throw badRequest('لا يمكن تغيير طبيعة حساب عليه قيود');
    if (b.isGroup !== undefined && b.isGroup !== before.isGroup) {
      if (b.isGroup && used) throw badRequest('عليه قيود؛ لا يمكن جعله حساباً رئيسياً');
      if (!b.isGroup && (await tx.account.count({ where: { parentId: before.id } }))) throw badRequest('له حسابات فرعية');
    }
    if (b.parentId !== undefined && b.parentId !== before.parentId && b.parentId) {
      const p = await tx.account.findUnique({ where: { id: b.parentId } });
      if (!p?.isGroup) throw badRequest('الحساب الأب يجب أن يكون حساباً رئيسياً');
      if (p.type !== (b.type ?? before.type)) throw badRequest('الحساب الأب من نوع مختلف');
      for (let cur: typeof p | null = p; cur; cur = cur.parentId ? await tx.account.findUnique({ where: { id: cur.parentId } }) : null) if (cur.id === before.id) throw badRequest('لا يمكن جعل الحساب تابعاً لأحد فروعه');
    }
    if (b.isActive === false && before.systemKey) throw badRequest('حساب أساسي تستخدمه القيود التلقائية؛ لا يمكن إيقافه');
    const updated = await tx.account.update({ where: { id: before.id }, data: b });
    await audit(tx, req.ctx, { action: 'account.update', entityType: 'account', entityId: before.id, summary: `${updated.code} ${updated.name}`, before, after: updated });
    return updated;
  });
  res.json(a);
}));

/** Only an account never used, without sub-accounts, and not a system one. Otherwise: stop it. */
accountingRouter.delete('/accounts/:id', requirePerm('accounting.accounts.manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const a = await tx.account.findUnique({ where: { id: req.params.id } });
    if (!a) throw notFound('الحساب غير موجود');
    if (a.isSystem) throw badRequest('حساب أساسي؛ يمكن تعديل اسمه لا حذفه');
    if (await tx.journalLine.count({ where: { accountId: a.id } })) throw badRequest('عليه قيود؛ أوقفه بدلاً من حذفه (يبقى تاريخه محفوظاً)');
    if (await tx.account.count({ where: { parentId: a.id } })) throw badRequest('له حسابات فرعية');
    await tx.account.delete({ where: { id: a.id } });
    await audit(tx, req.ctx, { action: 'account.delete', entityType: 'account', entityId: a.id, summary: `${a.code} ${a.name}`, before: a });
  });
  res.json({ ok: true });
}));

// ───────────── Journal entries ─────────────

const lineBody = z.object({
  accountId: z.string().uuid('اختر الحساب'), debit: money, credit: money, description: nullableStr(300),
  partyType: nullableStr(20), partyId: nullableStr(60), partyName: nullableStr(150), doctorId: z.string().uuid().nullable().optional(),
});
const entryBody = z.object({
  date: day, type: z.nativeEnum(JournalType).default('GENERAL'), description: z.string().trim().min(2, 'البيان مطلوب').max(500),
  reference: nullableStr(100), lines: z.array(lineBody).min(2, 'القيد يحتاج سطرين على الأقل').max(500),
  /** Reason for an edit: optional unless the settings require it. */
  reason: nullableStr(300),
});
const MANUAL_TYPES = new Set<JournalType>(['GENERAL', 'OPENING', 'ADJUSTMENT', 'CLOSING', 'EXPENSE', 'REVENUE', 'RECEIPT', 'PAYMENT', 'PAYROLL', 'PURCHASE', 'CHEQUE', 'BANK_RECONCILIATION', 'DEPRECIATION', 'CORRECTION']);

accountingRouter.get('/journal', requirePerm('accounting.journal.view'), ah(async (req, res) => {
  const q = parse(pageQuery.extend({
    from: day.optional(), to: day.optional(), type: z.nativeEnum(JournalType).optional(), status: z.nativeEnum(JournalStatus).optional(),
    accountId: z.string().uuid().optional(), source: z.enum(['manual', 'auto']).optional(), includeDeleted: z.enum(['true', 'false']).optional(),
  }), req.query);
  const where: Prisma.JournalEntryWhereInput = {
    ...(q.status ? { status: q.status } : q.includeDeleted === 'true' ? {} : { status: { not: 'DELETED' } }),
    ...((q.from || q.to) && { date: { ...(q.from && { gte: dayOf(q.from) }), ...(q.to && { lte: dayOf(q.to) }) } }),
    ...(q.type && { type: q.type }),
    ...(q.accountId && { lines: { some: { accountId: q.accountId } } }),
    ...(q.source === 'manual' && { sourceType: null }), ...(q.source === 'auto' && { sourceType: { not: null } }),
    ...(q.q && { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] }),
  };
  const [items, total, sum] = await Promise.all([
    prisma.journalEntry.findMany({ where, orderBy: [{ date: q.order }, { number: q.order }], ...paginate(q), include: { _count: { select: { lines: true } } } }),
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.aggregate({ where, _sum: { totalDebit: true } }),
  ]);
  const ids = [...new Set(items.flatMap((e) => [e.createdById, e.updatedById]).filter(Boolean) as string[])];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.fullName ?? null;
  res.json({ ...paged(items.map((e) => ({ ...e, date: dayStr(e.date), createdBy: name(e.createdById), updatedBy: name(e.updatedById) })), total, q), totalAmount: sum._sum.totalDebit ?? 0 });
}));

accountingRouter.get('/journal/:id', requirePerm('accounting.journal.view'), ah(async (req, res) => {
  const e = await prisma.journalEntry.findUnique({
    where: { id: req.params.id },
    include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { id: true, code: true, name: true } } } }, revisions: { orderBy: [{ createdAt: 'asc' }] } },
  });
  if (!e) throw notFound('القيد غير موجود');
  const ids = [...new Set([e.createdById, e.updatedById, e.postedById, e.deletedById, ...e.revisions.map((r) => r.userId)].filter(Boolean) as string[])];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.fullName ?? null;
  res.json({
    ...e, date: dayStr(e.date),
    createdBy: name(e.createdById), updatedBy: name(e.updatedById), postedBy: name(e.postedById), deletedBy: name(e.deletedById),
    revisions: e.revisions.map((r) => ({ ...r, user: name(r.userId) })),
  });
}));

/** Save = post, for whoever may approve (or when no approval is required). Others' entries wait for approval. */
accountingRouter.post('/journal', requirePerm('accounting.journal.create'), ah(async (req, res) => {
  const b = parse(entryBody, req.body);
  if (!MANUAL_TYPES.has(b.type)) throw badRequest('نوع قيد غير صالح');
  const { requireApproval } = await getSetting('accounting');
  const post = !requireApproval || can(req.ctx, 'accounting.journal.approve');
  const e = await prisma.$transaction((tx) => createEntry(tx, req.ctx, b, { post }));
  res.status(201).json({ id: e.id, number: e.number, status: e.status });
}));

accountingRouter.put('/journal/:id', requireAnyPerm('accounting.journal.create', 'accounting.journal.edit_posted'), ah(async (req, res) => {
  const b = parse(entryBody, req.body);
  const e = await prisma.$transaction(async (tx) => {
    const cur = await tx.journalEntry.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('القيد غير موجود');
    if (cur.status === 'POSTED' && !can(req.ctx, 'accounting.journal.edit_posted')) throw forbidden('تعديل القيود المرحّلة يحتاج صلاحية «تعديل القيود بعد ترحيلها»');
    if (cur.status === 'DRAFT' && cur.createdById !== req.ctx.userId && !can(req.ctx, 'accounting.journal.approve')) throw forbidden('لا يمكنك تعديل قيد أنشأه غيرك');
    if ((await getSetting('accounting', tx)).requireReason && !b.reason) throw badRequest('سبب التعديل مطلوب');
    return updateEntry(tx, req.ctx, cur.id, b, { reason: b.reason });
  });
  res.json({ id: e.id, number: e.number, status: e.status, version: e.version });
}));

accountingRouter.post('/journal/:id/approve', requirePerm('accounting.journal.approve'), ah(async (req, res) => {
  const e = await prisma.$transaction((tx) => approveEntry(tx, req.ctx, req.params.id));
  res.json({ id: e.id, status: e.status });
}));

accountingRouter.delete('/journal/:id', requirePerm('accounting.journal.delete'), ah(async (req, res) => {
  await prisma.$transaction((tx) => deleteEntry(tx, req.ctx, req.params.id));
  res.json({ ok: true });
}));

// ───────────── Reports ─────────────

const range = z.object({ from: day.optional(), to: day.optional() });
accountingRouter.get('/reports/trial-balance', requirePerm('accounting.reports.view'), ah(async (req, res) => {
  const q = parse(range, req.query);
  res.json(await trialBalance(parseDay(q.from, monthStart()), parseDay(q.to, today())));
}));
accountingRouter.get('/reports/income-statement', requirePerm('accounting.reports.view'), ah(async (req, res) => {
  const q = parse(range, req.query);
  res.json(await incomeStatement(parseDay(q.from, monthStart()), parseDay(q.to, today())));
}));
accountingRouter.get('/reports/balance-sheet', requirePerm('accounting.reports.view'), ah(async (req, res) => {
  const q = parse(z.object({ asOf: day.optional() }), req.query);
  res.json(await balanceSheet(parseDay(q.asOf, today())));
}));
accountingRouter.get('/reports/statement', requireAnyPerm('accounting.reports.view', 'accounting.journal.view'), ah(async (req, res) => {
  const q = parse(range.extend({ accountId: z.string().uuid('اختر الحساب'), partyId: z.string().optional() }), req.query);
  res.json(await accountStatement(q.accountId, parseDay(q.from, monthStart()), parseDay(q.to, today()), { partyId: q.partyId }));
}));

// ───────────── Fiscal years & periods ─────────────

accountingRouter.get('/fiscal-years', ah(async (_req, res) => {
  const years = await prisma.fiscalYear.findMany({ orderBy: { startDate: 'desc' }, include: { periods: { orderBy: { startDate: 'asc' } } } });
  const counts = await prisma.$queryRaw<{ id: string; n: bigint }[]>`
    SELECT p.id, COUNT(e.id) AS n FROM acc_fiscal_periods p LEFT JOIN acc_journal_entries e ON e.status = 'POSTED' AND e.date BETWEEN p."startDate" AND p."endDate" GROUP BY p.id`;
  res.json(years.map((y) => ({ ...y, startDate: dayStr(y.startDate), endDate: dayStr(y.endDate), periods: y.periods.map((p) => ({ ...p, startDate: dayStr(p.startDate), endDate: dayStr(p.endDate), entries: Number(counts.find((c) => c.id === p.id)?.n ?? 0) })) })));
}));

/** New fiscal year (monthly periods). Years never overlap. */
accountingRouter.post('/fiscal-years', requirePerm('accounting.periods.manage'), ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(60), startDate: day, endDate: day }), req.body);
  const start = dayOf(b.startDate), end = dayOf(b.endDate);
  if (end <= start) throw badRequest('تاريخ النهاية يجب أن يكون بعد البداية');
  if ((end.getTime() - start.getTime()) / 86_400_000 > 400) throw badRequest('السنة المالية لا تتجاوز 13 شهراً');
  const y = await prisma.$transaction(async (tx) => {
    if (await tx.fiscalYear.findFirst({ where: { startDate: { lte: end }, endDate: { gte: start } } })) throw badRequest('تتداخل مع سنة مالية موجودة');
    const periods: { name: string; startDate: Date; endDate: Date }[] = [];
    for (let s = start; s <= end;) {
      const monthEnd = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
      const e = monthEnd < end ? monthEnd : end;
      periods.push({ name: `${String(s.getUTCMonth() + 1).padStart(2, '0')}/${s.getUTCFullYear()}`, startDate: s, endDate: e });
      s = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate() + 1));
    }
    const created = await tx.fiscalYear.create({ data: { name: b.name, startDate: start, endDate: end, periods: { create: periods } } });
    await audit(tx, req.ctx, { action: 'fiscal_year.create', entityType: 'fiscal_year', entityId: created.id, summary: `${b.name}: ${b.startDate} → ${b.endDate}` });
    return created;
  });
  res.status(201).json(y);
}));

accountingRouter.post('/periods/:id/close', requirePerm('accounting.periods.manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const p = await tx.fiscalPeriod.findUnique({ where: { id: req.params.id } });
    if (!p) throw notFound('الفترة غير موجودة');
    if (p.status === 'CLOSED') throw badRequest('الفترة مغلقة مسبقاً');
    const waiting = await tx.journalEntry.count({ where: { status: 'DRAFT', date: { gte: p.startDate, lte: p.endDate } } });
    if (waiting) throw badRequest(`في الفترة ${waiting} قيد بانتظار الاعتماد؛ اعتمدها أو احذفها قبل الإغلاق`);
    await tx.fiscalPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: req.ctx.userId } });
    await audit(tx, req.ctx, { action: 'fiscal_period.close', entityType: 'fiscal_period', entityId: p.id, summary: `إغلاق الفترة ${p.name}` });
  });
  res.json({ ok: true });
}));

accountingRouter.post('/periods/:id/reopen', requirePerm('accounting.periods.reopen'), ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'سبب إعادة الفتح مطلوب').max(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const p = await tx.fiscalPeriod.findUnique({ where: { id: req.params.id }, include: { fiscalYear: true } });
    if (!p) throw notFound('الفترة غير موجودة');
    if (p.status === 'OPEN') throw badRequest('الفترة مفتوحة');
    if (p.fiscalYear.status === 'CLOSED') throw badRequest('السنة المالية مقفلة');
    await tx.fiscalPeriod.update({ where: { id: p.id }, data: { status: 'OPEN', reopenedAt: new Date(), reopenedById: req.ctx.userId, reopenReason: reason } });
    await audit(tx, req.ctx, { action: 'fiscal_period.reopen', entityType: 'fiscal_period', entityId: p.id, summary: `إعادة فتح الفترة ${p.name}: ${reason}` });
  });
  res.json({ ok: true });
}));
