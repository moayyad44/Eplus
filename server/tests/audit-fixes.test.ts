import { beforeAll, describe, expect, it } from 'vitest';
import { login, type Client } from './helpers';

let admin: Client, doctor: Client, reception: Client;
beforeAll(async () => {
  [admin, doctor, reception] = await Promise.all([login('admin'), login('dr.ahmad'), login('reception')]);
});

describe('fixes from the full review', () => {
  it('doctors keep seeing invoices (also of other doctors’ patients) but not insurance company payments', async () => {
    expect((await doctor.get('/api/billing/invoices')).status).toBe(200);
    expect((await doctor.get('/api/insurance/payments')).status).toBe(403);
    expect((await reception.get('/api/insurance/payments')).status).toBe(403);
    expect((await admin.get('/api/insurance/payments')).status).toBe(200);
  });
});

describe('inventory fixes from the full review', () => {
  it('no manual «purchase» movement (buying goes through purchase orders); a stopped item cannot be moved or transferred', async () => {
    const it1 = (await admin.post('/api/inventory/items', { name: 'صنف المراجعة', sku: 'AUDIT-FIX-1', openingQuantity: 5 })).body;
    expect((await admin.post('/api/inventory/transactions', { itemId: it1.id, type: 'PURCHASE', quantity: 2, reason: 'شراء يدوي' })).status).toBe(400);
    expect((await admin.post('/api/inventory/transactions', { itemId: it1.id, type: 'RECEIPT', quantity: 2, reason: 'إدخال' })).status).toBe(201);
    expect((await admin.put(`/api/inventory/items/${it1.id}`, { isActive: false })).status).toBe(200);
    const r = await admin.post('/api/inventory/transactions', { itemId: it1.id, type: 'CONSUMPTION', quantity: 1, reason: 'استهلاك' });
    expect(r.status).toBe(400);
    const wh = (await admin.post('/api/inventory/warehouses', { name: 'مستودع المراجعة', code: 'AUDFIX' })).body;
    const main = (await admin.get('/api/inventory/warehouses')).body.find((w: { isDefault: boolean }) => w.isDefault);
    expect((await admin.post('/api/inventory/transfers', { fromWarehouseId: main.id, toWarehouseId: wh.id, items: [{ itemId: it1.id, quantity: 1 }] })).status).toBe(400);
  });
});
