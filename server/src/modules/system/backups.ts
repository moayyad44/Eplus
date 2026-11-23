import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { env } from '../../config/env';
import { ah } from '../../lib/http';
import { audit } from '../../lib/audit';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';

// Backups are made by the "backup" container (docker/backup.sh) into a folder shared with the app.
// The app only lists them, serves downloads, and asks for an immediate backup by dropping a ".request" file.
const FILE_RE = /^eplus-backup-[\d_-]+\.tar$/;

export interface BackupFile { name: string; size: number; createdAt: Date }

export async function listBackups(): Promise<{ enabled: boolean; items: BackupFile[]; lastError: string | null; pending: boolean }> {
  const dir = env.BACKUP_DIR;
  if (!dir || !fs.existsSync(dir)) return { enabled: false, items: [], lastError: null, pending: false };
  const names = (await fs.promises.readdir(dir)).filter((n) => FILE_RE.test(n));
  const items = await Promise.all(names.map(async (name) => {
    const st = await fs.promises.stat(path.join(dir, name));
    return { name, size: st.size, createdAt: st.mtime };
  }));
  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const errFile = path.join(dir, '.last-error');
  const lastError = fs.existsSync(errFile) ? (await fs.promises.readFile(errFile, 'utf8')).trim().slice(0, 300) : null;
  return { enabled: true, items, lastError, pending: fs.existsSync(path.join(dir, '.request')) };
}

export const backupsRouter = Router();

backupsRouter.get('/', requirePerm('backups.manage'), ah(async (_req, res) => {
  res.json(await listBackups());
}));

backupsRouter.post('/run', requirePerm('backups.manage'), ah(async (req, res) => {
  if (!env.BACKUP_DIR || !fs.existsSync(env.BACKUP_DIR)) throw badRequest('النسخ الاحتياطي التلقائي غير مفعّل في هذا التشغيل');
  await fs.promises.writeFile(path.join(env.BACKUP_DIR, '.request'), new Date().toISOString());
  await audit(prisma, req.ctx, { action: 'backup.request', entityType: 'Backup', summary: 'طلب نسخة احتياطية فورية' });
  res.status(202).json({ requested: true });
}));

backupsRouter.get('/:name/download', requirePerm('backups.manage'), ah(async (req, res) => {
  const name = String(req.params.name);
  if (!env.BACKUP_DIR || !FILE_RE.test(name)) throw notFound('الملف غير موجود');
  const file = path.join(env.BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw notFound('الملف غير موجود');
  await audit(prisma, req.ctx, { action: 'backup.download', entityType: 'Backup', entityId: name, summary: `تنزيل النسخة الاحتياطية ${name}` });
  res.download(file, name);
}));
