import { Router } from 'express';
import { z } from 'zod';
import { AllergySeverity, Gender, HistoryType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr, optionalDate, pageQuery, paged, paginate, sortBy } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { AppError, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { nextCounter, pad } from '../../lib/counters';
import { latinDigits, normalizePhone } from '../../lib/phone';
import { ageFrom } from '../../lib/dates';
import { can } from '../../auth/context';

export const patientsRouter = Router();

const phoneField = z
  .string()
  .trim()
  .transform(normalizePhone)
  .refine((v) => /^\d{7,15}$/.test(v), 'رقم هاتف غير صالح');
const optPhone = z.preprocess((v) => (v === '' ? null : v), phoneField.nullable().optional());

const patientBody = z.object({
  fullName: z.string().trim().min(3, 'الاسم الكامل مطلوب').max(150).transform((s) => s.replace(/\s+/g, ' ')),
  phone: phoneField,
  altPhone: optPhone,
  gender: z.nativeEnum(Gender, { errorMap: () => ({ message: 'اختر الجنس' }) }),
  dateOfBirth: optionalDate.refine((d) => !d || d <= new Date(), 'تاريخ الميلاد في المستقبل'),
  nationality: nullableStr(60),
  nationalId: z.preprocess((v) => (typeof v === 'string' ? latinDigits(v).trim() || null : v), z.string().max(30).nullable().optional()),
  address: nullableStr(300),
  bloodType: z.preprocess((v) => (v === '' ? null : v), z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullable().optional()),
  emergencyContactName: nullableStr(120),
  emergencyContactPhone: optPhone,
  emergencyContactRelation: nullableStr(60),
  notes: nullableStr(2000),
  familyHistory: nullableStr(2000),
});

export const patientListSelect = {
  id: true, fileNumber: true, fullName: true, phone: true, altPhone: true, gender: true, dateOfBirth: true,
  nationalId: true, lastVisitAt: true, visitCount: true, createdAt: true,
} satisfies Prisma.PatientSelect;

const withAge = <T extends { dateOfBirth: Date | null }>(p: T) => ({ ...p, age: ageFrom(p.dateOfBirth) });

export function patientSearchWhere(raw: string): Prisma.PatientWhereInput {
  const q = latinDigits(raw.trim());
  const digits = q.replace(/[\s-]/g, '');
  const or: Prisma.PatientWhereInput[] = [{ fullName: { contains: q, mode: 'insensitive' } }];
  if (/^\+?\d+$/.test(digits)) {
    const phone = normalizePhone(digits);
    or.push({ phone: { contains: phone } }, { altPhone: { contains: phone } }, { fileNumber: { contains: digits } }, { nationalId: { startsWith: digits } });
  } else {
    or.push({ fileNumber: { equals: q, mode: 'insensitive' } });
  }
  return { deletedAt: null, OR: or };
}

patientsRouter.get(
  '/',
  requirePerm('patients.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ gender: z.nativeEnum(Gender).optional() }), req.query);
    const where: Prisma.PatientWhereInput = { ...(q.q ? patientSearchWhere(q.q) : { deletedAt: null }), ...(q.gender && { gender: q.gender }) };
    const [items, total] = await Promise.all([
      prisma.patient.findMany({ where, select: patientListSelect, orderBy: sortBy(q.sort, ['fullName', 'createdAt', 'lastVisitAt', 'fileNumber', 'visitCount'] as const, 'createdAt', q.order), ...paginate(q) }),
      prisma.patient.count({ where }),
    ]);
    res.json(paged(items.map(withAge), total, q));
  }),
);

/** Reception fast path: exact phone match (one phone may belong to several family members). */
patientsRouter.get(
  '/lookup',
  requirePerm('patients.view'),
  ah(async (req, res) => {
    const { phone } = parse(z.object({ phone: z.string().min(3).max(30) }), req.query);
    const p = normalizePhone(phone);
    const items = await prisma.patient.findMany({
      where: { deletedAt: null, OR: [{ phone: p }, { altPhone: p }] },
      select: patientListSelect,
      orderBy: { lastVisitAt: { sort: 'desc', nulls: 'last' } },
      take: 20,
    });
    res.json({ phone: p, items: items.map(withAge) });
  }),
);

async function findDuplicates(data: { fullName: string; phone: string; nationalId?: string | null }, excludeId?: string) {
  const or: Prisma.PatientWhereInput[] = [{ phone: data.phone, fullName: { equals: data.fullName, mode: 'insensitive' } }];
  if (data.nationalId) or.push({ nationalId: data.nationalId });
  return prisma.patient.findMany({
    where: { deletedAt: null, OR: or, ...(excludeId && { id: { not: excludeId } }) },
    select: patientListSelect,
    take: 5,
  });
}

patientsRouter.post(
  '/',
  requirePerm('patients.create'),
  ah(async (req, res) => {
    const body = parse(patientBody.extend({ force: z.boolean().optional() }), req.body);
    const { force, ...data } = body;
    const dups = await findDuplicates(data);
    // Same national ID is always a hard duplicate; same name+phone can be overridden deliberately (e.g. twins).
    if (dups.some((d) => data.nationalId && d.nationalId === data.nationalId)) {
      throw new AppError(409, 'DUPLICATE_PATIENT', 'يوجد مريض مسجل بنفس الرقم الوطني', { duplicates: dups.map(withAge), hard: true });
    }
    if (dups.length && !force) {
      throw new AppError(409, 'DUPLICATE_PATIENT', 'يوجد مريض مسجل بنفس الاسم ورقم الهاتف', { duplicates: dups.map(withAge) });
    }
    const patient = await prisma.$transaction(async (tx) => {
      const n = await nextCounter(tx, 'patient_file');
      const p = await tx.patient.create({ data: { ...data, fileNumber: pad(n, 6), createdById: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'patient.create', entityType: 'patient', entityId: p.id, summary: `تسجيل المريض ${p.fullName} (${p.fileNumber})`, after: p });
      return p;
    });
    res.status(201).json(withAge(patient));
  }),
);

patientsRouter.get(
  '/:id',
  requirePerm('patients.view'),
  ah(async (req, res) => {
    const medical = can(req.ctx, 'medical.view');
    const patient = await prisma.patient.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: medical
        ? {
            allergies: { orderBy: { createdAt: 'desc' } },
            histories: { orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] },
            medications: { orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] },
          }
        : undefined,
    });
    if (!patient) throw notFound('المريض غير موجود');
    const [balance, upcoming] = await Promise.all([
      can(req.ctx, 'invoices.view')
        ? prisma.invoice.aggregate({ where: { patientId: patient.id, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, _sum: { balance: true } })
        : null,
      prisma.appointment.findFirst({
        where: { patientId: patient.id, startAt: { gte: new Date() }, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
        orderBy: { startAt: 'asc' },
        include: { doctor: { select: { fullName: true } } },
      }),
    ]);
    if (!medical) {
      // Receptionists get demographics only; clinical free-text stays hidden.
      (patient as Partial<typeof patient>).familyHistory = undefined;
    }
    res.json({ ...withAge(patient), outstandingBalance: balance?._sum.balance ?? null, nextAppointment: upcoming, canViewMedical: medical });
  }),
);

patientsRouter.put(
  '/:id',
  requirePerm('patients.update'),
  ah(async (req, res) => {
    const body = parse(patientBody.partial(), req.body);
    const before = await prisma.patient.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!before) throw notFound('المريض غير موجود');
    if (body.familyHistory !== undefined && !can(req.ctx, 'medical.history.manage')) delete body.familyHistory;
    if (body.nationalId) {
      const dup = await prisma.patient.findFirst({ where: { nationalId: body.nationalId, id: { not: before.id }, deletedAt: null }, select: { fileNumber: true, fullName: true } });
      if (dup) throw new AppError(409, 'DUPLICATE_PATIENT', `الرقم الوطني مسجل للمريض ${dup.fullName} (${dup.fileNumber})`);
    }
    const patient = await prisma.$transaction(async (tx) => {
      const p = await tx.patient.update({ where: { id: before.id }, data: body });
      await audit(tx, req.ctx, { action: 'patient.update', entityType: 'patient', entityId: p.id, summary: `تعديل بيانات ${p.fullName}`, before, after: p });
      return p;
    });
    res.json(withAge(patient));
  }),
);

patientsRouter.delete(
  '/:id',
  requirePerm('patients.delete'),
  ah(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const p = await tx.patient.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'patient.archive', entityType: 'patient', entityId: p.id, summary: `أرشفة ملف ${p.fullName} (${p.fileNumber})` });
    });
    res.json({ ok: true });
  }),
);

// ── Medical history (allergies / conditions / medications) ──

const allergyBody = z.object({ allergen: z.string().trim().min(1).max(120), reaction: nullableStr(200), severity: z.nativeEnum(AllergySeverity).default('MODERATE'), notes: nullableStr(500) });
const historyBody = z.object({ type: z.nativeEnum(HistoryType), name: z.string().trim().min(1).max(200), icd10Code: nullableStr(12), since: nullableStr(40), notes: nullableStr(1000), isActive: z.boolean().default(true) });
const medicationBody = z.object({ name: z.string().trim().min(1).max(120), dose: nullableStr(60), frequency: nullableStr(60), notes: nullableStr(500), isActive: z.boolean().default(true) });

const subResources = [
  { path: 'allergies', model: 'allergy', entity: 'allergy', schema: allergyBody, label: (b: any) => b.allergen },
  { path: 'histories', model: 'medicalHistory', entity: 'medical_history', schema: historyBody, label: (b: any) => b.name },
  { path: 'medications', model: 'patientMedication', entity: 'patient_medication', schema: medicationBody, label: (b: any) => b.name },
] as const;

for (const sr of subResources) {
  patientsRouter.post(
    `/:id/${sr.path}`,
    requirePerm('medical.history.manage'),
    ah(async (req, res) => {
      const body = parse(sr.schema, req.body);
      const patient = await prisma.patient.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true } });
      if (!patient) throw notFound('المريض غير موجود');
      const row = await prisma.$transaction(async (tx) => {
        const created = await (tx as any)[sr.model].create({ data: { ...body, patientId: patient.id } });
        await audit(tx, req.ctx, { action: `${sr.entity}.create`, entityType: 'patient', entityId: patient.id, summary: `إضافة ${sr.label(body)}`, after: created });
        return created;
      });
      res.status(201).json(row);
    }),
  );
  patientsRouter.put(
    `/:id/${sr.path}/:itemId`,
    requirePerm('medical.history.manage'),
    ah(async (req, res) => {
      const body = parse((sr.schema as z.AnyZodObject).partial(), req.body);
      const before = await (prisma as any)[sr.model].findFirst({ where: { id: req.params.itemId, patientId: req.params.id } });
      if (!before) throw notFound();
      const row = await prisma.$transaction(async (tx) => {
        const updated = await (tx as any)[sr.model].update({ where: { id: before.id }, data: body });
        await audit(tx, req.ctx, { action: `${sr.entity}.update`, entityType: 'patient', entityId: req.params.id, before, after: updated });
        return updated;
      });
      res.json(row);
    }),
  );
  patientsRouter.delete(
    `/:id/${sr.path}/:itemId`,
    requirePerm('medical.history.manage'),
    ah(async (req, res) => {
      const before = await (prisma as any)[sr.model].findFirst({ where: { id: req.params.itemId, patientId: req.params.id } });
      if (!before) throw notFound();
      await prisma.$transaction(async (tx) => {
        await (tx as any)[sr.model].delete({ where: { id: before.id } });
        await audit(tx, req.ctx, { action: `${sr.entity}.delete`, entityType: 'patient', entityId: req.params.id, summary: `حذف ${sr.label(before)}`, before });
      });
      res.json({ ok: true });
    }),
  );
}

// ── Visit history ──

/** Non-clinical visit list (reception can see dates/doctor/status). */
patientsRouter.get(
  '/:id/visits',
  requirePerm('patients.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery, req.query);
    const where = { patientId: req.params.id };
    const [items, total] = await Promise.all([
      prisma.visit.findMany({
        where,
        select: {
          id: true, visitNumber: true, status: true, priority: true, arrivedAt: true, completedAt: true,
          doctor: { select: { id: true, fullName: true } }, visitType: { select: { name: true } },
          ...(can(req.ctx, 'medical.view') && { chiefComplaint: true }),
        },
        orderBy: { arrivedAt: 'desc' },
        ...paginate(q),
      }),
      prisma.visit.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);

/** Full clinical timeline — every visit with all clinical data. */
patientsRouter.get(
  '/:id/timeline',
  requirePerm('medical.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(50).default(10) }), req.query);
    const where = { patientId: req.params.id, status: { notIn: ['CANCELLED', 'NO_SHOW'] as never[] } };
    const [items, total] = await Promise.all([
      prisma.visit.findMany({
        where,
        orderBy: { arrivedAt: 'desc' },
        ...paginate(q),
        include: {
          doctor: { select: { id: true, fullName: true, specialty: true } },
          visitType: { select: { name: true, color: true } },
          vitalSigns: { orderBy: { recordedAt: 'desc' } },
          consultation: true,
          diagnoses: { where: { deletedAt: null } },
          prescriptions: { include: { items: { orderBy: { sortOrder: 'asc' } } } },
          labOrders: { include: { items: { include: { results: true } } } },
          medicalReports: { select: { id: true, title: true, createdAt: true } },
          nursingNotes: { orderBy: { performedAt: 'desc' } },
          attachments: { where: { deletedAt: null }, select: { id: true, fileName: true, mimeType: true, category: true, createdAt: true } },
        },
      }),
      prisma.visit.count({ where }),
    ]);
    res.json(paged(items, total, q));
  }),
);
