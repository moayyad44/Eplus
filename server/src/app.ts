import path from 'node:path';
import fs from 'node:fs';
import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env, isProd } from './config/env';
import { authenticate } from './middleware/auth';
import { errorHandler } from './middleware/error';
import { prisma } from './lib/prisma';
import { getSetting } from './lib/settings';
import { storage } from './lib/storage';
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { rolesRouter } from './modules/roles/routes';
import { settingsRouter } from './modules/settings/routes';
import { patientsRouter } from './modules/patients/routes';
import { visitsRouter } from './modules/visits/routes';
import { clinicalRouter } from './modules/clinical/routes';
import { labRouter } from './modules/lab/routes';
import { appointmentsRouter } from './modules/appointments/routes';
import { attachmentsRouter } from './modules/attachments/routes';
import { billingRouter } from './modules/billing/routes';
import { cashierRouter } from './modules/billing/cashier';
import { expensesRouter } from './modules/expenses/routes';
import { inventoryRouter } from './modules/inventory/routes';
import { purchasesRouter, suppliersRouter } from './modules/inventory/suppliers';
import { staffRouter } from './modules/staff/routes';
import { dashboardRouter } from './modules/dashboard/routes';
import { reportsRouter } from './modules/reports/routes';
import { auditRouter, notificationsRouter, searchRouter } from './modules/system/routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ["'self'", 'blob:'],
          objectSrc: ["'self'", 'blob:'],
        },
      },
      hsts: isProd,
    }),
  );
  if (env.CORS_ORIGIN) app.use(cors({ origin: env.CORS_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 100_000 : 600, standardHeaders: 'draft-7', legacyHeaders: false }));

  const api = Router();
  api.get('/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, time: new Date().toISOString() });
  });
  // Public: clinic name & logo for the login page.
  api.get('/public/clinic', async (_req, res, next) => {
    try {
      const c = await getSetting('clinic');
      res.json({ name: c.name, nameEn: c.nameEn, hasLogo: !!c.logoKey });
    } catch (e) { next(e); }
  });
  api.get('/public/logo', async (_req, res, next) => {
    try {
      const c = await getSetting('clinic');
      if (!c.logoKey) return res.status(404).end();
      const att = await prisma.attachment.findUnique({ where: { storageKey: c.logoKey } });
      if (!att || !(await storage.exists(att.storageKey))) return res.status(404).end();
      res.setHeader('Content-Type', att.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=300');
      storage.stream(att.storageKey).pipe(res);
    } catch (e) { next(e); }
  });

  api.use('/auth', authRouter);
  api.use(authenticate); // everything below requires a valid session
  api.use('/users', usersRouter);
  api.use('/roles', rolesRouter);
  api.use('/settings', settingsRouter);
  api.use('/patients', patientsRouter);
  api.use('/visits', visitsRouter);
  api.use('/', clinicalRouter);
  api.use('/lab', labRouter);
  api.use('/appointments', appointmentsRouter);
  api.use('/attachments', attachmentsRouter);
  api.use('/billing', billingRouter);
  api.use('/cashier', cashierRouter);
  api.use('/expenses', expensesRouter);
  api.use('/inventory', inventoryRouter);
  api.use('/suppliers', suppliersRouter);
  api.use('/purchases', purchasesRouter);
  api.use('/staff', staffRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/reports', reportsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/audit-logs', auditRouter);
  api.use('/search', searchRouter);
  api.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } }));

  app.use('/api', api);

  // Production: serve the built SPA from the same origin (keeps cookies SameSite=strict).
  const webDist = path.resolve(env.WEB_DIST ?? path.join(__dirname, '../../web/dist'));
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '7d', setHeaders: (res, p) => p.endsWith('.html') && res.setHeader('Cache-Control', 'no-cache') }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
  }

  app.use(errorHandler);
  return app;
}
