import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

/** «الفاتورة تحتاج زيارة»: off by default; when on, only holders of invoices.without_visit invoice without a visit. */
let admin: Client, clerk: Client;
let body: Record<string, unknown>;
let saved: unknown;

beforeAll(async () => {
  saved = (await prisma.setting.findUnique({ where: { key: 'financial' } }))?.value;
  // A role that may create invoices but not without a visit.
  const role = await prisma.role.create({ data: { key: 'billing_visit_only', name: 'فوترة من الزيارة فقط', permissions: { create: ['invoices.view', 'invoices.create', 'patients.view'].map((permissionKey) => ({ permissionKey })) } } });
  await prisma.user.create({ data: { username: 'bill.visit', fullName: 'موظف فوترة', passwordHash: await bcrypt.hash('Test@12345', 4), roleId: role.id } });
  [admin, clerk] = await Promise.all([login('admin'), login('bill.visit')]);
  const patient = await prisma.patient.findFirstOrThrow({ where: { deletedAt: null } });
  const svc = await prisma.service.findFirstOrThrow({ where: { deletedAt: null, isActive: true, price: { gt: 0 } } });
  const tpl = await prisma.invoiceTemplate.findFirstOrThrow({ where: { isActive: true, items: { none: { isMandatory: true } } } });
  body = { patientId: patient.id, templateId: tpl.id, items: [{ serviceId: svc.id, quantity: 1 }] };
});

afterAll(async () => {
  await prisma.setting.update({ where: { key: 'financial' }, data: { value: saved as object } });
});

describe('invoice without a visit', () => {
  it('is allowed while the setting is off (as before)', async () => {
    expect((await clerk.post('/api/billing/invoices/preview', body)).status).toBe(200);
  });

  it('when the setting is on: refused without the permission, allowed with it; the list can show them alone', async () => {
    expect((await admin.put('/api/settings/financial', { requireVisit: true })).status).toBe(200);
    const r = await clerk.post('/api/billing/invoices', body);
    expect([r.status, JSON.stringify(r.body)]).toEqual([400, expect.stringContaining('الفاتورة تحتاج زيارة')]);
    const ok = await admin.post('/api/billing/invoices', body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const list = (await admin.get('/api/billing/invoices?noVisit=1&pageSize=100&from=2000-01-01&to=2100-01-01')).body;
    expect(list.items.some((i: { id: string }) => i.id === ok.body.id)).toBe(true);
    expect(list.items.every((i: { visitId: string | null }) => i.visitId === null)).toBe(true);
  });

  it('reception (a default role) holds the permission', async () => {
    const r = await prisma.role.findUniqueOrThrow({ where: { key: 'receptionist' }, include: { permissions: true } });
    expect(r.permissions.some((p) => p.permissionKey === 'invoices.without_visit')).toBe(true);
  });
});
