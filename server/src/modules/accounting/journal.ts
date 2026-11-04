import { Prisma, type JournalType } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import type { Db, Tx } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { nextCounter, pad } from '../../lib/counters';
import { D, r3 } from '../../lib/money';

/**
 * The journal engine of EmergencyPlus Accounting. Every change of the books goes through here:
 * - an entry is balanced (checked here, and again by the database at commit);
 * - saving with the right to approve (or when no approval is required) posts it at once — there is no
 *   separate «post» step; it then counts in the ledger and every report;
 * - a posted entry can still be edited or deleted by an authorised user; each version is kept
 *   (who, when, what changed) so nothing of the original is lost;
 * - nothing is written into a closed period.
 */

export interface LineInput {
  accountId: string;
  debit?: number | string | Prisma.Decimal | null;
  credit?: number | string | Prisma.Decimal | null;
  description?: string | null;
  partyType?: string | null;
  partyId?: string | null;
  partyName?: string | null;
  doctorId?: string | null;
}
export interface EntryInput {
  date: string; // YYYY-MM-DD
  type?: JournalType;
  description: string;
  reference?: string | null;
  lines: LineInput[];
}

export const dayOf = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
export const dayStr = (d: Date) => d.toISOString().slice(0, 10);

const entryInclude = { lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { id: true, code: true, name: true } } } } } satisfies Prisma.JournalEntryInclude;
type EntryFull = Prisma.JournalEntryGetPayload<{ include: typeof entryInclude }>;

/** Lines cleaned and checked: each one side only, real (leaf, active) accounts, debits = credits. */
export async function checkLines(db: Db, lines: LineInput[]) {
  if (lines.length < 2) throw badRequest('القيد يحتاج سطرين على الأقل (مدين ودائن)');
  const clean = lines.map((l, i) => {
    const debit = r3(D(l.debit)), credit = r3(D(l.credit));
    if (debit.lt(0) || credit.lt(0)) throw badRequest(`السطر ${i + 1}: المبالغ لا تكون سالبة`);
    if (debit.gt(0) === credit.gt(0)) throw badRequest(`السطر ${i + 1}: أدخل مبلغاً في المدين أو في الدائن (واحد فقط)`);
    return { ...l, debit, credit, lineNo: i + 1 };
  });
  const ids = [...new Set(clean.map((l) => l.accountId))];
  const accounts = await db.account.findMany({ where: { id: { in: ids } } });
  for (const l of clean) {
    const a = accounts.find((x) => x.id === l.accountId);
    if (!a) throw badRequest(`السطر ${l.lineNo}: الحساب غير موجود`);
    if (a.isGroup) throw badRequest(`السطر ${l.lineNo}: «${a.name}» حساب رئيسي؛ اختر أحد حساباته الفرعية`);
    if (!a.isActive) throw badRequest(`السطر ${l.lineNo}: الحساب «${a.name}» موقوف`);
  }
  const debit = clean.reduce((t, l) => t.add(l.debit), D(0));
  const credit = clean.reduce((t, l) => t.add(l.credit), D(0));
  if (!debit.eq(credit)) throw badRequest(`القيد غير متوازن: المدين ${debit.toFixed(3)} والدائن ${credit.toFixed(3)} (الفرق ${debit.sub(credit).abs().toFixed(3)})`);
  if (debit.eq(0)) throw badRequest('قيمة القيد صفر');
  return { lines: clean, total: debit };
}

/** The date must fall in an open accounting period. */
export async function ensureOpenPeriod(db: Db, date: Date) {
  const p = await db.fiscalPeriod.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } }, orderBy: { startDate: 'desc' } });
  if (!p) throw badRequest(`لا توجد سنة مالية تشمل تاريخ ${dayStr(date)}. أنشئها من «السنوات والفترات المالية»`);
  if (p.status === 'CLOSED') throw badRequest(`الفترة ${p.name} مغلقة. أعد فتحها (بصلاحية) قبل التسجيل أو التعديل فيها`);
  return p;
}

const snapshot = (e: EntryFull) => ({
  number: e.number, date: dayStr(e.date), type: e.type, status: e.status, description: e.description, reference: e.reference,
  lines: e.lines.map((l) => ({ account: `${l.account.code} ${l.account.name}`, accountId: l.accountId, debit: D(l.debit).toNumber(), credit: D(l.credit).toNumber(), description: l.description, party: l.partyName })),
});

/** Field-by-field differences between two snapshots (for the history). */
function changesOf(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  const out: { field: string; from: unknown; to: unknown }[] = [];
  for (const k of ['date', 'type', 'status', 'description', 'reference'] as const) if (a[k] !== b[k]) out.push({ field: k, from: a[k], to: b[k] });
  if (JSON.stringify(a.lines) !== JSON.stringify(b.lines)) out.push({ field: 'lines', from: a.lines, to: b.lines });
  return out;
}

async function load(db: Db, id: string) {
  const e = await db.journalEntry.findUnique({ where: { id }, include: entryInclude });
  if (!e) throw notFound('القيد غير موجود');
  return e;
}

async function lock(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM acc_journal_entries WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw notFound('القيد غير موجود');
  return load(tx, id);
}

async function revision(tx: Tx, e: EntryFull, action: string, userId: string | null, changes?: unknown) {
  await tx.journalRevision.create({ data: { entryId: e.id, version: e.version, action, snapshot: snapshot(e) as never, changes: (changes ?? undefined) as never, userId } });
}

const lineRows = (lines: Awaited<ReturnType<typeof checkLines>>['lines']) => lines.map((l) => ({
  lineNo: l.lineNo, accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description || null,
  partyType: l.partyType || null, partyId: l.partyId || null, partyName: l.partyName || null, doctorId: l.doctorId || null,
}));

export interface CreateOpts { post: boolean; sourceType?: string; sourceId?: string; sourceKey?: string }

export async function createEntry(tx: Tx, ctx: Ctx | null, input: EntryInput, opts: CreateOpts) {
  const date = dayOf(input.date);
  if (!input.description?.trim()) throw badRequest('البيان مطلوب');
  const { lines, total } = await checkLines(tx, input.lines);
  if (opts.post) await ensureOpenPeriod(tx, date);
  if (opts.sourceKey && (await tx.journalEntry.findUnique({ where: { sourceKey: opts.sourceKey } }))) throw conflict('لهذه العملية قيد مسجل مسبقاً');
  const n = await nextCounter(tx, 'journal');
  const now = new Date();
  const e = await tx.journalEntry.create({
    data: {
      number: `JV-${pad(n, 6)}`, date, type: input.type ?? 'GENERAL', description: input.description.trim(), reference: input.reference || null,
      status: opts.post ? 'POSTED' : 'DRAFT', totalDebit: total, createdById: ctx?.userId ?? null,
      ...(opts.post && { postedById: ctx?.userId ?? null, postedAt: now }),
      sourceType: opts.sourceType ?? null, sourceId: opts.sourceId ?? null, sourceKey: opts.sourceKey ?? null,
      lines: { create: lineRows(lines) },
    },
    include: entryInclude,
  });
  await revision(tx, e, opts.post ? 'create_posted' : 'create', ctx?.userId ?? null);
  await audit(tx, ctx, { action: opts.post ? 'journal.create_posted' : 'journal.create', entityType: 'journal_entry', entityId: e.id, summary: `${e.number}: ${e.description} — ${total.toFixed(3)}`, after: snapshot(e) });
  return e;
}

/** Edit an entry (also after posting). Automatic entries change only through their source operation. */
export async function updateEntry(tx: Tx, ctx: Ctx | null, id: string, input: EntryInput, opts: { fromSource?: boolean } = {}) {
  const before = await lock(tx, id);
  if (before.status === 'DELETED') throw badRequest('القيد محذوف');
  if (before.sourceType && !opts.fromSource) throw badRequest('هذا القيد ناتج تلقائياً عن عملية في EmergencyPlus؛ عدّل العملية نفسها فيتحدّث القيد معها');
  const date = dayOf(input.date);
  if (before.status === 'POSTED') { await ensureOpenPeriod(tx, before.date); await ensureOpenPeriod(tx, date); }
  if (!input.description?.trim()) throw badRequest('البيان مطلوب');
  const { lines, total } = await checkLines(tx, input.lines);
  await tx.journalLine.deleteMany({ where: { entryId: id } });
  await tx.journalEntry.update({
    where: { id },
    data: { date, type: input.type ?? before.type, description: input.description.trim(), reference: input.reference || null, totalDebit: total, version: { increment: 1 }, updatedById: ctx?.userId ?? null, lines: { create: lineRows(lines) } },
  });
  const after = await load(tx, id);
  const changes = changesOf(snapshot(before), snapshot(after));
  if (!changes.length) return after;
  await revision(tx, after, opts.fromSource ? 'source_update' : 'update', ctx?.userId ?? null, changes);
  await audit(tx, ctx, { action: 'journal.update', entityType: 'journal_entry', entityId: id, summary: `${after.number}: تعديل (${changes.map((c) => c.field).join('، ')})`, before: snapshot(before), after: snapshot(after) });
  return after;
}

/** Approve a waiting entry: it is posted at once. */
export async function approveEntry(tx: Tx, ctx: Ctx, id: string) {
  const e = await lock(tx, id);
  if (e.status !== 'DRAFT') throw badRequest(e.status === 'POSTED' ? 'القيد معتمد ومرحّل مسبقاً' : 'القيد محذوف');
  await ensureOpenPeriod(tx, e.date);
  await checkLines(tx, e.lines.map((l) => ({ ...l })));
  await tx.journalEntry.update({ where: { id }, data: { status: 'POSTED', postedById: ctx.userId, postedAt: new Date(), version: { increment: 1 } } });
  const after = await load(tx, id);
  await revision(tx, after, 'approve', ctx.userId);
  await audit(tx, ctx, { action: 'journal.approve', entityType: 'journal_entry', entityId: id, summary: `${e.number}: اعتماد وترحيل` });
  return after;
}

/** Delete: the entry stops counting everywhere; it and all its versions stay in the history. */
export async function deleteEntry(tx: Tx, ctx: Ctx | null, id: string, opts: { fromSource?: boolean } = {}) {
  const e = await lock(tx, id);
  if (e.status === 'DELETED') return e;
  if (e.sourceType && !opts.fromSource) throw badRequest('هذا القيد ناتج عن عملية في EmergencyPlus؛ ألغِ العملية نفسها فيُلغى القيد معها');
  if (e.status === 'POSTED') await ensureOpenPeriod(tx, e.date);
  await tx.journalEntry.update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date(), deletedById: ctx?.userId ?? null, version: { increment: 1 } } });
  const after = await load(tx, id);
  await revision(tx, after, 'delete', ctx?.userId ?? null);
  await audit(tx, ctx, { action: 'journal.delete', entityType: 'journal_entry', entityId: id, summary: `${e.number}: حذف (${e.description})`, before: snapshot(e) });
  return after;
}
