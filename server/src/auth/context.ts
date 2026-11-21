import type { StaffType } from '@prisma/client';
import type { PermissionKey } from './permissions';

export interface Ctx {
  userId: string;
  userName: string;
  username: string;
  roleKey: string;
  staffType: StaffType;
  branchId: string | null;
  sessionId: string;
  perms: Set<string>;
  ip?: string;
  userAgent?: string;
}

export const can = (ctx: Ctx, perm: PermissionKey) => ctx.perms.has(perm);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: Ctx;
    }
  }
}
