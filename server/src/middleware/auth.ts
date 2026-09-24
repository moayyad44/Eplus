import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../auth/tokens';
import { effectivePermissions } from '../auth/access';
import type { PermissionKey } from '../auth/permissions';

export const ACCESS_COOKIE = 'ep_at';
export const REFRESH_COOKIE = 'ep_rt';

export const clientInfo = (req: Request) => ({
  ip: (req.ip || req.socket.remoteAddress || '').replace('::ffff:', ''),
  userAgent: (req.headers['user-agent'] || '').slice(0, 300),
});

/**
 * Verifies the access token (httpOnly cookie, or Bearer header for non-browser clients),
 * then re-checks the session and the user on every request so that logout, deactivation
 * and permission changes take effect immediately.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const token = bearer ?? req.cookies?.[ACCESS_COOKIE];
    if (!token) throw unauthorized();

    // CSRF defence for cookie-based auth: state-changing requests must carry a custom header
    // (cannot be sent cross-site without a CORS preflight, which we do not allow).
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'EmergencyPlus') {
      throw forbidden('طلب غير صالح');
    }

    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      throw unauthorized('انتهت الجلسة');
    }

    const session = await prisma.session.findUnique({
      where: { id: claims.sid },
      include: {
        user: { include: { role: { include: { permissions: true } }, permissionOverrides: true } },
      },
    });
    const user = session?.user;
    if (!session || session.revokedAt || session.expiresAt < new Date() || !user || user.id !== claims.sub) {
      throw unauthorized('انتهت الجلسة');
    }
    if (!user.isActive || !user.loginEnabled || user.deletedAt) throw unauthorized('الحساب غير مفعل');

    const { ip, userAgent } = clientInfo(req);
    req.ctx = {
      userId: user.id,
      userName: user.fullName,
      username: user.username,
      roleKey: user.role.key,
      staffType: user.staffType,
      branchId: user.branchId,
      sessionId: session.id,
      perms: effectivePermissions(user.role, user.permissionOverrides),
      ip,
      userAgent,
    };

    if (Date.now() - session.lastUsedAt.getTime() > 5 * 60_000) {
      prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** Requires ALL listed permissions. */
export const requirePerm =
  (...perms: PermissionKey[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(unauthorized());
    for (const p of perms) if (!req.ctx.perms.has(p)) return next(forbidden());
    next();
  };

/** Requires ANY of the listed permissions. */
export const requireAnyPerm =
  (...perms: PermissionKey[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(unauthorized());
    if (!perms.some((p) => req.ctx.perms.has(p))) return next(forbidden());
    next();
  };
