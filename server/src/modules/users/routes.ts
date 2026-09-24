import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Prisma, StaffType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, pageQuery, paged, paginate, sortBy } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { passwordSchema } from '../auth/routes';
import { ALL_PERMISSIONS } from '../../auth/permissions';

export const usersRouter = Router();

const publicSelect = {
  id: true, username: true, fullName: true, phone: true, email: true, staffType: true, specialty: true,
  licenseNumber: true, isActive: true, loginEnabled: true, lastLoginAt: true, createdAt: true, branchId: true,
  mustChangePassword: true, lockedUntil: true,
  role: { select: { id: true, key: true, name: true } },
} satisfies Prisma.UserSelect;

const baseFields = {
  fullName: z.string().trim().min(2, 'الاسم مطلوب').max(120),
  phone: nullableStr(30),
  email: z.preprocess((v) => (v === '' ? null : v), z.string().email('بريد إلكتروني غير صالح').max(120).nullable().optional()),
  roleId: z.string().uuid('اختر الدور'),
  staffType: z.nativeEnum(StaffType),
  specialty: nullableStr(120),
  licenseNumber: nullableStr(60),
  isActive: z.boolean().optional(),
  loginEnabled: z.boolean().optional(),
};

/** Lightweight staff lookup for dropdowns (doctors, nurses…) — any authenticated user. */
usersRouter.get(
  '/lookup',
  ah(async (req, res) => {
    const q = parse(z.object({ staffType: z.nativeEnum(StaffType).optional() }), req.query);
    const users = await prisma.user.findMany({
      where: { isActive: true, deletedAt: null, ...(q.staffType ? { staffType: q.staffType } : {}) },
      select: { id: true, fullName: true, staffType: true, specialty: true },
      orderBy: { fullName: 'asc' },
    });
    res.json(users);
  }),
);

usersRouter.get(
  '/',
  requirePerm('users.view'),
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({ staffType: z.nativeEnum(StaffType).optional(), roleId: z.string().uuid().optional(), active: z.enum(['true', 'false']).optional() }),
      req.query,
    );
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(q.staffType && { staffType: q.staffType }),
      ...(q.roleId && { roleId: q.roleId }),
      ...(q.active && { isActive: q.active === 'true' }),
      ...(q.q && {
        OR: [
          { fullName: { contains: q.q, mode: 'insensitive' } },
          { username: { contains: q.q, mode: 'insensitive' } },
          { phone: { contains: q.q } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      prisma.user.findMany({ where, select: publicSelect, orderBy: sortBy(q.sort, ['fullName', 'createdAt', 'lastLoginAt'] as const, 'fullName', q.sort ? q.order : 'asc'), ...paginate(q) }),
      prisma.user.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);

usersRouter.get(
  '/:id',
  requirePerm('users.view'),
  ah(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { ...publicSelect, permissionOverrides: true },
    });
    if (!user) throw notFound();
    res.json(user);
  }),
);

usersRouter.post(
  '/',
  requirePerm('users.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ ...baseFields, username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'اسم المستخدم: 3-40 حرفاً إنجليزياً أو أرقام'), password: passwordSchema, mustChangePassword: z.boolean().default(true) }),
      req.body,
    );
    const { password, ...data } = body;
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { ...data, passwordHash: await bcrypt.hash(password, 12), branchId: req.ctx.branchId },
        select: publicSelect,
      });
      await audit(tx, req.ctx, { action: 'user.create', entityType: 'user', entityId: u.id, summary: `إنشاء مستخدم ${u.username}`, after: u });
      return u;
    });
    res.status(201).json(user);
  }),
);

usersRouter.put(
  '/:id',
  requirePerm('users.manage'),
  ah(async (req, res) => {
    const body = parse(z.object(baseFields).partial(), req.body);
    const before = await prisma.user.findFirst({ where: { id: req.params.id, deletedAt: null }, select: publicSelect });
    if (!before) throw notFound();
    if (req.params.id === req.ctx.userId && (body.isActive === false || body.loginEnabled === false)) {
      throw badRequest('لا يمكنك تعطيل حسابك الحالي');
    }
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: req.params.id }, data: body, select: publicSelect });
      if (body.isActive === false || body.loginEnabled === false) {
        await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await audit(tx, req.ctx, {
        action: before.role.id !== u.role.id ? 'user.role_change' : 'user.update',
        entityType: 'user', entityId: u.id, summary: `تعديل المستخدم ${u.username}`, before, after: u,
      });
      return u;
    });
    res.json(user);
  }),
);

usersRouter.post(
  '/:id/reset-password',
  requirePerm('users.manage'),
  ah(async (req, res) => {
    const body = parse(z.object({ password: passwordSchema }), req.body);
    await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: req.params.id },
        data: { passwordHash: await bcrypt.hash(body.password, 12), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
      });
      await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'user.password_reset', entityType: 'user', entityId: u.id, summary: `إعادة تعيين كلمة مرور ${u.username}` });
    });
    res.json({ ok: true });
  }),
);

/** Per-user permission grants/denials on top of the role. */
usersRouter.put(
  '/:id/permissions',
  requirePerm('roles.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ overrides: z.array(z.object({ permissionKey: z.enum(ALL_PERMISSIONS as [string, ...string[]]), allow: z.boolean() })).max(200) }),
      req.body,
    );
    const userId = req.params.id;
    await prisma.$transaction(async (tx) => {
      const before = await tx.userPermissionOverride.findMany({ where: { userId } });
      await tx.userPermissionOverride.deleteMany({ where: { userId } });
      if (body.overrides.length) await tx.userPermissionOverride.createMany({ data: body.overrides.map((o) => ({ ...o, userId })) });
      await audit(tx, req.ctx, {
        action: 'user.permissions_change', entityType: 'user', entityId: userId, summary: 'تعديل صلاحيات مستخدم',
        before: { overrides: before.map((o) => ({ permissionKey: o.permissionKey, allow: o.allow })) }, after: { overrides: body.overrides },
      });
    });
    res.json({ ok: true });
  }),
);

/** Archive (soft delete) — keeps historical links from visits, invoices, audit logs. */
usersRouter.delete(
  '/:id',
  requirePerm('users.manage'),
  ah(async (req, res) => {
    if (req.params.id === req.ctx.userId) throw badRequest('لا يمكنك أرشفة حسابك الحالي');
    await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } });
      await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'user.archive', entityType: 'user', entityId: u.id, summary: `أرشفة المستخدم ${u.username}` });
    });
    res.json({ ok: true });
  }),
);
