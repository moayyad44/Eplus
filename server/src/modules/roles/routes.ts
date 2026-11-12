import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../auth/permissions';

export const rolesRouter = Router();

const permKey = z.enum(ALL_PERMISSIONS as [string, ...string[]]);

rolesRouter.get(
  '/permissions',
  requireAnyPerm('roles.manage', 'users.view'),
  ah(async (_req, res) => {
    res.json(Object.entries(PERMISSIONS).map(([key, v]) => ({ key, ...v })));
  }),
);

rolesRouter.get(
  '/',
  requireAnyPerm('roles.manage', 'users.view', 'users.manage'),
  ah(async (_req, res) => {
    const roles = await prisma.role.findMany({
      include: { permissions: { select: { permissionKey: true } }, _count: { select: { users: { where: { deletedAt: null } } } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(roles.map((r) => ({ ...r, permissions: r.permissions.map((p) => p.permissionKey), userCount: r._count.users, _count: undefined })));
  }),
);

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  permissions: z.array(permKey).max(200),
});

rolesRouter.post(
  '/',
  requirePerm('roles.manage'),
  ah(async (req, res) => {
    const body = parse(roleBody.extend({ key: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/, 'المعرف: أحرف إنجليزية صغيرة وأرقام') }), req.body);
    const role = await prisma.$transaction(async (tx) => {
      const r = await tx.role.create({
        data: { key: body.key, name: body.name, description: body.description, permissions: { create: body.permissions.map((permissionKey) => ({ permissionKey })) } },
      });
      await audit(tx, req.ctx, { action: 'role.create', entityType: 'role', entityId: r.id, summary: `إنشاء دور ${r.name}`, after: body });
      return r;
    });
    res.status(201).json(role);
  }),
);

rolesRouter.put(
  '/:id',
  requirePerm('roles.manage'),
  ah(async (req, res) => {
    const body = parse(roleBody, req.body);
    const before = await prisma.role.findUnique({ where: { id: req.params.id }, include: { permissions: true } });
    if (!before) throw notFound();
    if (before.key === 'admin' && !(['roles.manage', 'users.manage'] as string[]).every((p) => body.permissions.includes(p))) {
      throw badRequest('لا يمكن إزالة صلاحيات إدارة المستخدمين والأدوار من دور المدير');
    }
    await prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id: before.id }, data: { name: body.name, description: body.description } });
      await tx.rolePermission.deleteMany({ where: { roleId: before.id } });
      await tx.rolePermission.createMany({ data: body.permissions.map((permissionKey) => ({ roleId: before.id, permissionKey })) });
      const old = before.permissions.map((p) => p.permissionKey);
      await audit(tx, req.ctx, {
        action: 'role.permissions_change', entityType: 'role', entityId: before.id, summary: `تعديل صلاحيات الدور ${body.name}`,
        before: { name: before.name, added: [], removed: old.filter((p) => !body.permissions.includes(p)) },
        after: { name: body.name, added: body.permissions.filter((p) => !old.includes(p)), removed: [] },
      });
    });
    res.json({ ok: true });
  }),
);

rolesRouter.delete(
  '/:id',
  requirePerm('roles.manage'),
  ah(async (req, res) => {
    const role = await prisma.role.findUnique({ where: { id: req.params.id }, include: { _count: { select: { users: true } } } });
    if (!role) throw notFound();
    if (role.isSystem) throw badRequest('لا يمكن حذف دور أساسي في النظام');
    if (role._count.users) throw conflict('لا يمكن حذف دور مرتبط بمستخدمين');
    await prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id: role.id } });
      await audit(tx, req.ctx, { action: 'role.delete', entityType: 'role', entityId: role.id, summary: `حذف الدور ${role.name}` });
    });
    res.json({ ok: true });
  }),
);
