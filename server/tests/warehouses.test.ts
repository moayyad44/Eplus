import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, reception: Client, nurse: Client;
let main: { id: string }, side: { id: string };
const qtyIn = async (warehouseId: string, itemId: string) => Number((await prisma.warehouseStock.findUnique({ where: { warehouseId_itemId: { warehouseId, itemId } } }))?.quantity ?? 0);
const total = async (itemId: string) => Number((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).quantity);
let seq = 0;
const newItem = async (opening: number, warehouseId?: string) => {
  const r = await admin.post('/api/inventory/items', { name: `صنف مستودعات ${++seq}`, sku: `WH-T-${seq}-${Date.now() % 100000}`, openingQuantity: opening, purchasePrice: 2, ...(warehouseId && { openingWarehouseId: warehouseId }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};

beforeAll(async () => {
  [admin, reception, nurse] = await Promise.all([login('admin'), login('reception'), login('nurse.sara')]);
  main = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
});

describe('warehouses', () => {
  it('existing stock starts in the main (default) warehouse; every item total equals the sum of its warehouses', async () => {
    const w = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
    expect(w.code).toBe('MAIN');
    const bad = await prisma.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM inventory_items i LEFT JOIN (SELECT "itemId", SUM(quantity) q FROM warehouse_stock GROUP BY "itemId") s ON s."itemId" = i.id
      WHERE i.quantity <> COALESCE(s.q, 0)`;
    expect(bad).toEqual([]);
  });

  it('only inventory managers create warehouses; codes are unique', async () => {
    expect((await reception.post('/api/inventory/warehouses', { name: 'مستودع الطوارئ', code: 'ER' })).status).toBe(403);
    const r = await admin.post('/api/inventory/warehouses', { name: 'مستودع الطوارئ', code: 'er', location: 'الطابق الأرضي' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    side = r.body;
    expect(r.body.code).toBe('ER');
    expect((await admin.post('/api/inventory/warehouses', { name: 'آخر', code: 'ER' })).status).toBe(400);
    const list = (await admin.get('/api/inventory/warehouses')).body;
    expect(list.map((w: { code: string }) => w.code)).toEqual(expect.arrayContaining(['MAIN', 'ER']));
  });

  it('a transfer moves goods between warehouses; the total does not change; documented with a number', async () => {
    const a = await newItem(30), b = await newItem(5);
    const r = await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: side.id, notes: 'تزويد الطوارئ', items: [{ itemId: a, quantity: 12 }, { itemId: b, quantity: 5 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.transferNumber).toMatch(/^TR-\d{5}$/);
    expect([await qtyIn(main.id, a), await qtyIn(side.id, a), await total(a)]).toEqual([18, 12, 30]);
    expect([await qtyIn(main.id, b), await qtyIn(side.id, b), await total(b)]).toEqual([0, 5, 5]);
    const moves = await prisma.inventoryTransaction.findMany({ where: { referenceId: r.body.id }, orderBy: { type: 'asc' } });
    expect(moves.map((m) => [m.type, Number(m.quantity)]).sort()).toEqual([['TRANSFER_IN', 12], ['TRANSFER_IN', 5], ['TRANSFER_OUT', -12], ['TRANSFER_OUT', -5]].sort());
    const d = (await admin.get(`/api/inventory/transfers/${r.body.id}`)).body;
    expect([d.fromWarehouse.code, d.toWarehouse.code, d.items.length]).toEqual(['MAIN', 'ER', 2]);
    expect((await admin.get('/api/inventory/transfers')).body.items.some((x: { id: string }) => x.id === r.body.id)).toBe(true);
    // No low-stock alert for moving stock around (the total did not change).
    expect(await prisma.notification.count({ where: { type: 'LOW_STOCK', link: `/inventory/items/${b}` } })).toBe(0);
  });

  it('a transfer is all or nothing: one short line cancels the whole transfer', async () => {
    const a = await newItem(10), b = await newItem(2);
    const r = await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: side.id, items: [{ itemId: a, quantity: 4 }, { itemId: b, quantity: 3 }] });
    expect(r.status).toBe(400);
    expect(r.body.message ?? r.body.error?.message ?? JSON.stringify(r.body)).toContain('غير كافية');
    expect([await qtyIn(main.id, a), await qtyIn(side.id, a), await qtyIn(main.id, b)]).toEqual([10, 0, 2]);
    expect(await prisma.stockTransfer.count({ where: { items: { some: { itemId: a } } } })).toBe(0);
  });

  it('refuses the same warehouse, duplicate lines, and users without the transfer permission', async () => {
    const a = await newItem(3);
    expect((await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: main.id, items: [{ itemId: a, quantity: 1 }] })).status).toBe(400);
    expect((await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: side.id, items: [{ itemId: a, quantity: 1 }, { itemId: a, quantity: 1 }] })).status).toBe(400);
    expect((await nurse.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: side.id, items: [{ itemId: a, quantity: 1 }] })).status).toBe(403);
    expect(await qtyIn(main.id, a)).toBe(3);
  });

  it('two transfers of the same stock at the same moment: never below zero', async () => {
    const a = await newItem(5);
    const body = { fromWarehouseId: main.id, toWarehouseId: side.id, items: [{ itemId: a, quantity: 4 }] };
    const rs = await Promise.all([admin.post('/api/inventory/transfers', body), admin.post('/api/inventory/transfers', body)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 400]);
    expect([await qtyIn(main.id, a), await qtyIn(side.id, a), await total(a)]).toEqual([1, 4, 5]);
  });

  it('movements are per warehouse: a warehouse cannot give more than it holds even if the total is enough', async () => {
    const a = await newItem(10);
    expect((await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: side.id, items: [{ itemId: a, quantity: 3 }] })).status).toBe(201);
    const over = await admin.post('/api/inventory/transactions', { itemId: a, type: 'CONSUMPTION', quantity: 5, warehouseId: side.id, reason: 'استهلاك' });
    expect(over.status).toBe(400);
    const ok = await admin.post('/api/inventory/transactions', { itemId: a, type: 'CONSUMPTION', quantity: 2, warehouseId: side.id, reason: 'استهلاك' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect([await qtyIn(main.id, a), await qtyIn(side.id, a), await total(a)]).toEqual([7, 1, 8]);
    expect(Number(ok.body.warehouseBalanceAfter)).toBe(1);
    expect(Number(ok.body.balanceAfter)).toBe(8);
    const list = (await admin.get(`/api/inventory/items?warehouseId=${side.id}&pageSize=200`)).body;
    expect(Number(list.items.find((i: { id: string }) => i.id === a).warehouseQuantity)).toBe(1);
    const detail = (await admin.get(`/api/inventory/items/${a}`)).body;
    expect(detail.stocks.map((s: { warehouse: { code: string }; quantity: string }) => [s.warehouse.code, Number(s.quantity)]).sort()).toEqual([['ER', 1], ['MAIN', 7]]);
    const tx = (await admin.get(`/api/inventory/transactions?warehouseId=${side.id}&itemId=${a}`)).body;
    expect(tx.items.every((t: { warehouse: { id: string } }) => t.warehouse.id === side.id)).toBe(true);
  });

  it('an opening quantity and a purchase order can go into a chosen warehouse', async () => {
    const a = await newItem(6, side.id);
    expect([await qtyIn(side.id, a), await qtyIn(main.id, a)]).toEqual([6, 0]);
    const supplierId = (await prisma.supplier.findFirstOrThrow()).id;
    const po = await admin.post('/api/purchases', { supplierId, items: [{ itemId: a, quantity: 4, unitCost: 2 }] });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const rec = await admin.post(`/api/purchases/${po.body.id}/status`, { status: 'RECEIVED', warehouseId: side.id });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect([await qtyIn(side.id, a), await total(a)]).toEqual([10, 10]);
  });

  it('a stock count is of one warehouse and only adjusts that warehouse', async () => {
    const a = await newItem(9);
    await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: side.id, items: [{ itemId: a, quantity: 4 }] });
    const sc = await admin.post('/api/inventory/stock-counts', { title: 'جرد الطوارئ', warehouseId: side.id, itemIds: [a] });
    expect(sc.status, JSON.stringify(sc.body)).toBe(201);
    const d = (await admin.get(`/api/inventory/stock-counts/${sc.body.id}`)).body;
    expect(d.warehouse.id).toBe(side.id);
    expect(Number(d.items[0].systemQuantity)).toBe(4);
    expect((await admin.put(`/api/inventory/stock-counts/${sc.body.id}/items`, { items: [{ id: d.items[0].id, countedQuantity: 3 }] })).status).toBe(200);
    expect((await admin.post(`/api/inventory/stock-counts/${sc.body.id}/approve`)).status).toBe(200);
    expect([await qtyIn(side.id, a), await qtyIn(main.id, a), await total(a)]).toEqual([3, 5, 8]);
  });

  it('invoices take stock from the sales warehouse; cancelling puts it back where it was taken from', async () => {
    const svc = await prisma.service.findUniqueOrThrow({ where: { code: 'MED-PARA' } });
    const itemId = svc.inventoryItemId!;
    expect((await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: side.id, items: [{ itemId, quantity: 5 }] })).status).toBe(201);
    expect((await admin.put('/api/settings/inventory', { saleWarehouseId: side.id })).status).toBe(200);
    const p = await reception.post('/api/patients', { fullName: 'مراجع المستودعات', phone: '0791112299', gender: 'MALE' });
    const templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false } })).id;
    const side0 = await qtyIn(side.id, itemId), main0 = await qtyIn(main.id, itemId);
    const inv = await admin.post('/api/billing/invoices', { patientId: p.body.id, templateId, items: [{ serviceId: svc.id, quantity: 2 }], issue: true });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect([await qtyIn(side.id, itemId), await qtyIn(main.id, itemId)]).toEqual([side0 - 2, main0]);
    expect((await admin.put('/api/settings/inventory', { saleWarehouseId: null })).status).toBe(200); // changed in between
    expect((await admin.post(`/api/billing/invoices/${inv.body.id}/cancel`, { reason: 'اختبار المستودعات' })).status).toBe(200);
    expect([await qtyIn(side.id, itemId), await qtyIn(main.id, itemId)]).toEqual([side0, main0]);
  });

  it('a warehouse with goods, the default one, or the sales one cannot be stopped; the default can be moved', async () => {
    expect((await admin.put(`/api/inventory/warehouses/${side.id}`, { isActive: false })).status).toBe(400); // has goods
    expect((await admin.put(`/api/inventory/warehouses/${main.id}`, { isActive: false })).status).toBe(400); // default
    const empty = (await admin.post('/api/inventory/warehouses', { name: 'مستودع فارغ', code: 'EMPTY' })).body;
    expect((await admin.put('/api/settings/inventory', { saleWarehouseId: empty.id })).status).toBe(200);
    expect((await admin.put(`/api/inventory/warehouses/${empty.id}`, { isActive: false })).status).toBe(400); // sales warehouse
    expect((await admin.put('/api/settings/inventory', { saleWarehouseId: null })).status).toBe(200);
    expect((await admin.put(`/api/inventory/warehouses/${empty.id}`, { isActive: false })).status).toBe(200);
    expect((await admin.put('/api/settings/inventory', { saleWarehouseId: empty.id })).status).toBe(400); // inactive
    expect((await admin.put(`/api/inventory/warehouses/${side.id}`, { isDefault: true })).status).toBe(200);
    expect((await prisma.warehouse.findMany({ where: { isDefault: true } })).map((w) => w.id)).toEqual([side.id]);
    expect((await admin.put(`/api/inventory/warehouses/${main.id}`, { isDefault: true })).status).toBe(200);
  });

  it('the database itself refuses a negative warehouse quantity and a transfer to the same warehouse', async () => {
    const a = await newItem(1);
    await expect(prisma.warehouseStock.update({ where: { warehouseId_itemId: { warehouseId: main.id, itemId: a } }, data: { quantity: -1 } })).rejects.toThrow();
    await expect(prisma.stockTransfer.create({ data: { transferNumber: 'TR-X', fromWarehouseId: main.id, toWarehouseId: main.id } })).rejects.toThrow();
    await expect(prisma.warehouse.create({ data: { code: 'DEF2', name: 'افتراضي ثاني', isDefault: true } })).rejects.toThrow();
  });
});
