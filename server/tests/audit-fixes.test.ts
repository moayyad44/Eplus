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

describe('supplier payment void', () => {
  it('needs a reason and records who voided it', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const sup = await prisma.supplier.findFirstOrThrow();
    const cash = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CASH' } });
    const p = (await admin.post(`/api/suppliers/${sup.id}/payments`, { amount: 7, methodId: cash.id })).body;
    expect((await admin.post(`/api/suppliers/payments/${p.id}/void`, {})).status).toBe(400);
    expect((await admin.post(`/api/suppliers/payments/${p.id}/void`, { reason: 'مكررة' })).status).toBe(200);
    const row = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.voidReason, !!row.voidedById, !!row.voidedAt]).toEqual(['مكررة', true, true]);
  });
});

describe('accounts without any permission', () => {
  it('cannot read catalogs, prices, staff names or search; their own account, attendance and notifications still work', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const bcrypt = (await import('bcryptjs')).default;
    const role = await prisma.role.create({ data: { key: 'no_perms_audit', name: 'بلا صلاحيات' } });
    await prisma.user.create({ data: { username: 'no.perms', fullName: 'بلا صلاحيات', passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id } });
    const c = await login('no.perms');
    for (const u of ['/api/settings/services', '/api/settings/payment-methods', '/api/settings/invoice-templates', '/api/users/lookup', '/api/search?q=ab']) expect((await c.get(u)).status, u).toBe(403);
    for (const u of ['/api/auth/me', '/api/notifications', '/api/settings/public']) expect((await c.get(u)).status, u).toBe(200);
    // Every real role still reads the shared lists.
    for (const cl of [doctor, reception]) expect((await cl.get('/api/settings/services')).status).toBe(200);
  });
});
