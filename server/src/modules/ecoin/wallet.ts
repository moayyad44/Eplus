import type { ECoinSource, ECoinTxnType, Prisma } from '@prisma/client';
import type { Tx } from '../../lib/prisma';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict } from '../../lib/errors';
import { penaltyCoverage } from './penalty';
import { getSetting } from '../../lib/settings';
import { notifyUsers } from '../../lib/notify';
import { addDays } from '../../lib/dates';

/**
 * E Coin wallet engine. Every movement runs inside one database transaction with the wallet row locked
 * (SELECT … FOR UPDATE), so concurrent requests are serialised and the balance can never go negative
 * (also enforced by a CHECK constraint). Coins live in lots that expire on their own date; debits take the
 * soonest-to-expire coins first. Every movement writes an append-only ledger row with the balance before/after.
 */

export interface TxnInput {
  type: ECoinTxnType;
  reason?: string | null;
  invoiceId?: string | null;
  assignmentId?: string | null;
  reversalOfId?: string | null;
  idempotencyKey?: string | null;
  meta?: Prisma.InputJsonValue;
  createdById?: string | null;
}

/** Locks (creating if needed) the wallet of a user for the rest of the transaction. */
export async function lockWallet(tx: Tx, userId: string) {
  await tx.$executeRaw`INSERT INTO "ecoin_wallets" ("userId", "balance", "updatedAt") VALUES (${userId}, 0, now()) ON CONFLICT ("userId") DO NOTHING`;
  const rows = await tx.$queryRaw<{ balance: number }[]>`SELECT "balance" FROM "ecoin_wallets" WHERE "userId" = ${userId} FOR UPDATE`;
  return Number(rows[0].balance);
}

async function setBalance(tx: Tx, userId: string, balance: number) {
  await tx.eCoinWallet.update({ where: { userId }, data: { balance } });
}

/** Expires the user's lots that are past their date (wallet must be locked). Returns the coins expired. */
export async function expireDueLocked(tx: Tx, userId: string, now = new Date()) {
  const lots = await tx.eCoinLot.findMany({ where: { userId, remaining: { gt: 0 }, expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' } });
  if (!lots.length) return 0;
  let balance = await lockWallet(tx, userId);
  let total = 0;
  for (const lot of lots) {
    const before = balance;
    balance -= lot.remaining;
    total += lot.remaining;
    await tx.eCoinLot.update({ where: { id: lot.id }, data: { remaining: 0, expiredAt: now } });
    const txn = await tx.eCoinTxn.create({
      data: {
        userId, type: 'EXPIRE', amount: -lot.remaining, balanceBefore: before, balanceAfter: balance, lotId: lot.id, invoiceId: lot.invoiceId,
        reason: `انتهاء صلاحية ${lot.remaining} E Coin مكتسبة في ${lot.earnedAt.toISOString().slice(0, 10)}`,
      },
    });
    await tx.eCoinLotUse.create({ data: { txnId: txn.id, lotId: lot.id, amount: lot.remaining } });
  }
  await setBalance(tx, userId, balance);
  return total;
}

/** Adds coins as a new lot. */
export async function credit(tx: Tx, userId: string, amount: number, lot: { source: ECoinSource; invoiceId?: string | null; activityAt?: Date; expiresAt?: Date }, t: TxnInput) {
  if (!(amount > 0)) throw badRequest('عدد العملات يجب أن يكون أكبر من صفر');
  const before = await lockWallet(tx, userId);
  const now = new Date();
  const { expiryDays } = await getSetting('ecoin', tx);
  const row = await tx.eCoinLot.create({
    data: { userId, source: lot.source, amount, remaining: amount, earnedAt: now, activityAt: lot.activityAt ?? now, expiresAt: lot.expiresAt ?? addDays(now, expiryDays), invoiceId: lot.invoiceId ?? null },
  });
  const after = before + amount;
  const txn = await tx.eCoinTxn.create({
    data: {
      userId, type: t.type, amount, balanceBefore: before, balanceAfter: after, lotId: row.id, invoiceId: t.invoiceId ?? lot.invoiceId ?? null,
      assignmentId: t.assignmentId ?? null, reversalOfId: t.reversalOfId ?? null, idempotencyKey: t.idempotencyKey ?? null,
      reason: t.reason ?? null, meta: t.meta, createdById: t.createdById ?? null,
    },
  });
  await tx.eCoinLotUse.create({ data: { txnId: txn.id, lotId: row.id, amount: -amount } });
  await setBalance(tx, userId, after);
  return { txn, lot: row };
}

/** Takes coins, soonest-to-expire first. Refuses (never goes negative) when the balance is short. */
export async function debit(tx: Tx, userId: string, amount: number, t: TxnInput) {
  if (amount < 0) throw badRequest('مبلغ غير صالح');
  await expireDueLocked(tx, userId);
  const before = await lockWallet(tx, userId);
  if (before < amount) throw conflict(`رصيدك من E Coin غير كافٍ: المطلوب ${amount} والمتاح ${before}`);
  const txn = await tx.eCoinTxn.create({
    data: {
      userId, type: t.type, amount: -amount, balanceBefore: before, balanceAfter: before - amount, invoiceId: t.invoiceId ?? null,
      assignmentId: t.assignmentId ?? null, reversalOfId: t.reversalOfId ?? null, idempotencyKey: t.idempotencyKey ?? null,
      reason: t.reason ?? null, meta: t.meta, createdById: t.createdById ?? null,
    },
  });
  let left = amount;
  if (left > 0) {
    const lots = await tx.eCoinLot.findMany({ where: { userId, remaining: { gt: 0 }, expiresAt: { gt: new Date() } }, orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }] });
    for (const lot of lots) {
      if (!left) break;
      const take = Math.min(lot.remaining, left);
      await tx.eCoinLot.update({ where: { id: lot.id }, data: { remaining: lot.remaining - take } });
      await tx.eCoinLotUse.create({ data: { txnId: txn.id, lotId: lot.id, amount: take } });
      left -= take;
    }
    // The balance always equals the unexpired lots; a mismatch means corrupted data — stop rather than guess.
    if (left) throw conflict('رصيد المحفظة لا يطابق العملات المتاحة. تواصل مع الإدارة');
  }
  await setBalance(tx, userId, before - amount);
  return txn;
}

/** Gives coins back to the exact lots a debit used (those still valid); the rest goes to a fresh refund lot. */
export async function refundDebit(tx: Tx, original: { id: string; userId: string; amount: number }, t: TxnInput) {
  const amount = -original.amount;
  if (amount <= 0) throw badRequest('هذه العملية ليست خصماً');
  const before = await lockWallet(tx, original.userId);
  const txn = await tx.eCoinTxn.create({
    data: {
      userId: original.userId, type: t.type, amount, balanceBefore: before, balanceAfter: before + amount, assignmentId: t.assignmentId ?? null,
      reversalOfId: t.reversalOfId ?? null, reason: t.reason ?? null, meta: t.meta, createdById: t.createdById ?? null,
    },
  });
  const uses = await tx.eCoinLotUse.findMany({ where: { txnId: original.id, amount: { gt: 0 } } });
  let left = amount;
  const now = new Date();
  for (const u of uses) {
    const lot = await tx.eCoinLot.findUniqueOrThrow({ where: { id: u.lotId } });
    if (lot.expiresAt <= now || lot.expiredAt) continue;
    const back = Math.min(u.amount, lot.amount - lot.remaining, left);
    if (back <= 0) continue;
    await tx.eCoinLot.update({ where: { id: lot.id }, data: { remaining: lot.remaining + back } });
    await tx.eCoinLotUse.create({ data: { txnId: txn.id, lotId: lot.id, amount: -back } });
    left -= back;
  }
  if (left > 0) {
    const { expiryDays } = await getSetting('ecoin', tx);
    const lot = await tx.eCoinLot.create({ data: { userId: original.userId, source: 'REFUND', amount: left, remaining: left, expiresAt: addDays(now, expiryDays) } });
    await tx.eCoinLotUse.create({ data: { txnId: txn.id, lotId: lot.id, amount: -left } });
  }
  await setBalance(tx, original.userId, before + amount);
  return txn;
}

/** Current wallet figures (expiring due lots first, so what is shown is exact). */
export async function walletSummary(userId: string) {
  await prisma.$transaction(async (tx) => { await expireDueLocked(tx, userId); }).catch(() => undefined);
  const { expiryWarnDays } = await getSetting('ecoin');
  const now = new Date();
  const [wallet, sums, expiring, penalty] = await Promise.all([
    prisma.eCoinWallet.findUnique({ where: { userId } }),
    prisma.eCoinTxn.groupBy({ by: ['type'], where: { userId }, _sum: { amount: true } }),
    prisma.eCoinLot.findMany({ where: { userId, remaining: { gt: 0 }, expiresAt: { gt: now, lte: addDays(now, expiryWarnDays) } }, orderBy: { expiresAt: 'asc' }, select: { id: true, remaining: true, expiresAt: true, earnedAt: true, invoiceId: true } }),
    prisma.eCoinPenalty.findFirst({ where: { userId, status: 'ACTIVE' }, orderBy: { triggeredAt: 'desc' } }),
  ]);
  const sum = (t: ECoinTxnType) => sums.find((s) => s.type === t)?._sum.amount ?? 0;
  return {
    balance: wallet?.balance ?? 0,
    earned: sum('EARN') + Math.max(0, sum('ADJUST')),
    earnedFromInvoices: sum('EARN'),
    spentOnPurchases: -sum('PURCHASE'),
    spentOnSecuring: -sum('SECURE'),
    expired: -sum('EXPIRE'),
    clawedBack: -sum('CLAWBACK'),
    adjustments: sum('ADJUST'),
    reversals: sum('REVERSAL'),
    expiringSoon: expiring,
    expiryWarnDays,
    penalty: penalty && { ...penalty, usesLeft: Math.max(0, (await penaltyCoverage(prisma, penalty, now)).usesLeft) },
  };
}

/** Background: expire every due lot of every user, and warn about coins expiring soon (once per lot). */
export async function processExpiry(now = new Date()) {
  const users = await prisma.eCoinLot.findMany({ where: { remaining: { gt: 0 }, expiresAt: { lte: now } }, distinct: ['userId'], select: { userId: true } });
  for (const { userId } of users) {
    const n = await prisma.$transaction((tx) => expireDueLocked(tx, userId, now));
    if (n > 0) await notifyUsers([userId], { type: 'ECOIN', title: `انتهت صلاحية ${n} E Coin`, body: 'انتهت مدة صلاحيتها (30 يوماً من تاريخ الاكتساب أو حسب الإعدادات)', link: '/ecoin', dedupeKey: `ecoin-exp:${userId}:${now.toISOString().slice(0, 13)}` });
  }
  const { expiryWarnDays, enabled } = await getSetting('ecoin');
  if (!enabled || expiryWarnDays <= 0) return;
  const soon = await prisma.eCoinLot.findMany({ where: { remaining: { gt: 0 }, warnedAt: null, expiresAt: { gt: now, lte: addDays(now, expiryWarnDays) } } });
  for (const lot of soon) {
    await notifyUsers([lot.userId], {
      type: 'ECOIN', title: `${lot.remaining} E Coin تنتهي قريباً`, body: `تنتهي صلاحيتها في ${lot.expiresAt.toISOString().slice(0, 10)}. استخدمها قبل ذلك`, link: '/ecoin', dedupeKey: `ecoin-warn:${lot.id}`,
    });
    await prisma.eCoinLot.update({ where: { id: lot.id }, data: { warnedAt: now } });
  }
}
