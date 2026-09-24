import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { AppError } from '../lib/errors';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'البيانات المدخلة غير صحيحة', details: fields } });
  }
  if (err instanceof MulterError) {
    return res.status(400).json({ error: { code: 'UPLOAD', message: err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من المسموح' : err.message } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ');
      return res.status(409).json({ error: { code: 'DUPLICATE', message: 'القيمة مستخدمة مسبقاً', details: { target } } });
    }
    if (err.code === 'P2025') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'العنصر غير موجود' } });
    if (err.code === 'P2003') return res.status(409).json({ error: { code: 'IN_USE', message: 'لا يمكن تنفيذ العملية لوجود بيانات مرتبطة' } });
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'صيغة الطلب غير صحيحة' } });
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'حدث خطأ غير متوقع في الخادم' } });
}
