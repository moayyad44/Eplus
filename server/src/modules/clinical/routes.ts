import { Router } from 'express';
import { z } from 'zod';
import { DiagnosisType } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, nullableStr, optionalDate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { ageFrom } from '../../lib/dates';

export const clinicalRouter = Router();

async function loadVisit(tx: Tx | typeof prisma, id: string, { editable = true } = {}) {
  const v = await tx.visit.findUnique({ where: { id }, select: { id: true, patientId: true, doctorId: true, status: true, visitNumber: true } });
  if (!v) throw notFound('الزيارة غير موجودة');
  if (editable && ['CANCELLED', 'NO_SHOW'].includes(v.status)) throw badRequest('لا يمكن التعديل على زيارة ملغاة');
  return v;
}

const intIn = (min: number, max: number, label: string) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.number().int().min(min, `${label} غير منطقي`).max(max, `${label} غير منطقي`).optional());
const decIn = (min: number, max: number, label: string) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.number().min(min, `${label} غير منطقي`).max(max, `${label} غير منطقي`).optional());

// ── Vital signs ──
const vitalsBody = z
  .object({
    bpSystolic: intIn(40, 300, 'الضغط الانقباضي'),
    bpDiastolic: intIn(20, 200, 'الضغط الانبساطي'),
    heartRate: intIn(20, 250, 'النبض'),
    temperature: decIn(30, 45, 'الحرارة'),
    oxygenSaturation: intIn(40, 100, 'نسبة الأكسجين'),
    respiratoryRate: intIn(4, 80, 'معدل التنفس'),
    weightKg: decIn(0.3, 400, 'الوزن'),
    heightCm: decIn(20, 250, 'الطول'),
    bloodGlucose: intIn(10, 1000, 'السكر'),
    painScore: intIn(0, 10, 'درجة الألم'),
    notes: nullableStr(1000),
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'notes' && x !== undefined), 'أدخل قراءة واحدة على الأقل')
  .refine((v) => !(v.bpSystolic && v.bpDiastolic) || v.bpSystolic > v.bpDiastolic, { message: 'الضغط الانقباضي يجب أن يكون أعلى من الانبساطي', path: ['bpDiastolic'] });

clinicalRouter.post(
  '/visits/:id/vitals',
  requirePerm('vitals.record'),
  ah(async (req, res) => {
    const body = parse(vitalsBody, req.body);
    const bmi = body.weightKg && body.heightCm ? Math.round((body.weightKg / (body.heightCm / 100) ** 2) * 10) / 10 : undefined;
    const row = await prisma.$transaction(async (tx) => {
      const v = await loadVisit(tx, req.params.id);
      const created = await tx.vitalSigns.create({ data: { ...body, bmi, visitId: v.id, patientId: v.patientId, recordedById: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'vitals.create', entityType: 'visit', entityId: v.id, summary: `تسجيل علامات حيوية ${v.visitNumber}`, after: created });
      return created;
    });
    res.status(201).json(row);
  }),
);

// ── Nursing procedures ──
clinicalRouter.post(
  '/visits/:id/nursing-notes',
  requirePerm('nursing.record'),
  ah(async (req, res) => {
    const body = parse(z.object({ procedure: z.string().trim().min(2).max(200), notes: nullableStr(2000) }), req.body);
    const row = await prisma.$transaction(async (tx) => {
      const v = await loadVisit(tx, req.params.id);
      const created = await tx.nursingNote.create({ data: { ...body, visitId: v.id, performedById: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'nursing_note.create', entityType: 'visit', entityId: v.id, summary: body.procedure, after: created });
      return created;
    });
    res.status(201).json(row);
  }),
);

// ── Consultation (one per visit) ──
clinicalRouter.put(
  '/visits/:id/consultation',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        chiefComplaint: nullableStr(1000), presentIllness: nullableStr(5000), examination: nullableStr(5000),
        clinicalNotes: nullableStr(10000), treatmentPlan: nullableStr(5000), followUpDate: optionalDate,
      }),
      req.body,
    );
    const row = await prisma.$transaction(async (tx) => {
      const v = await loadVisit(tx, req.params.id);
      const before = await tx.consultation.findUnique({ where: { visitId: v.id } });
      const saved = await tx.consultation.upsert({
        where: { visitId: v.id },
        create: { ...body, visitId: v.id, doctorId: req.ctx.userId },
        update: body,
      });
      if (!v.doctorId && req.ctx.staffType === 'DOCTOR') await tx.visit.update({ where: { id: v.id }, data: { doctorId: req.ctx.userId } });
      if (body.chiefComplaint) await tx.visit.update({ where: { id: v.id }, data: { chiefComplaint: body.chiefComplaint } });
      await audit(tx, req.ctx, { action: before ? 'consultation.update' : 'consultation.create', entityType: 'visit', entityId: v.id, summary: `الكشف الطبي ${v.visitNumber}`, before, after: saved });
      return saved;
    });
    res.json(row);
  }),
);

// ── Diagnoses ──
clinicalRouter.post(
  '/visits/:id/diagnoses',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ icd10Code: nullableStr(12), description: z.string().trim().min(2, 'التشخيص مطلوب').max(300), type: z.nativeEnum(DiagnosisType).default('PRIMARY'), notes: nullableStr(1000) }),
      req.body,
    );
    const row = await prisma.$transaction(async (tx) => {
      const v = await loadVisit(tx, req.params.id);
      const created = await tx.diagnosis.create({ data: { ...body, icd10Code: body.icd10Code?.toUpperCase() ?? null, visitId: v.id, patientId: v.patientId, createdById: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'diagnosis.create', entityType: 'visit', entityId: v.id, summary: body.description, after: created });
      return created;
    });
    res.status(201).json(row);
  }),
);

clinicalRouter.delete(
  '/diagnoses/:id',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const d = await tx.diagnosis.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
      await audit(tx, req.ctx, { action: 'diagnosis.remove', entityType: 'visit', entityId: d.visitId, summary: `إزالة تشخيص: ${d.description}`, before: d });
    });
    res.json({ ok: true });
  }),
);

// ── Prescriptions ──
const rxBody = z.object({
  notes: nullableStr(2000),
  items: z
    .array(
      z.object({
        drugId: z.string().uuid().nullable().optional(),
        drugName: z.string().trim().min(1, 'اسم الدواء مطلوب').max(150),
        dose: nullableStr(60), frequency: nullableStr(60), duration: nullableStr(60), route: nullableStr(60), instructions: nullableStr(500),
      }),
    )
    .min(1, 'أضف دواءً واحداً على الأقل')
    .max(30),
});

clinicalRouter.post(
  '/visits/:id/prescriptions',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    const body = parse(rxBody, req.body);
    const rx = await prisma.$transaction(async (tx) => {
      const v = await loadVisit(tx, req.params.id);
      const created = await tx.prescription.create({
        data: {
          visitId: v.id, patientId: v.patientId, doctorId: req.ctx.userId, notes: body.notes,
          items: { create: body.items.map((i, idx) => ({ ...i, sortOrder: idx })) },
        },
        include: { items: true },
      });
      await audit(tx, req.ctx, { action: 'prescription.create', entityType: 'prescription', entityId: created.id, summary: `وصفة ${v.visitNumber}`, after: body });
      return created;
    });
    res.status(201).json(rx);
  }),
);

clinicalRouter.put(
  '/prescriptions/:id',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    const body = parse(rxBody, req.body);
    const rx = await prisma.$transaction(async (tx) => {
      const before = await tx.prescription.findUnique({ where: { id: req.params.id }, include: { items: true } });
      if (!before) throw notFound();
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId: before.id } });
      const updated = await tx.prescription.update({
        where: { id: before.id },
        data: { notes: body.notes, items: { create: body.items.map((i, idx) => ({ ...i, sortOrder: idx })) } },
        include: { items: true },
      });
      await audit(tx, req.ctx, {
        action: 'prescription.update', entityType: 'prescription', entityId: before.id, summary: 'تعديل وصفة طبية',
        before: { notes: before.notes, items: before.items.map(({ drugName, dose, frequency, duration, route, instructions }) => ({ drugName, dose, frequency, duration, route, instructions })) },
        after: body,
      });
      return updated;
    });
    res.json(rx);
  }),
);

/** Print payload for a prescription. */
clinicalRouter.get(
  '/prescriptions/:id',
  requirePerm('medical.view'),
  ah(async (req, res) => {
    const rx = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        doctor: { select: { fullName: true, specialty: true, licenseNumber: true } },
        patient: { select: { fullName: true, fileNumber: true, gender: true, dateOfBirth: true, phone: true, allergies: { select: { allergen: true } } } },
        visit: { select: { visitNumber: true, diagnoses: { where: { deletedAt: null }, select: { description: true, icd10Code: true } } } },
      },
    });
    if (!rx) throw notFound();
    res.json({ ...rx, patient: { ...rx.patient, age: ageFrom(rx.patient.dateOfBirth) } });
  }),
);

// ── Medical reports ──
const reportBody = z.object({ title: z.string().trim().min(2).max(200), content: z.string().trim().min(5, 'محتوى التقرير مطلوب').max(20000) });

clinicalRouter.post(
  '/visits/:id/reports',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    const body = parse(reportBody, req.body);
    const row = await prisma.$transaction(async (tx) => {
      const v = await loadVisit(tx, req.params.id);
      const created = await tx.medicalReport.create({ data: { ...body, visitId: v.id, patientId: v.patientId, doctorId: req.ctx.userId } });
      await audit(tx, req.ctx, { action: 'medical_report.create', entityType: 'medical_report', entityId: created.id, summary: body.title, after: created });
      return created;
    });
    res.status(201).json(row);
  }),
);

clinicalRouter.put(
  '/medical-reports/:id',
  requirePerm('consultation.manage'),
  ah(async (req, res) => {
    const body = parse(reportBody, req.body);
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.medicalReport.findUnique({ where: { id: req.params.id } });
      if (!before) throw notFound();
      const updated = await tx.medicalReport.update({ where: { id: before.id }, data: body });
      await audit(tx, req.ctx, { action: 'medical_report.update', entityType: 'medical_report', entityId: before.id, summary: body.title, before, after: updated });
      return updated;
    });
    res.json(row);
  }),
);

clinicalRouter.get(
  '/medical-reports/:id',
  requirePerm('medical.view'),
  ah(async (req, res) => {
    const r = await prisma.medicalReport.findUnique({
      where: { id: req.params.id },
      include: {
        doctor: { select: { fullName: true, specialty: true, licenseNumber: true } },
        patient: { select: { fullName: true, fileNumber: true, gender: true, dateOfBirth: true, nationalId: true } },
        visit: { select: { visitNumber: true, arrivedAt: true } },
      },
    });
    if (!r) throw notFound();
    res.json({ ...r, patient: { ...r.patient, age: ageFrom(r.patient.dateOfBirth) } });
  }),
);

clinicalRouter.get(
  '/patients/:id/reports',
  requirePerm('medical.view'),
  ah(async (req, res) => {
    res.json(
      await prisma.medicalReport.findMany({
        where: { patientId: req.params.id },
        include: { doctor: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }),
);
