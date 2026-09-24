import { Router, type CookieOptions, type Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { AppError, badRequest, notFound, unauthorized } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { env, isProd } from '../../config/env';
import { hashToken, newRefreshToken, signAccessToken } from '../../auth/tokens';
import { effectivePermissions } from '../../auth/access';
import { ACCESS_COOKIE, REFRESH_COOKIE, authenticate, clientInfo } from '../../middleware/auth';
import { getSetting } from '../../lib/settings';

export const passwordSchema = z
  .string()
  .min(8, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل')
  .max(128)
  .regex(/[A-Za-z]/, 'يجب أن تحتوي كلمة المرور على حرف')
  .regex(/[0-9]/, 'يجب أن تحتوي كلمة المرور على رقم');

const MAX_FAILED = 5;
const DUMMY_HASH = bcrypt.hashSync('timing-equalisation', 12);
const LOCK_MINUTES = 15;

const cookieBase: CookieOptions = { httpOnly: true, secure: isProd, sameSite: 'strict' };

function setAuthCookies(res: Response, access: string, refresh: string) {
  res.cookie(ACCESS_COOKIE, access, { ...cookieBase, path: '/api', maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(REFRESH_COOKIE, refresh, { ...cookieBase, path: '/api/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}
function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: '/api/auth' });
}

export async function loadMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: true } }, permissionOverrides: true },
  });
  if (!user) throw notFound();
  const [clinic, financial] = await Promise.all([getSetting('clinic'), getSetting('financial')]);
  return {
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      phone: user.phone,
      email: user.email,
      staffType: user.staffType,
      specialty: user.specialty,
      role: { id: user.role.id, key: user.role.key, name: user.role.name },
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
    },
    permissions: [...effectivePermissions(user.role, user.permissionOverrides)],
    clinic: { name: clinic.name, nameEn: clinic.nameEn, logoKey: clinic.logoKey, phone: clinic.phone, address: clinic.address },
    currency: { code: financial.currency, symbol: financial.currencySymbol, decimals: financial.decimals },
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'محاولات كثيرة، يرجى المحاولة لاحقاً' } },
});

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) }), req.body);
    const info = clientInfo(req);
    const user = await prisma.user.findUnique({ where: { username: body.username.toLowerCase() } });
    const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'اسم المستخدم أو كلمة المرور غير صحيحة');

    if (!user || user.deletedAt) {
      await bcrypt.compare(body.password, DUMMY_HASH); // timing equalisation
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, 'LOCKED', 'تم قفل الحساب مؤقتاً بسبب محاولات دخول فاشلة، حاول لاحقاً');
    }
    const ok = await bcrypt.compare(body.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed >= MAX_FAILED ? 0 : failed,
          lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await audit(prisma, { userId: user.id, userName: user.fullName, ...info }, { action: 'auth.login_failed', entityType: 'user', entityId: user.id });
      throw invalid;
    }
    if (!user.isActive || !user.loginEnabled) throw new AppError(403, 'INACTIVE', 'الحساب غير مفعل، راجع مدير النظام');

    const refresh = newRefreshToken();
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashToken(refresh),
        ip: info.ip,
        userAgent: info.userAgent,
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
    await audit(prisma, { userId: user.id, userName: user.fullName, ...info }, { action: 'auth.login', entityType: 'user', entityId: user.id });

    const access = signAccessToken({ sub: user.id, sid: session.id });
    setAuthCookies(res, access, refresh);
    res.json({ ...(await loadMe(user.id)), ...(req.body?.tokenInBody ? { accessToken: access, refreshToken: refresh } : {}) });
  }),
);

/** Rotates the refresh token. A reused (already rotated) token revokes the session. */
authRouter.post(
  '/refresh',
  ah(async (req, res) => {
    const token: string | undefined = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
    if (!token) throw unauthorized();
    const session = await prisma.session.findUnique({ where: { refreshTokenHash: hashToken(token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      clearAuthCookies(res);
      throw unauthorized('انتهت الجلسة');
    }
    if (!session.user.isActive || !session.user.loginEnabled || session.user.deletedAt) {
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      clearAuthCookies(res);
      throw unauthorized('الحساب غير مفعل');
    }
    const refresh = newRefreshToken();
    await prisma.session.update({
      where: { id: session.id },
      data: { refreshTokenHash: hashToken(refresh), lastUsedAt: new Date() },
    });
    const access = signAccessToken({ sub: session.userId, sid: session.id });
    setAuthCookies(res, access, refresh);
    res.json({ ok: true, ...(req.body?.refreshToken ? { accessToken: access, refreshToken: refresh } : {}) });
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    const token: string | undefined = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      await prisma.session.updateMany({ where: { refreshTokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    clearAuthCookies(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  ah(async (req, res) => {
    res.json(await loadMe(req.ctx.userId));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  ah(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.ctx.userId } });
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) throw badRequest('كلمة المرور الحالية غير صحيحة');
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, 12), mustChangePassword: false } });
      // Sign out every other device.
      await tx.session.updateMany({ where: { userId: user.id, id: { not: req.ctx.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
    });
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/sessions',
  authenticate,
  ah(async (req, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
      orderBy: { lastUsedAt: 'desc' },
    });
    res.json(sessions.map((s) => ({ ...s, current: s.id === req.ctx.sessionId })));
  }),
);

authRouter.delete(
  '/sessions/:id',
  authenticate,
  ah(async (req, res) => {
    await prisma.session.updateMany({ where: { id: req.params.id, userId: req.ctx.userId }, data: { revokedAt: new Date() } });
    res.json({ ok: true });
  }),
);
