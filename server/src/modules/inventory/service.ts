import { InventoryTxnType, Prisma } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { D } from '../../lib/money';
import { notifyPermission } from '../../lib/notify';

/** Direction of each movement type. ADJUSTMENT/STOCK_COUNT accept a signed quantity. */
export const TXN_SIGN: Record<InventoryTxnType, 1 | -1 | 0> = {
  PURCHASE: 1, RECEIPT: 1, RETURN: 1, SALE_REVERSAL: 1,
  ISSUE: -1, CONSUMPTION: -1, SALE: -1,
  ADJUSTMENT: 0, STOCK_COUNT: 0,
};

export interface MovementInput {
  itemId: string;
  type: InventoryTxnType;
  /** Positive magnitude for directional types, signed for ADJUSTMENT/STOCK_COUNT. */
  quantity: Prisma.Decimal.Value;
  unitCost?: Prisma.Decimal.Value | null;
  reason?: string | null;
  reference?: string | null;
  referenceType?: string;
  referenceId?: string;
  batchNumber?: string | null;
  expiryDate?: Date | null;
}

/**
 * The ONLY place where inventory quantity changes. Locks the item row, writes the movement
 * with the resulting balance, and refuses to go below zero.
 */
export async function recordMovement(tx: Tx, ctx: Ctx | null, m: MovementInput) {
  const rows = await tx.$queryRaw<{ id: string; quantity: Prisma.Decimal; name: string; minQuantity: Prisma.Decimal }[]>`
    SELECT id, quantity, name, "minQuantity" FROM inventory_items WHERE id = ${m.itemId} AND "deletedAt" IS NULL FOR UPDATE`;
  const item = rows[0];
  if (!item) throw notFound('الصنف غير موجود');
  const sign = TXN_SIGN[m.type];
  const magnitude = D(m.quantity);
  if (sign !== 0 && magnitude.lte(0)) throw badRequest('الكمية يجب أن تكون أكبر من صفر');
  if (sign === 0 && magnitude.eq(0)) throw badRequest('كمية التعديل لا يمكن أن تكون صفراً');
  const delta = sign === 0 ? magnitude : magnitude.mul(sign);
  const balance = D(item.quantity).add(delta);
  if (balance.lt(0)) throw badRequest(`الكمية غير كافية من "${item.name}" (المتوفر ${D(item.quantity).toNumber()})`);

  const itemUpdate: Prisma.InventoryItemUpdateInput = { quantity: balance };
  if (m.type === 'PURCHASE' && m.unitCost != null) itemUpdate.purchasePrice = D(m.unitCost);
  if ((m.type === 'PURCHASE' || m.type === 'RECEIPT') && m.batchNumber) itemUpdate.batchNumber = m.batchNumber;
  if ((m.type === 'PURCHASE' || m.type === 'RECEIPT') && m.expiryDate) itemUpdate.expiryDate = m.expiryDate;
  await tx.inventoryItem.update({ where: { id: item.id }, data: itemUpdate });

  const txn = await tx.inventoryTransaction.create({
    data: {
      itemId: item.id, type: m.type, quantity: delta, balanceAfter: balance, unitCost: m.unitCost != null ? D(m.unitCost) : null,
      reason: m.reason ?? null, reference: m.reference ?? null, referenceType: m.referenceType, referenceId: m.referenceId,
      batchNumber: m.batchNumber ?? null, expiryDate: m.expiryDate ?? null, userId: ctx?.userId,
    },
  });
  await audit(tx, ctx, {
    action: 'inventory.movement', entityType: 'inventory_item', entityId: item.id,
    summary: `${item.name}: ${m.type} ${delta.toNumber() > 0 ? '+' : ''}${delta.toNumber()} → ${balance.toNumber()}`,
    before: { quantity: D(item.quantity).toNumber() }, after: { quantity: balance.toNumber(), type: m.type, reference: m.reference },
  });
  if (delta.lt(0) && balance.lte(item.minQuantity) && D(item.quantity).gt(item.minQuantity)) {
    await notifyPermission('inventory.view', {
      type: 'LOW_STOCK', title: `انخفاض مخزون: ${item.name}`, body: `الكمية المتبقية ${balance.toNumber()}`,
      link: `/inventory/items/${item.id}`, dedupeKey: `low:${item.id}:${txn.id}`,
    }, tx);
  }
  return txn;
}
