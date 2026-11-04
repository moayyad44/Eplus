import { InventoryTxnType, Prisma } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { D } from '../../lib/money';
import { notifyPermission } from '../../lib/notify';
import { getSetting } from '../../lib/settings';
import { enqueue } from '../accounting/link';

/** Direction of each movement type. ADJUSTMENT/STOCK_COUNT accept a signed quantity. */
export const TXN_SIGN: Record<InventoryTxnType, 1 | -1 | 0> = {
  PURCHASE: 1, RECEIPT: 1, RETURN: 1, SALE_REVERSAL: 1,
  ISSUE: -1, CONSUMPTION: -1, SALE: -1,
  ADJUSTMENT: 0, STOCK_COUNT: 0,
  TRANSFER_OUT: -1, TRANSFER_IN: 1,
};

/** The warehouse to use: the one given (must be active), else the default one. */
export async function resolveWarehouse(tx: Tx, warehouseId?: string | null) {
  const w = warehouseId
    ? await tx.warehouse.findUnique({ where: { id: warehouseId } })
    : await tx.warehouse.findFirst({ where: { isDefault: true } });
  if (!w) throw badRequest(warehouseId ? 'المستودع غير موجود' : 'لا يوجد مستودع افتراضي');
  if (!w.isActive) throw badRequest(`المستودع "${w.name}" غير فعّال`);
  return w;
}

/** Warehouse used for stock sold through invoices (setting), else the default one. */
export async function saleWarehouse(tx: Tx) {
  const { saleWarehouseId } = await getSetting('inventory', tx);
  if (saleWarehouseId) {
    const w = await tx.warehouse.findUnique({ where: { id: saleWarehouseId } });
    if (w?.isActive) return w;
  }
  return resolveWarehouse(tx);
}

export interface MovementInput {
  itemId: string;
  type: InventoryTxnType;
  /** Positive magnitude for directional types, signed for ADJUSTMENT/STOCK_COUNT. */
  quantity: Prisma.Decimal.Value;
  /** Warehouse moved in/out of. Default: the default warehouse. */
  warehouseId?: string | null;
  unitCost?: Prisma.Decimal.Value | null;
  reason?: string | null;
  reference?: string | null;
  referenceType?: string;
  referenceId?: string;
  batchNumber?: string | null;
  expiryDate?: Date | null;
}

/**
 * The ONLY place where inventory quantity changes. Locks the item row (which serialises every change of that
 * item in every warehouse), updates the warehouse quantity and the item's total together, writes the movement
 * with both resulting balances, and refuses to go below zero in the warehouse.
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
  const wh = await resolveWarehouse(tx, m.warehouseId);
  const stock = await tx.warehouseStock.findUnique({ where: { warehouseId_itemId: { warehouseId: wh.id, itemId: item.id } } });
  const whBefore = D(stock?.quantity);
  const whBalance = whBefore.add(delta);
  if (whBalance.lt(0)) throw badRequest(`الكمية غير كافية من "${item.name}" في ${wh.name} (المتوفر ${whBefore.toNumber()})`);
  if (balance.lt(0)) throw badRequest(`الكمية غير كافية من "${item.name}" (المتوفر ${D(item.quantity).toNumber()})`);
  await tx.warehouseStock.upsert({
    where: { warehouseId_itemId: { warehouseId: wh.id, itemId: item.id } },
    create: { warehouseId: wh.id, itemId: item.id, quantity: whBalance },
    update: { quantity: whBalance },
  });

  const itemUpdate: Prisma.InventoryItemUpdateInput = { quantity: balance };
  if (m.type === 'PURCHASE' && m.unitCost != null) itemUpdate.purchasePrice = D(m.unitCost);
  if ((m.type === 'PURCHASE' || m.type === 'RECEIPT') && m.batchNumber) itemUpdate.batchNumber = m.batchNumber;
  if ((m.type === 'PURCHASE' || m.type === 'RECEIPT') && m.expiryDate) itemUpdate.expiryDate = m.expiryDate;
  await tx.inventoryItem.update({ where: { id: item.id }, data: itemUpdate });

  const txn = await tx.inventoryTransaction.create({
    data: {
      itemId: item.id, type: m.type, quantity: delta, balanceAfter: balance, warehouseId: wh.id, warehouseBalanceAfter: whBalance, unitCost: m.unitCost != null ? D(m.unitCost) : null,
      reason: m.reason ?? null, reference: m.reference ?? null, referenceType: m.referenceType, referenceId: m.referenceId,
      batchNumber: m.batchNumber ?? null, expiryDate: m.expiryDate ?? null, userId: ctx?.userId,
    },
  });
  if (['CONSUMPTION', 'ISSUE', 'RETURN', 'RECEIPT', 'ADJUSTMENT', 'STOCK_COUNT'].includes(m.type)) await enqueue(tx, 'inv-move', txn.id);
  await audit(tx, ctx, {
    action: 'inventory.movement', entityType: 'inventory_item', entityId: item.id,
    summary: `${item.name} (${wh.name}): ${m.type} ${delta.toNumber() > 0 ? '+' : ''}${delta.toNumber()} → ${whBalance.toNumber()} (الإجمالي ${balance.toNumber()})`,
    before: { quantity: D(item.quantity).toNumber(), warehouse: whBefore.toNumber() }, after: { quantity: balance.toNumber(), warehouse: whBalance.toNumber(), warehouseId: wh.id, type: m.type, reference: m.reference },
  });
  // A transfer moves stock between warehouses without changing the total: no low-stock alert.
  if (delta.lt(0) && m.type !== 'TRANSFER_OUT' && balance.lte(item.minQuantity) && D(item.quantity).gt(item.minQuantity)) {
    await notifyPermission('inventory.view', {
      type: 'LOW_STOCK', title: `انخفاض مخزون: ${item.name}`, body: `الكمية المتبقية ${balance.toNumber()}`,
      link: `/inventory/items/${item.id}`, dedupeKey: `low:${item.id}:${txn.id}`,
    }, tx);
  }
  return txn;
}
