import type { NotificationType } from '@prisma/client';
import type { PermissionKey } from '../auth/permissions';
import type { Db } from './prisma';
import { prisma } from './prisma';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  dedupeKey?: string;
}

/** Active users who effectively hold a permission (role grant + user overrides). */
export async function usersWithPermission(perm: PermissionKey, db: Db = prisma) {
  const users = await db.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: {
      id: true,
      role: { select: { permissions: { where: { permissionKey: perm }, select: { permissionKey: true } } } },
      permissionOverrides: { where: { permissionKey: perm } },
    },
  });
  return users
    .filter((u) => {
      const o = u.permissionOverrides[0];
      return o ? o.allow : u.role.permissions.length > 0;
    })
    .map((u) => u.id);
}

export async function notifyUsers(userIds: string[], n: NotificationInput, db: Db = prisma) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return 0;
  const res = await db.notification.createMany({
    data: ids.map((userId) => ({ userId, ...n })),
    skipDuplicates: true,
  });
  return res.count;
}

export async function notifyPermission(perm: PermissionKey, n: NotificationInput, db: Db = prisma, exceptUserId?: string) {
  const ids = (await usersWithPermission(perm, db)).filter((id) => id !== exceptUserId);
  return notifyUsers(ids, n, db);
}
