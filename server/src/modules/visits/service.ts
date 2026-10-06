import { Priority, VisitStatus } from '@prisma/client';
import type { Ctx } from '../../auth/context';
import type { Tx } from '../../lib/prisma';
import { audit } from '../../lib/audit';
import { nextCounter, pad } from '../../lib/counters';
import { dateOnly, ymd } from '../../lib/dates';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { ACTIVE_STATUSES, checkTransition } from './stateMachine';
import { resolveVisitPayer } from '../insurance/coverage';

const PRIORITY_RANK: Record<Priority, number> = { EMERGENCY: 3, URGENT: 2, NORMAL: 1 };

/**
 * Position for a new/re-prioritised entry: after every waiting entry of equal or higher priority,
 * before the first one with a lower priority. Positions are floats so we can insert between neighbours.
 */
export async function positionFor(tx: Tx, queueDate: Date, branchId: string | null, priority: Priority, excludeId?: string) {
  const waiting = await tx.visit.findMany({
    where: { queueDate, branchId, isDirect: false, status: { in: ACTIVE_STATUSES }, ...(excludeId && { id: { not: excludeId } }) },
    select: { priority: true, queuePosition: true, status: true },
    orderBy: { queuePosition: 'asc' },
  });
  if (!waiting.length) return 1000;
  const rank = PRIORITY_RANK[priority];
  const idx = waiting.findIndex((w) => w.status === 'WAITING' && PRIORITY_RANK[w.priority] < rank);
  const pos = (i: number) => waiting[i].queuePosition ?? 0;
  if (idx === -1) return pos(waiting.length - 1) + 1000;
  const prev = idx > 0 ? pos(idx - 1) : pos(idx) - 2000;
  return (prev + pos(idx)) / 2;
}

export interface CreateVisitInput {
  patientId: string;
  doctorId?: string | null;
  visitTypeId?: string | null;
  priority?: Priority;
  chiefComplaint?: string | null;
  notes?: string | null;
  appointmentId?: string | null;
  allowDuplicate?: boolean;
  payerType?: 'SELF_PAY' | 'INSURANCE';
  patientInsuranceId?: string | null;
}

export async function createVisit(tx: Tx, ctx: Ctx, input: CreateVisitInput) {
  const patient = await tx.patient.findFirst({ where: { id: input.patientId, deletedAt: null } });
  if (!patient) throw notFound('المريض غير موجود');
  if (input.doctorId) {
    const doc = await tx.user.findFirst({ where: { id: input.doctorId, isActive: true, deletedAt: null, staffType: 'DOCTOR' } });
    if (!doc) throw badRequest('الطبيب المحدد غير متاح');
  }
  const now = new Date();
  const queueDate = dateOnly(now);
  if (!input.allowDuplicate) {
    const active = await tx.visit.findFirst({ where: { patientId: patient.id, queueDate, status: { in: ACTIVE_STATUSES } }, select: { id: true, queueNumber: true } });
    if (active) throw new AppError(409, 'ACTIVE_VISIT', `المريض موجود حالياً في قائمة الانتظار (رقم ${active.queueNumber})`, { visitId: active.id });
  }
  const payer = await resolveVisitPayer(tx, patient.id, input);
  const priority = input.priority ?? 'NORMAL';
  const queueNumber = await nextCounter(tx, `queue:${ymd(now)}:${ctx.branchId ?? 'main'}`);
  const visitSeq = await nextCounter(tx, 'visit');
  const visit = await tx.visit.create({
    data: {
      visitNumber: `V-${pad(visitSeq, 7)}`,
      patientId: patient.id,
      doctorId: input.doctorId ?? null,
      visitTypeId: input.visitTypeId ?? null,
      appointmentId: input.appointmentId ?? null,
      branchId: ctx.branchId,
      priority,
      chiefComplaint: input.chiefComplaint ?? null,
      notes: input.notes ?? null,
      queueDate,
      queueNumber,
      queuePosition: await positionFor(tx, queueDate, ctx.branchId, priority),
      ...payer,
      createdById: ctx.userId,
      statusLogs: { create: { toStatus: 'WAITING', userId: ctx.userId } },
    },
  });
  await tx.patient.update({
    where: { id: patient.id },
    data: { visitCount: { increment: 1 }, lastVisitAt: now, ...(patient.firstVisitAt ? {} : { firstVisitAt: now }) },
  });
  if (input.appointmentId) await tx.appointment.update({ where: { id: input.appointmentId }, data: { status: 'ARRIVED' } });
  await audit(tx, ctx, { action: 'visit.create', entityType: 'visit', entityId: visit.id, summary: `زيارة ${visit.visitNumber} للمريض ${patient.fullName} — دور ${queueNumber}`, after: visit });
  return visit;
}

export interface DirectVisitInput {
  patientId: string;
  doctorId?: string | null;
  visitTypeId?: string | null;
  chiefComplaint?: string | null;
  notes?: string | null;
  /** When the visit took place; defaults to now. Past dates allow recording an earlier visit. */
  visitedAt?: Date | null;
  payerType?: 'SELF_PAY' | 'INSURANCE';
  patientInsuranceId?: string | null;
}

/**
 * A visit opened straight with the doctor: no queue number and never listed in the waiting queue.
 * Everything else (vitals, diagnosis, prescription, labs, invoice, history) works exactly like a normal visit.
 */
export async function createDirectVisit(tx: Tx, ctx: Ctx, input: DirectVisitInput) {
  const patient = await tx.patient.findFirst({ where: { id: input.patientId, deletedAt: null } });
  if (!patient) throw notFound('المريض غير موجود');
  const doctorId = input.doctorId ?? (ctx.staffType === 'DOCTOR' ? ctx.userId : null);
  if (!doctorId) throw badRequest('اختر الطبيب');
  const doc = await tx.user.findFirst({ where: { id: doctorId, isActive: true, deletedAt: null, staffType: 'DOCTOR' } });
  if (!doc) throw badRequest('الطبيب المحدد غير متاح');
  const now = new Date();
  const at = input.visitedAt ?? now;
  if (at.getTime() > now.getTime() + 5 * 60_000) throw badRequest('لا يمكن فتح زيارة بتاريخ مستقبلي');
  const payer = await resolveVisitPayer(tx, patient.id, input);
  const visitSeq = await nextCounter(tx, 'visit');
  const visit = await tx.visit.create({
    data: {
      visitNumber: `V-${pad(visitSeq, 7)}`,
      patientId: patient.id,
      doctorId,
      ...payer,
      visitTypeId: input.visitTypeId ?? null,
      branchId: ctx.branchId,
      status: 'WITH_DOCTOR',
      isDirect: true,
      chiefComplaint: input.chiefComplaint ?? null,
      notes: input.notes ?? null,
      queueDate: dateOnly(at),
      queueNumber: null,
      queuePosition: null,
      arrivedAt: at,
      doctorStartedAt: at,
      createdById: ctx.userId,
      statusLogs: { create: { toStatus: 'WITH_DOCTOR', userId: ctx.userId, note: 'زيارة مباشرة' } },
    },
  });
  await tx.patient.update({
    where: { id: patient.id },
    data: {
      visitCount: { increment: 1 },
      ...(!patient.lastVisitAt || patient.lastVisitAt < at ? { lastVisitAt: at } : {}),
      ...(!patient.firstVisitAt || patient.firstVisitAt > at ? { firstVisitAt: at } : {}),
    },
  });
  await audit(tx, ctx, { action: 'visit.create_direct', entityType: 'visit', entityId: visit.id, summary: `زيارة مباشرة ${visit.visitNumber} للمريض ${patient.fullName} مع ${doc.fullName}`, after: visit });
  return visit;
}

const STATUS_TIMESTAMP: Partial<Record<VisitStatus, 'calledAt' | 'nurseStartedAt' | 'doctorStartedAt' | 'completedAt'>> = {
  CALLED: 'calledAt',
  WITH_NURSE: 'nurseStartedAt',
  WITH_DOCTOR: 'doctorStartedAt',
  COMPLETED: 'completedAt',
};

export async function changeVisitStatus(tx: Tx, ctx: Ctx, visitId: string, to: VisitStatus, note?: string | null, opts: { system?: boolean } = {}) {
  const visit = await tx.visit.findUnique({ where: { id: visitId } });
  if (!visit) throw notFound('الزيارة غير موجودة');
  if (!opts.system) {
    if (!ctx.perms.has('queue.view_all') && visit.doctorId && visit.doctorId !== ctx.userId) throw forbidden('هذه الزيارة ليست ضمن قائمتك');
    const check = checkTransition(visit.status, to, ctx.perms);
    if (!check.ok) throw badRequest(check.reason);
  }
  if (visit.isDirect && (to === 'WAITING' || to === 'CALLED' || to === 'NO_SHOW')) throw badRequest('الزيارة المباشرة ليست ضمن قائمة الانتظار');
  if ((to === 'CANCELLED' || to === 'NO_SHOW') && !note && !opts.system) throw badRequest('يرجى ذكر سبب الإلغاء');

  const stamp = STATUS_TIMESTAMP[to];
  const data: Record<string, unknown> = { status: to };
  if (stamp && !(visit as Record<string, unknown>)[stamp]) data[stamp] = new Date();
  if (to === 'CANCELLED' || to === 'NO_SHOW') data.cancelReason = note;
  // A doctor who takes an unassigned patient becomes the visit's doctor.
  if (to === 'WITH_DOCTOR' && !visit.doctorId && ctx.staffType === 'DOCTOR') data.doctorId = ctx.userId;

  const updated = await tx.visit.update({ where: { id: visit.id }, data });
  await tx.visitStatusLog.create({ data: { visitId: visit.id, fromStatus: visit.status, toStatus: to, userId: ctx.userId, note: note ?? null } });
  if (visit.appointmentId && (to === 'COMPLETED' || to === 'NO_SHOW' || to === 'CANCELLED')) {
    await tx.appointment.update({ where: { id: visit.appointmentId }, data: { status: to === 'COMPLETED' ? 'COMPLETED' : to === 'NO_SHOW' ? 'NO_SHOW' : 'CANCELLED' } });
  }
  await audit(tx, ctx, { action: 'visit.status', entityType: 'visit', entityId: visit.id, summary: `${visit.visitNumber}: ${visit.status} → ${to}`, before: { status: visit.status }, after: { status: to, note } });
  return updated;
}
