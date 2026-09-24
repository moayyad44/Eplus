import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { requirePerm } from '../../middleware/auth';
import { rangeFromQuery } from '../../lib/dates';
import { can } from '../../auth/context';
import { patientListSelect, patientSearchWhere } from '../patients/routes';

// ── Notifications (per user) ──
export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }), req.query);
    const where: Prisma.NotificationWhereInput = { userId: req.ctx.userId, ...(q.unread === 'true' && { readAt: null }) };
    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: req.ctx.userId, readAt: null } }),
    ]);
    res.json({ ...paged(items, total, q), unread });
  }),
);

notificationsRouter.get(
  '/unread-count',
  ah(async (req, res) => {
    res.json({ count: await prisma.notification.count({ where: { userId: req.ctx.userId, readAt: null } }) });
  }),
);

notificationsRouter.post(
  '/read-all',
  ah(async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: req.ctx.userId, readAt: null }, data: { readAt: new Date() } });
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/:id/read',
  ah(async (req, res) => {
    await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.ctx.userId }, data: { readAt: new Date() } });
    res.json({ ok: true });
  }),
);

// ── Audit log (read-only; there is intentionally no update/delete route) ──
export const auditRouter = Router();

auditRouter.get(
  '/',
  requirePerm('audit.view'),
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({ userId: z.string().uuid().optional(), entityType: z.string().max(40).optional(), entityId: z.string().max(60).optional(), action: z.string().max(60).optional(), from: z.string().optional(), to: z.string().optional() }),
      req.query,
    );
    const where: Prisma.AuditLogWhereInput = {
      ...(q.userId && { userId: q.userId }),
      ...(q.entityType && { entityType: q.entityType }),
      ...(q.entityId && { entityId: q.entityId }),
      ...(q.action && { action: { startsWith: q.action } }),
      ...(q.from && { createdAt: (({ from, to }) => ({ gte: from, lte: to }))(rangeFromQuery(q.from, q.to)) }),
      ...(q.q && { OR: [{ summary: { contains: q.q, mode: 'insensitive' } }, { userName: { contains: q.q, mode: 'insensitive' } }, { action: { contains: q.q } }] }),
    };
    const [items, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }), prisma.auditLog.count({ where })]);
    res.json(paged(items, total, q));
  }),
);

auditRouter.get(
  '/facets',
  requirePerm('audit.view'),
  ah(async (_req, res) => {
    const [entities, actions] = await Promise.all([
      prisma.auditLog.findMany({ distinct: ['entityType'], select: { entityType: true } }),
      prisma.auditLog.findMany({ distinct: ['action'], select: { action: true } }),
    ]);
    res.json({ entityTypes: entities.map((e) => e.entityType).sort(), actions: actions.map((a) => a.action).sort() });
  }),
);

// ── Global search: each section only if the user may see it ──
export const searchRouter = Router();

searchRouter.get(
  '/',
  ah(async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
    const ctx = req.ctx;
    const take = 6;
    const ci = { contains: q, mode: 'insensitive' as const };
    const [patients, invoices, appointments, staff, inventory, suppliers] = await Promise.all([
      can(ctx, 'patients.view') ? prisma.patient.findMany({ where: patientSearchWhere(q), select: patientListSelect, take }) : [],
      can(ctx, 'invoices.view')
        ? prisma.invoice.findMany({ where: { OR: [{ invoiceNumber: ci }, { patient: { fullName: ci } }] }, select: { id: true, invoiceNumber: true, status: true, total: true, balance: true, patient: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take })
        : [],
      can(ctx, 'appointments.view')
        ? prisma.appointment.findMany({ where: { startAt: { gte: new Date(Date.now() - 7 * 86_400_000) }, OR: [{ patient: { fullName: ci } }, { patient: { phone: { contains: q } } }] }, select: { id: true, startAt: true, status: true, patient: { select: { fullName: true } }, doctor: { select: { fullName: true } } }, orderBy: { startAt: 'asc' }, take })
        : [],
      can(ctx, 'users.view') ? prisma.user.findMany({ where: { deletedAt: null, OR: [{ fullName: ci }, { username: ci }, { phone: { contains: q } }] }, select: { id: true, fullName: true, staffType: true, role: { select: { name: true } } }, take }) : [],
      can(ctx, 'inventory.view') ? prisma.inventoryItem.findMany({ where: { deletedAt: null, OR: [{ name: ci }, { sku: ci }, { barcode: q }] }, select: { id: true, name: true, sku: true, quantity: true }, take }) : [],
      can(ctx, 'suppliers.view') ? prisma.supplier.findMany({ where: { deletedAt: null, OR: [{ name: ci }, { phone: { contains: q } }] }, select: { id: true, name: true, phone: true }, take }) : [],
    ]);
    res.json({ patients, invoices, appointments, staff, inventory, suppliers });
  }),
);
