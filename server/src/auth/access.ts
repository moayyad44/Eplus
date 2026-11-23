import type { Role, RolePermission, UserPermissionOverride } from '@prisma/client';

/** Effective permissions = role permissions + per-user grants − per-user denials. */
export function effectivePermissions(
  role: Role & { permissions: RolePermission[] },
  overrides: UserPermissionOverride[],
): Set<string> {
  const set = new Set(role.permissions.map((p) => p.permissionKey));
  for (const o of overrides) {
    if (o.allow) set.add(o.permissionKey);
    else set.delete(o.permissionKey);
  }
  return set;
}
