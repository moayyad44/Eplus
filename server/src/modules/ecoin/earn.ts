import type { Ctx } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { getSetting } from '../../lib/settings';
import { notifyUsers } from '../../lib/notify';
import { credit, expireDueLocked, lockWallet } from './wallet';

/**
 * E Coin earning: one award per issued invoice that contains lab tests (whatever their number), to the doctor
 * who ordered the tests. The lot is keyed by the invoice (unique), so it can never be awarded twice.
 */
export async function awardForInvoice(tx: Tx, ctx: Ctx | null, invoiceId: string) {
  const cfg = await getSetting('ecoin', tx);
  if (!cfg.enabled || cfg.coinsPerLabInvoice <= 0) return null;
  const inv = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { id: true, invoiceNumber: true, visitId: true, doctorId: true, issuedRecordedAt: true, items: { where: { category: 'LAB' }, select: { serviceId: true } } },
  });
  if (!inv.items.length) return null; // no lab test on this invoice
  if (await tx.eCoinLot.findUnique({ where: { invoiceId: inv.id } })) return null; // already awarded once

  // The ordering doctor: the doctor of the visit's lab orders that hold these tests (most tests wins),
  // otherwise the invoice's doctor.
  let doctorId: string | null = null;
  let activityAt: Date | undefined;
  if (inv.visitId) {
    const orders = await tx.labOrder.findMany({
      where: { visitId: inv.visitId, status: { not: 'CANCELLED' } },
      select: { doctorId: true, requestedAt: true, items: { select: { labTest: { select: { serviceId: true } } } } },
      orderBy: { requestedAt: 'asc' },
    });
    const services = new Set(inv.items.map((i) => i.serviceId));
    const score = new Map<string, { n: number; at: Date }>();
    for (const o of orders) {
      const n = o.items.filter((i) => i.labTest.serviceId && services.has(i.labTest.serviceId)).length;
      if (!n) continue;
      const s = score.get(o.doctorId) ?? { n: 0, at: o.requestedAt };
      score.set(o.doctorId, { n: s.n + n, at: s.at });
    }
    const best = [...score.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (best) { doctorId = best[0]; activityAt = best[1].at; }
    // Billed under a generic lab service: the visit's (first) lab order tells who ordered.
    else if (orders.length) { doctorId = orders[0].doctorId; activityAt = orders[0].requestedAt; }
  }
  doctorId ??= inv.doctorId;
  if (!doctorId) return null;
  const doctor = await tx.user.findUnique({ where: { id: doctorId }, select: { staffType: true } });
  if (doctor?.staffType !== 'DOCTOR') return null; // E Coin is for doctors only

  const { txn } = await credit(tx, doctorId, cfg.coinsPerLabInvoice, { source: 'LAB_INVOICE', invoiceId: inv.id, activityAt: activityAt ?? inv.issuedRecordedAt ?? new Date() }, {
    type: 'EARN', invoiceId: inv.id, reason: `فاتورة ${inv.invoiceNumber} تحتوي تحاليل مخبرية`, createdById: ctx?.userId ?? null,
  });
  await notifyUsers([doctorId], {
    type: 'ECOIN', title: `حصلت على ${cfg.coinsPerLabInvoice} E Coin`, body: `مقابل التحاليل في الفاتورة ${inv.invoiceNumber}`, link: '/ecoin', dedupeKey: `ecoin-earn:${inv.id}`,
  }, tx);
  return txn;
}

/**
 * Invoice cancelled: the coins it earned are taken back — only what is still in that lot. Coins already spent
 * or expired are not taken from other lots (the balance never goes negative); the ledger keeps the full story.
 */
export async function clawbackForInvoice(tx: Tx, ctx: Ctx | null, invoiceId: string, reason: string) {
  const lot = await tx.eCoinLot.findUnique({ where: { invoiceId } });
  if (!lot) return null;
  await expireDueLocked(tx, lot.userId);
  const before = await lockWallet(tx, lot.userId);
  const fresh = await tx.eCoinLot.findUniqueOrThrow({ where: { id: lot.id } });
  const take = Math.min(fresh.remaining, before);
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { invoiceNumber: true } });
  const txn = await tx.eCoinTxn.create({
    data: {
      userId: lot.userId, type: 'CLAWBACK', amount: -take, balanceBefore: before, balanceAfter: before - take, lotId: lot.id, invoiceId,
      reason: `إلغاء الفاتورة ${inv?.invoiceNumber ?? ''}: ${reason}${take < lot.amount ? ` — استُرجع ${take} من ${lot.amount} (الباقي صُرف أو انتهت صلاحيته)` : ''}`,
      createdById: ctx?.userId ?? null,
    },
  });
  if (take > 0) {
    await tx.eCoinLot.update({ where: { id: lot.id }, data: { remaining: fresh.remaining - take } });
    await tx.eCoinLotUse.create({ data: { txnId: txn.id, lotId: lot.id, amount: take } });
    await tx.eCoinWallet.update({ where: { userId: lot.userId }, data: { balance: before - take } });
  }
  return txn;
}
