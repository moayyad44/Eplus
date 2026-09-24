import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ServiceCategory, ShiftType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { getAllSettings, getSetting, settingSchemas, type SettingKey } from '../../lib/settings';
import { catalogRouter } from './catalog';
import { sniffMatches, storage } from '../../lib/storage';

export const settingsRouter = Router();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'الوقت بصيغة HH:mm');
const money = z.coerce.number().min(0).max(1_000_000);

settingsRouter.get(
  '/',
  requireAnyPerm('settings.view', 'settings.manage'),
  ah(async (_req, res) => res.json(await getAllSettings())),
);

/** Non-sensitive subsets needed by every screen (printing headers, currency, alert days…). */
settingsRouter.get(
  '/public',
  ah(async (_req, res) => {
    const s = await getAllSettings();
    res.json({ clinic: s.clinic, financial: s.financial, medical: s.medical, inventory: s.inventory });
  }),
);

settingsRouter.put(
  '/:key',
  requirePerm('settings.manage'),
  ah(async (req, res) => {
    const key = req.params.key as SettingKey;
    if (!(key in settingSchemas)) throw notFound('إعداد غير معروف');
    const current = await getSetting(key);
    const value = (settingSchemas[key] as z.AnyZodObject).parse({ ...current, ...req.body });
    await prisma.$transaction(async (tx) => {
      await tx.setting.upsert({ where: { key }, create: { key, value, updatedBy: req.ctx.userId }, update: { value, updatedBy: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'settings.update', entityType: 'setting', entityId: key, before: current, after: value });
    });
    res.json(value);
  }),
);

// ── Simple catalogs ──
settingsRouter.use('/visit-types', catalogRouter({
  model: 'visitType', entity: 'visit_type', orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  schema: z.object({ name: z.string().trim().min(1).max(80), color: nullableStr(20), durationMin: z.coerce.number().int().min(5).max(480).default(15), sortOrder: z.coerce.number().int().default(0), isActive: z.boolean().optional() }),
}));
settingsRouter.use('/expense-categories', catalogRouter({
  model: 'expenseCategory', entity: 'expense_category', orderBy: { name: 'asc' },
  schema: z.object({ name: z.string().trim().min(1).max(80), isActive: z.boolean().optional() }),
}));
settingsRouter.use('/inventory-categories', catalogRouter({
  model: 'inventoryCategory', entity: 'inventory_category', orderBy: { name: 'asc' },
  schema: z.object({ name: z.string().trim().min(1).max(80), isActive: z.boolean().optional() }),
}));
settingsRouter.use('/units', catalogRouter({
  model: 'unit', entity: 'unit', orderBy: { name: 'asc' },
  schema: z.object({ name: z.string().trim().min(1).max(40), symbol: nullableStr(10), isActive: z.boolean().optional() }),
}));
settingsRouter.use('/drugs', catalogRouter({
  model: 'drug', entity: 'drug', orderBy: { name: 'asc' }, searchFields: ['name', 'genericName'],
  schema: z.object({
    name: z.string().trim().min(1).max(120), genericName: nullableStr(120), form: nullableStr(60), strength: nullableStr(60),
    defaultDose: nullableStr(60), defaultFrequency: nullableStr(60), defaultRoute: nullableStr(60), isActive: z.boolean().optional(),
  }),
}));
settingsRouter.use('/diagnosis-codes', catalogRouter({
  model: 'diagnosisCode', entity: 'diagnosis_code', idField: 'code', orderBy: { code: 'asc' }, searchFields: ['code', 'name', 'nameAr'],
  schema: z.object({ code: z.string().trim().toUpperCase().min(1).max(12), name: z.string().trim().min(1).max(200), nameAr: nullableStr(200), isActive: z.boolean().optional() }),
}));
settingsRouter.use('/payment-methods', catalogRouter({
  model: 'paymentMethod', entity: 'payment_method', orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  schema: z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, 'الرمز: أحرف إنجليزية كبيرة وأرقام'), name: z.string().trim().min(1).max(60),
    requiresReference: z.boolean().default(false), sortOrder: z.coerce.number().int().default(0), isActive: z.boolean().optional(),
  }),
}));
settingsRouter.use('/services', catalogRouter({
  model: 'service', entity: 'service', orderBy: [{ category: 'asc' }, { name: 'asc' }], searchFields: ['name', 'code'],
  baseWhere: { deletedAt: null }, include: { inventoryItem: { select: { id: true, name: true, quantity: true } } },
  schema: z.object({
    code: z.string().trim().toUpperCase().min(1).max(20), name: z.string().trim().min(1).max(120), category: z.nativeEnum(ServiceCategory),
    price: money, taxRate: z.coerce.number().min(0).max(100).default(0), allowPriceEdit: z.boolean().default(false),
    inventoryItemId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional(),
  }),
}));
settingsRouter.use('/lab-tests', catalogRouter({
  model: 'labTest', entity: 'lab_test', orderBy: [{ category: 'asc' }, { name: 'asc' }], searchFields: ['name', 'code'],
  include: { service: { select: { id: true, name: true, price: true } } },
  schema: z.object({
    code: z.string().trim().toUpperCase().min(1).max(20), name: z.string().trim().min(1).max(120), category: nullableStr(60),
    sampleType: nullableStr(60), unit: nullableStr(30), referenceRange: nullableStr(120),
    parameters: z.array(z.object({ name: z.string().min(1).max(80), unit: z.string().max(30).optional(), referenceRange: z.string().max(120).optional() })).max(60).nullable().optional(),
    serviceId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional(),
  }),
}));
settingsRouter.use('/shifts', catalogRouter({
  model: 'shift', entity: 'shift', orderBy: { startTime: 'asc' },
  schema: z.object({ name: z.string().trim().min(1).max(60), type: z.nativeEnum(ShiftType), startTime: hhmm, endTime: hhmm, color: nullableStr(20), isActive: z.boolean().optional() }),
}));

// ── Invoice templates (models) with mandatory items ──
const templateBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: nullableStr(300),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  items: z.array(z.object({ serviceId: z.string().uuid(), quantity: z.coerce.number().positive().max(1000).default(1), isMandatory: z.boolean().default(true) })).max(50),
});

settingsRouter.get(
  '/invoice-templates',
  ah(async (req, res) => {
    const all = req.query.all === 'true';
    res.json(
      await prisma.invoiceTemplate.findMany({
        where: all ? {} : { isActive: true },
        include: { items: { include: { service: true } } },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
    );
  }),
);

async function saveTemplate(id: string | null, body: z.infer<typeof templateBody>, ctx: Express.Request['ctx']) {
  if (new Set(body.items.map((i) => i.serviceId)).size !== body.items.length) throw badRequest('لا يمكن تكرار نفس المادة في النموذج');
  return prisma.$transaction(async (tx) => {
    if (body.isDefault) await tx.invoiceTemplate.updateMany({ where: { isDefault: true, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } });
    const before = id ? await tx.invoiceTemplate.findUnique({ where: { id }, include: { items: true } }) : null;
    if (id && !before) throw notFound();
    const data = { name: body.name, description: body.description, isDefault: body.isDefault, isActive: body.isActive };
    const t = id ? await tx.invoiceTemplate.update({ where: { id }, data }) : await tx.invoiceTemplate.create({ data });
    await tx.invoiceTemplateItem.deleteMany({ where: { templateId: t.id } });
    if (body.items.length) await tx.invoiceTemplateItem.createMany({ data: body.items.map((i) => ({ ...i, templateId: t.id })) });
    await audit(tx, ctx, { action: id ? 'invoice_template.update' : 'invoice_template.create', entityType: 'invoice_template', entityId: t.id, before, after: body });
    return t;
  });
}

settingsRouter.post('/invoice-templates', requirePerm('settings.manage'), ah(async (req, res) => {
  res.status(201).json(await saveTemplate(null, parse(templateBody, req.body), req.ctx));
}));
settingsRouter.put('/invoice-templates/:id', requirePerm('settings.manage'), ah(async (req, res) => {
  res.json(await saveTemplate(req.params.id, parse(templateBody, req.body), req.ctx));
}));

// ── Clinic logo ──
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

settingsRouter.post(
  '/logo',
  requirePerm('settings.manage'),
  logoUpload.single('file'),
  ah(async (req, res) => {
    const file = req.file;
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype) || !sniffMatches(file.buffer, file.mimetype)) {
      throw badRequest('الشعار يجب أن يكون صورة PNG أو JPG أو WEBP');
    }
    const key = await storage.put(file.buffer, file.originalname);
    const clinic = await getSetting('clinic');
    await prisma.$transaction(async (tx) => {
      await tx.attachment.create({ data: { fileName: file.originalname, mimeType: file.mimetype, size: file.size, storageKey: key, category: 'IMAGE', description: 'clinic-logo', uploadedById: req.ctx.userId } });
      await tx.setting.upsert({ where: { key: 'clinic' }, create: { key: 'clinic', value: { ...clinic, logoKey: key } }, update: { value: { ...clinic, logoKey: key } } });
      await audit(tx, req.ctx, { action: 'settings.logo', entityType: 'setting', entityId: 'clinic', summary: 'تحديث شعار العيادة' });
    });
    res.json({ ok: true });
  }),
);
