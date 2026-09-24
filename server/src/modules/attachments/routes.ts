import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { AttachmentCategory, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { requireAnyPerm } from '../../middleware/auth';
import { ALLOWED_MIME, sniffMatches, storage } from '../../lib/storage';
import { env } from '../../config/env';
import { can, type Ctx } from '../../auth/context';

export const attachmentsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

/** Expense receipts are financial documents; everything else is part of the medical record. */
const canView = (ctx: Ctx, a: { expenseId: string | null }) => (a.expenseId ? can(ctx, 'expenses.view') : can(ctx, 'attachments.view'));

attachmentsRouter.post(
  '/',
  requireAnyPerm('attachments.upload', 'expenses.manage', 'settings.manage'),
  upload.single('file'),
  ah(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('يرجى اختيار ملف');
    if (!ALLOWED_MIME.has(file.mimetype) || !sniffMatches(file.buffer, file.mimetype)) throw badRequest('نوع الملف غير مسموح');
    const body = parse(
      z.object({
        patientId: z.string().uuid().optional(), visitId: z.string().uuid().optional(), labOrderId: z.string().uuid().optional(), expenseId: z.string().uuid().optional(),
        category: z.nativeEnum(AttachmentCategory).default('OTHER'), description: nullableStr(300),
      }),
      req.body,
    );
    if (body.expenseId ? !can(req.ctx, 'expenses.manage') : !can(req.ctx, 'attachments.upload')) throw forbidden();
    let patientId = body.patientId;
    if (body.visitId) {
      const v = await prisma.visit.findUnique({ where: { id: body.visitId }, select: { patientId: true } });
      if (!v) throw notFound('الزيارة غير موجودة');
      patientId = v.patientId;
    }
    if (body.labOrderId) {
      const o = await prisma.labOrder.findUnique({ where: { id: body.labOrderId }, select: { patientId: true } });
      if (!o) throw notFound('طلب التحليل غير موجود');
      patientId = o.patientId;
    }
    if (!patientId && !body.expenseId) throw badRequest('يجب ربط المرفق بمريض أو زيارة أو مصروف');
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200);
    const key = await storage.put(file.buffer, originalName);
    const a = await prisma.$transaction(async (tx) => {
      const row = await tx.attachment.create({
        data: { ...body, patientId, fileName: originalName, mimeType: file.mimetype, size: file.size, storageKey: key, uploadedById: req.ctx.userId },
      });
      await audit(tx, req.ctx, { action: 'attachment.upload', entityType: 'attachment', entityId: row.id, summary: originalName, after: { patientId, visitId: body.visitId, expenseId: body.expenseId, category: body.category } });
      return row;
    });
    res.status(201).json(a);
  }),
);

attachmentsRouter.get(
  '/',
  requireAnyPerm('attachments.view', 'expenses.view'),
  ah(async (req, res) => {
    const q = parse(z.object({ patientId: z.string().uuid().optional(), visitId: z.string().uuid().optional(), labOrderId: z.string().uuid().optional(), expenseId: z.string().uuid().optional() }), req.query);
    if (!Object.values(q).some(Boolean)) throw badRequest('حدد المريض أو الزيارة');
    if (q.expenseId ? !can(req.ctx, 'expenses.view') : !can(req.ctx, 'attachments.view')) throw forbidden();
    const where: Prisma.AttachmentWhereInput = { deletedAt: null, ...q };
    res.json(await prisma.attachment.findMany({ where, orderBy: { createdAt: 'desc' } }));
  }),
);

attachmentsRouter.get(
  '/:id/file',
  requireAnyPerm('attachments.view', 'expenses.view'),
  ah(async (req, res) => {
    const a = await prisma.attachment.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!a) throw notFound();
    if (!canView(req.ctx, a)) throw forbidden();
    if (!(await storage.exists(a.storageKey))) throw notFound('الملف غير موجود على الخادم');
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    storage.stream(a.storageKey).pipe(res);
  }),
);

attachmentsRouter.delete(
  '/:id',
  requireAnyPerm('attachments.upload', 'expenses.manage'),
  ah(async (req, res) => {
    const a = await prisma.attachment.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!a) throw notFound();
    if (a.expenseId ? !can(req.ctx, 'expenses.manage') : !can(req.ctx, 'attachments.upload')) throw forbidden();
    await prisma.$transaction(async (tx) => {
      await tx.attachment.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'attachment.remove', entityType: 'attachment', entityId: a.id, summary: a.fileName });
    });
    res.json({ ok: true });
  }),
);
