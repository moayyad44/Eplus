import { Prisma, type Account } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/errors';
import { D } from '../../lib/money';
import { dayOf, dayStr } from './journal';

/**
 * Balances come straight from the posted lines (no stored totals that could drift): an edit or a
 * deletion of an entry shows in every report at once. Revenue and expense accounts start each fiscal
 * year at zero; the others carry their balance forward.
 */

const PL = new Set(['REVENUE', 'EXPENSE']);
const sign = (a: Pick<Account, 'nature'>) => (a.nature === 'DEBIT' ? 1 : -1);

/** Start of the fiscal year that contains a day (or the day itself if none). */
export async function yearStartOf(day: Date) {
  const y = await prisma.fiscalYear.findFirst({ where: { startDate: { lte: day }, endDate: { gte: day } } });
  return y?.startDate ?? day;
}

export interface BalanceRow { id: string; code: string; name: string; type: string; nature: string; parentId: string | null; isGroup: boolean; isActive: boolean; systemKey: string | null; level: number; opening: number; debit: number; credit: number; closing: number }

/** Every account with opening / period movements / closing (natural side positive); groups total their children. */
export async function accountBalances(from: Date, to: Date): Promise<BalanceRow[]> {
  const ys = await yearStartOf(from);
  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({ orderBy: { code: 'asc' } }),
    prisma.$queryRaw<{ accountId: string; before_all: Prisma.Decimal; before_year: Prisma.Decimal; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
      SELECT l."accountId",
        SUM(CASE WHEN e.date < ${from} THEN l.debit - l.credit ELSE 0 END) AS before_all,
        SUM(CASE WHEN e.date < ${from} AND e.date >= ${ys} THEN l.debit - l.credit ELSE 0 END) AS before_year,
        SUM(CASE WHEN e.date >= ${from} THEN l.debit ELSE 0 END) AS debit,
        SUM(CASE WHEN e.date >= ${from} THEN l.credit ELSE 0 END) AS credit
      FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId"
      WHERE e.status = 'POSTED' AND e.date <= ${to}
      GROUP BY l."accountId"`,
  ]);
  const raw = new Map<string, { net0: Prisma.Decimal; dr: Prisma.Decimal; cr: Prisma.Decimal }>();
  for (const a of accounts) {
    const s = sums.find((x) => x.accountId === a.id);
    raw.set(a.id, { net0: D(PL.has(a.type) ? s?.before_year : s?.before_all), dr: D(s?.debit), cr: D(s?.credit) });
  }
  // Revenues and expenses of earlier years start each year at zero; a result not (yet) closed by a closing entry
  // belongs to retained earnings, so the opening balances stay balanced.
  const carried = accounts.filter((a) => PL.has(a.type)).reduce((t, a) => { const s = sums.find((x) => x.accountId === a.id); return t.add(D(s?.before_all).sub(D(s?.before_year))); }, D(0));
  const re = accounts.find((a) => a.systemKey === 'RETAINED_EARNINGS');
  if (re && !carried.eq(0)) raw.get(re.id)!.net0 = raw.get(re.id)!.net0.add(carried);
  // Roll leaf amounts up to every ancestor (debit-positive), then express each row on its own natural side.
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const agg = new Map(accounts.map((a) => [a.id, { net0: D(0), dr: D(0), cr: D(0) }]));
  for (const a of accounts) {
    const r = raw.get(a.id)!;
    if (r.net0.eq(0) && r.dr.eq(0) && r.cr.eq(0)) continue;
    for (let cur: Account | undefined = a; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      const t = agg.get(cur.id)!;
      t.net0 = t.net0.add(r.net0); t.dr = t.dr.add(r.dr); t.cr = t.cr.add(r.cr);
    }
  }
  const level = (a: Account): number => (a.parentId && byId.get(a.parentId) ? level(byId.get(a.parentId)!) + 1 : 0);
  return accounts.map((a) => {
    const t = agg.get(a.id)!;
    const s = sign(a);
    const opening = t.net0.mul(s), closing = t.net0.add(t.dr).sub(t.cr).mul(s);
    return {
      id: a.id, code: a.code, name: a.name, type: a.type, nature: a.nature, parentId: a.parentId, isGroup: a.isGroup, isActive: a.isActive, systemKey: a.systemKey,
      level: level(a), opening: opening.toNumber(), debit: t.dr.toNumber(), credit: t.cr.toNumber(), closing: closing.toNumber(),
    };
  });
}

/** Trial balance: leaf accounts with movement or balance, debit/credit columns, and the totals (which must agree). */
export async function trialBalance(from: Date, to: Date) {
  const rows = (await accountBalances(from, to)).filter((r) => !r.isGroup && (r.opening || r.debit || r.credit || r.closing));
  const sideOf = (v: number, nature: string) => (nature === 'DEBIT' ? v : -v); // to debit-positive
  const out = rows.map((r) => {
    const o = sideOf(r.opening, r.nature), c = sideOf(r.closing, r.nature);
    return { ...r, openingDebit: Math.max(o, 0), openingCredit: Math.max(-o, 0), closingDebit: Math.max(c, 0), closingCredit: Math.max(-c, 0) };
  });
  const sum = (k: keyof (typeof out)[number]) => Number(out.reduce((t, r) => t.add(r[k] as number), D(0)).toFixed(3));
  const totals = { openingDebit: sum('openingDebit'), openingCredit: sum('openingCredit'), debit: sum('debit'), credit: sum('credit'), closingDebit: sum('closingDebit'), closingCredit: sum('closingCredit') };
  return { rows: out, totals, balanced: totals.debit === totals.credit && totals.closingDebit === totals.closingCredit };
}

/** Income statement for a period: revenues − expenses. */
export async function incomeStatement(from: Date, to: Date) {
  const rows = await accountBalances(from, to);
  const pick = (type: string) => rows.filter((r) => r.type === type).map((r) => ({ ...r, amount: Number(D(r.credit).sub(r.debit).mul(type === 'REVENUE' ? 1 : -1).toFixed(3)) }));
  const revenue = pick('REVENUE'), expense = pick('EXPENSE');
  const top = (list: typeof revenue) => list.filter((r) => r.level === 0).reduce((t, r) => t.add(r.amount), D(0));
  const totalRevenue = top(revenue).toNumber(), totalExpense = top(expense).toNumber();
  return { revenue, expense, totalRevenue, totalExpense, netProfit: Number(D(totalRevenue).sub(totalExpense).toFixed(3)) };
}

/** Balance sheet at a date: assets = liabilities + equity (+ the profit not yet closed into equity). */
export async function balanceSheet(asOf: Date) {
  const ys = await yearStartOf(asOf);
  const rows = await accountBalances(new Date(Date.UTC(1900, 0, 1)), asOf);
  const pl = await incomeStatement(ys, asOf);
  const earlierPl = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT SUM(l.credit - l.debit) AS v FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId" JOIN acc_accounts a ON a.id = l."accountId"
    WHERE e.status = 'POSTED' AND e.date < ${ys} AND a.type IN ('REVENUE', 'EXPENSE')`;
  const take = (type: string) => rows.filter((r) => r.type === type && (r.closing || r.isGroup)).map((r) => ({ ...r, amount: r.closing }));
  const assets = take('ASSET'), liabilities = take('LIABILITY'), equity = take('EQUITY');
  const top = (list: typeof assets) => list.filter((r) => r.level === 0).reduce((t, r) => t.add(r.amount), D(0));
  const priorUnclosed = D(earlierPl[0]?.v).toNumber();
  const totalAssets = top(assets).toNumber(), totalLiabilities = top(liabilities).toNumber();
  const totalEquity = top(equity).add(pl.netProfit).add(priorUnclosed).toNumber();
  return {
    asOf: dayStr(asOf), assets, liabilities, equity, currentProfit: pl.netProfit, priorUnclosedProfit: priorUnclosed,
    totalAssets, totalLiabilities, totalEquity, balanced: D(totalAssets).eq(D(totalLiabilities).add(totalEquity)),
  };
}

/** Account statement (ledger): opening balance, each posted line with running balance, closing. Groups include their sub-accounts. */
export async function accountStatement(accountId: string, from: Date, to: Date, opts: { partyId?: string } = {}) {
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw notFound('الحساب غير موجود');
  if (to < from) throw badRequest('تاريخ النهاية قبل البداية');
  const all = await prisma.account.findMany({ select: { id: true, parentId: true } });
  const ids = new Set([acc.id]);
  for (let grew = true; grew;) { grew = false; for (const a of all) if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) { ids.add(a.id); grew = true; } }
  const start = PL.has(acc.type) ? await yearStartOf(from) : new Date(Date.UTC(1900, 0, 1));
  const party = opts.partyId ? Prisma.sql`AND l."partyId" = ${opts.partyId}` : Prisma.empty;
  const [op] = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT SUM(l.debit - l.credit) AS v FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId"
    WHERE e.status = 'POSTED' AND l."accountId" IN (${Prisma.join([...ids])}) AND e.date < ${from} AND e.date >= ${start} ${party}`;
  const lines = await prisma.journalLine.findMany({
    where: { accountId: { in: [...ids] }, ...(opts.partyId && { partyId: opts.partyId }), entry: { status: 'POSTED', date: { gte: from, lte: to } } },
    include: { entry: { select: { id: true, number: true, date: true, type: true, description: true, reference: true, sourceType: true, sourceId: true } }, account: { select: { code: true, name: true } } },
    orderBy: [{ entry: { date: 'asc' } }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
  });
  const s = sign(acc);
  let run = D(op?.v).mul(s);
  const opening = run.toNumber();
  const rows = lines.map((l) => {
    run = run.add(D(l.debit).sub(l.credit).mul(s));
    return {
      id: l.id, entryId: l.entry.id, number: l.entry.number, date: dayStr(l.entry.date), type: l.entry.type, description: l.description || l.entry.description,
      reference: l.entry.reference, sourceType: l.entry.sourceType, sourceId: l.entry.sourceId, account: `${l.account.code} ${l.account.name}`, party: l.partyName,
      debit: D(l.debit).toNumber(), credit: D(l.credit).toNumber(), balance: run.toNumber(),
    };
  });
  const debit = lines.reduce((t, l) => t.add(l.debit), D(0)).toNumber(), credit = lines.reduce((t, l) => t.add(l.credit), D(0)).toNumber();
  return { account: { id: acc.id, code: acc.code, name: acc.name, type: acc.type, nature: acc.nature, isGroup: acc.isGroup }, from: dayStr(from), to: dayStr(to), opening, debit, credit, closing: run.toNumber(), rows };
}

export const parseDay = (s: string | undefined, fallback: Date) => (s ? dayOf(s) : fallback);
