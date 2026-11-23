import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, nullableStr } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { D } from '../../lib/money';
import { dateOnlyStr } from '../../lib/dates';
import { createEntry, dayOf, deleteEntry } from './journal';
import { docNumber } from './common';
import { readTable, toAmount } from './xlsx';

/**
 * Bank reconciliation: the bank statement against the bank account's ledger lines.
 * Cleared lines are marked reconciled on approval; adjustment entries (bank charges, interest…) are created
 * only for the adjustments the user adds, and only when the reconciliation is approved.
 */
export const bankRecRouter = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const perm = requirePerm('accounting.reconcile');

async function bankOf(db: Tx | typeof prisma, treasuryId: string) {
  const t = await db.treasury.findUnique({ where: { id: treasuryId } });
  if (!t || t.kind !== 'BANK') throw badRequest('اختر حساباً بنكياً');
  return t;
}

/** Posted lines of the bank account up to a date that are not reconciled yet (amount: + into the bank, − out). */
async function openLines(db: Tx | typeof prisma, accountId: string, to: Date) {
  const lines = await db.journalLine.findMany({
    where: { accountId, reconciledAt: null, entry: { status: 'POSTED', date: { lte: to } } },
    include: { entry: { select: { number: true, date: true, description: true, reference: true } } }, orderBy: { entry: { date: 'asc' } },
  });
  return lines.map((l) => ({ id: l.id, date: dateOnlyStr(l.entry.date), number: l.entry.number, description: l.description || l.entry.description, reference: l.entry.reference, amount: D(l.debit).sub(l.credit).toNumber() }));
}

async function bookBalance(db: Tx | typeof prisma, accountId: string, to: Date) {
  const [r] = await db.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(l.debit - l.credit) v FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId" WHERE e.status = 'POSTED' AND e.date <= ${to} AND l."accountId" = ${accountId}`;
  return D(r?.v).toNumber();
}

const r3n = (v: number) => Number(v.toFixed(3));

/** statement = book + adjustments − lines not yet seen by the bank. */
function compute(book: number, open: { id: string; amount: number }[], cleared: Set<string>, adjustments: { amount: number }[], statement: number) {
  const outstanding = open.filter((l) => !cleared.has(l.id));
  const outIn = outstanding.filter((l) => l.amount > 0).reduce((t, l) => t + l.amount, 0);
  const outOut = outstanding.filter((l) => l.amount < 0).reduce((t, l) => t - l.amount, 0);
  const adj = adjustments.reduce((t, a) => t + a.amount, 0);
  const expected = book + adj - outIn + outOut;
  return { book: r3n(book), adjustments: r3n(adj), depositsInTransit: r3n(outIn), outstandingPayments: r3n(outOut), expectedStatement: r3n(expected), statement: r3n(statement), difference: r3n(statement - expected) };
}

bankRecRouter.get('/bank-recs', perm, ah(async (_req, res) => {
  const rows = await prisma.bankReconciliation.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  const ts = await prisma.treasury.findMany({ where: { id: { in: rows.map((r) => r.treasuryId) } }, select: { id: true, name: true } });
  res.json(rows.map((r) => ({ ...r, lines: undefined, summary: (r.lines as { summary?: unknown }).summary, statementDate: dateOnlyStr(r.statementDate), treasury: ts.find((t) => t.id === r.treasuryId)?.name })));
}));

/** What the books say for one bank account on a date: balance and the lines still waiting for the bank. */
bankRecRouter.get('/bank-recs/book', perm, ah(async (req, res) => {
  const q = parse(z.object({ treasuryId: z.string().uuid(), date: day }), req.query);
  const t = await bankOf(prisma, q.treasuryId);
  const to = dayOf(q.date);
  const last = await prisma.bankReconciliation.findFirst({ where: { treasuryId: t.id, status: 'APPROVED' }, orderBy: { statementDate: 'desc' } });
  res.json({ treasury: { id: t.id, name: t.name, bankName: t.bankName }, book: await bookBalance(prisma, t.accountId, to), lines: await openLines(prisma, t.accountId, to), lastApproved: last && { number: last.number, statementDate: dateOnlyStr(last.statementDate), statementBalance: D(last.statementBalance).toNumber() } });
}));

/** Reads a bank statement (xlsx / csv) and suggests which book lines each statement line clears. Nothing is saved. */
bankRecRouter.post('/bank-recs/match', perm, upload.single('file'), ah(async (req, res) => {
  const q = parse(z.object({ treasuryId: z.string().uuid(), date: day }), req.body);
  if (!req.file || !/\.(xlsx|csv)$/i.test(req.file.originalname)) throw badRequest('اختر ملف Excel (.xlsx) أو CSV');
  const t = await bankOf(prisma, q.treasuryId);
  const open = await openLines(prisma, t.accountId, dayOf(q.date));
  const rows = (await readTable(req.file.buffer, req.file.originalname)).sheets[0]?.rows ?? [];
  const hi = rows.findIndex((r) => r.some((c) => /مبلغ|مدين|دائن|سحب|إيداع|ايداع|amount|debit|credit|withdraw|deposit/i.test(String(c ?? ''))));
  if (hi < 0) throw badRequest('لم يُعثر على أعمدة المبالغ (المبلغ، أو مدين/دائن، أو سحب/إيداع)');
  const h = rows[hi].map((c) => String(c ?? '').trim());
  const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const ci = { date: col(/تاريخ|date/i), desc: col(/بيان|وصف|تفاصيل|desc|details|narr/i), ref: col(/مرجع|رقم|ref|cheque/i), amount: col(/^(المبلغ|مبلغ|amount)$/i), out: col(/مدين|سحب|debit|withdraw/i), inn: col(/دائن|إيداع|ايداع|credit|deposit/i) };
  const used = new Set<string>();
  const out = rows.slice(hi + 1).filter((r) => r.some((c) => c != null && c !== '')).map((r, i) => {
    let amount = NaN;
    if (ci.amount >= 0) amount = toAmount(r[ci.amount]);
    else { const a = ci.inn >= 0 ? toAmount(r[ci.inn]) : NaN, b = ci.out >= 0 ? toAmount(r[ci.out]) : NaN; amount = (Number.isNaN(a) ? 0 : a) - (Number.isNaN(b) ? 0 : b); }
    const date = ci.date >= 0 ? String(r[ci.date] ?? '').slice(0, 10) : '';
    const ref = ci.ref >= 0 ? String(r[ci.ref] ?? '').trim() : '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`).getTime() : NaN;
    const near = (l: (typeof open)[number]) => Number.isNaN(d) || Math.abs(new Date(`${l.date}T00:00:00Z`).getTime() - d) <= 7 * 86_400_000;
    let m = ref ? open.find((l) => !used.has(l.id) && l.reference && l.reference.trim() === ref && Math.abs(l.amount - amount) < 0.0005) : undefined;
    if (!m && !Number.isNaN(amount)) m = open.find((l) => !used.has(l.id) && Math.abs(l.amount - amount) < 0.0005 && near(l));
    if (m) used.add(m.id);
    return { line: hi + 2 + i, date, description: ci.desc >= 0 ? String(r[ci.desc] ?? '') : '', reference: ref || null, amount: Number.isNaN(amount) ? null : r3n(amount), lineId: m?.id ?? null, status: m ? 'MATCHED' : 'NOT_IN_BOOKS' };
  });
  res.json({ rows: out, bookOnly: open.filter((l) => !used.has(l.id)), totals: { lines: out.length, matched: out.filter((x) => x.lineId).length, notInBooks: out.filter((x) => !x.lineId).length } });
}));

const recBody = z.object({
  treasuryId: z.string().uuid('اختر الحساب البنكي'), statementDate: day, statementBalance: z.coerce.number(),
  clearedLineIds: z.array(z.string().uuid()).max(20_000),
  adjustments: z.array(z.object({ date: day, description: z.string().trim().min(2).max(200), amount: z.coerce.number().refine((v) => v !== 0, 'المبلغ لا يكون صفراً'), accountId: z.string().uuid('اختر الحساب المقابل') })).max(200).default([]),
  notes: nullableStr(500),
});

async function build(db: Tx | typeof prisma, b: z.infer<typeof recBody>) {
  const t = await bankOf(db, b.treasuryId);
  const to = dayOf(b.statementDate);
  const open = await openLines(db, t.accountId, to);
  const ids = new Set(open.map((l) => l.id));
  const bad = b.clearedLineIds.filter((id) => !ids.has(id));
  if (bad.length) throw badRequest('بعض الحركات المختارة مطابقة مسبقاً أو ليست على هذا الحساب أو بعد تاريخ الكشف');
  for (const a of b.adjustments) if (a.date > b.statementDate) throw badRequest('تاريخ التسوية بعد تاريخ كشف البنك');
  const summary = compute(await bookBalance(db, t.accountId, to), open, new Set(b.clearedLineIds), b.adjustments, b.statementBalance);
  return { t, summary, open };
}

/** Saves a reconciliation (pending). The difference is shown; approval needs it to be zero. */
bankRecRouter.post('/bank-recs', perm, ah(async (req, res) => {
  const b = parse(recBody, req.body);
  const r = await prisma.$transaction(async (tx) => {
    const { summary } = await build(tx, b);
    const rec = await tx.bankReconciliation.create({ data: {
      number: await docNumber(tx, 'BR'), treasuryId: b.treasuryId, statementDate: dayOf(b.statementDate), statementBalance: b.statementBalance, bookBalance: summary.book,
      lines: { cleared: b.clearedLineIds, adjustments: b.adjustments, summary } as never, notes: b.notes, createdById: req.ctx.userId,
    } });
    await audit(tx, req.ctx, { action: 'bank_rec.create', entityType: 'bank_reconciliation', entityId: rec.id, summary: `${rec.number}: فرق ${summary.difference}` });
    return rec;
  });
  res.status(201).json(await view(r.id));
}));

async function view(id: string) {
  const r = await prisma.bankReconciliation.findUnique({ where: { id } });
  if (!r) throw notFound('التسوية غير موجودة');
  const data = r.lines as { cleared: string[]; adjustments: unknown[]; summary: unknown; entries?: string[] };
  const lines = await prisma.journalLine.findMany({ where: { id: { in: data.cleared } }, include: { entry: { select: { number: true, date: true, description: true, reference: true } } } });
  const t = await prisma.treasury.findUnique({ where: { id: r.treasuryId }, select: { name: true, bankName: true } });
  return {
    ...r, statementDate: dateOnlyStr(r.statementDate), treasury: t, summary: data.summary, adjustments: data.adjustments, entries: data.entries ?? [],
    cleared: lines.map((l) => ({ id: l.id, date: dateOnlyStr(l.entry.date), number: l.entry.number, description: l.description || l.entry.description, reference: l.entry.reference, amount: D(l.debit).sub(l.credit).toNumber() })), lines: undefined,
  };
}
bankRecRouter.get('/bank-recs/:id', perm, ah(async (req, res) => res.json(await view(req.params.id))));

/** Approval: re-checks everything, creates the adjustment entries, marks the cleared lines reconciled. */
bankRecRouter.post('/bank-recs/:id/approve', perm, ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const r = await tx.bankReconciliation.findUnique({ where: { id: req.params.id } });
    if (!r || r.status !== 'PENDING') throw badRequest('التسوية غير موجودة أو ليست بانتظار الاعتماد');
    const data = r.lines as { cleared: string[]; adjustments: z.infer<typeof recBody>['adjustments'] };
    const { t, summary } = await build(tx, { treasuryId: r.treasuryId, statementDate: dateOnlyStr(r.statementDate), statementBalance: D(r.statementBalance).toNumber(), clearedLineIds: data.cleared, adjustments: data.adjustments, notes: null });
    if (Math.abs(summary.difference) >= 0.0005) throw badRequest(`لا يمكن الاعتماد: الفرق ${summary.difference.toFixed(3)} لا يساوي صفراً`);
    const entries: string[] = [];
    for (const [i, a] of data.adjustments.entries()) {
      const amt = Math.abs(a.amount);
      const e = await createEntry(tx, req.ctx, {
        date: a.date, type: 'BANK_RECONCILIATION', description: `تسوية بنكية ${r.number}: ${a.description}`, reference: r.number,
        lines: a.amount > 0 ? [{ accountId: t.accountId, debit: amt, credit: 0 }, { accountId: a.accountId, debit: 0, credit: amt }] : [{ accountId: a.accountId, debit: amt, credit: 0 }, { accountId: t.accountId, debit: 0, credit: amt }],
      }, { post: true, sourceType: 'bank-rec', sourceId: r.id, sourceKey: `bank-rec:${r.id}:${i}` });
      entries.push(e.id);
    }
    const adjLines = entries.length ? (await tx.journalLine.findMany({ where: { entryId: { in: entries }, accountId: t.accountId } })).map((l) => l.id) : [];
    const now = new Date();
    await tx.journalLine.updateMany({ where: { id: { in: [...data.cleared, ...adjLines] } }, data: { reconciledAt: now, reconId: r.id } });
    await tx.bankReconciliation.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedById: req.ctx.userId, approvedAt: now, bookBalance: summary.book, lines: { ...data, summary: { ...summary, difference: 0 }, entries } as never } });
    await audit(tx, req.ctx, { action: 'bank_rec.approve', entityType: 'bank_reconciliation', entityId: r.id, summary: `اعتماد ${r.number}: ${data.cleared.length} حركة، ${entries.length} قيد تسوية` });
  });
  res.json(await view(req.params.id));
}));

/** Cancels a reconciliation; an approved one gives its lines back (not reconciled) and removes its adjustment entries. */
bankRecRouter.post('/bank-recs/:id/cancel', perm, ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: nullableStr(300) }), req.body);
  await prisma.$transaction(async (tx) => {
    const r = await tx.bankReconciliation.findUnique({ where: { id: req.params.id } });
    if (!r || r.status === 'REJECTED') throw badRequest('التسوية غير موجودة أو ملغاة');
    if (r.status === 'APPROVED') {
      const later = await tx.bankReconciliation.findFirst({ where: { treasuryId: r.treasuryId, status: 'APPROVED', statementDate: { gt: r.statementDate } } });
      if (later) throw badRequest(`ألغِ التسوية الأحدث ${later.number} أولاً`);
      await tx.journalLine.updateMany({ where: { reconId: r.id }, data: { reconciledAt: null, reconId: null } });
      for (const id of (r.lines as { entries?: string[] }).entries ?? []) await deleteEntry(tx, req.ctx, id, { fromSource: true });
    }
    await tx.bankReconciliation.update({ where: { id: r.id }, data: { status: 'REJECTED', notes: [r.notes, reason && `إلغاء: ${reason}`].filter(Boolean).join(' — ') || null } });
    await audit(tx, req.ctx, { action: 'bank_rec.cancel', entityType: 'bank_reconciliation', entityId: r.id, summary: `إلغاء ${r.number}${reason ? `: ${reason}` : ''}` });
  });
  res.json(await view(req.params.id));
}));
