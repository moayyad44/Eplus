import { VisitStatus } from '@prisma/client';
import type { PermissionKey } from '../../auth/permissions';

/** Main clinical flow. Skipping forward is allowed (e.g. no nurse step); going back needs queue.revert. */
export const FLOW: VisitStatus[] = ['WAITING', 'CALLED', 'WITH_NURSE', 'WITH_DOCTOR', 'IN_LAB', 'WAITING_PAYMENT', 'COMPLETED'];
export const ACTIVE_STATUSES: VisitStatus[] = ['WAITING', 'CALLED', 'WITH_NURSE', 'WITH_DOCTOR', 'IN_LAB', 'WAITING_PAYMENT'];
export const TERMINAL: VisitStatus[] = ['COMPLETED', 'CANCELLED', 'NO_SHOW'];

/** Any one of these permissions allows moving a visit INTO the given status. */
export const TARGET_PERMISSIONS: Record<VisitStatus, PermissionKey[]> = {
  WAITING: ['queue.manage', 'queue.call'],
  CALLED: ['queue.call'],
  WITH_NURSE: ['queue.call'],
  WITH_DOCTOR: ['queue.call', 'consultation.manage'],
  IN_LAB: ['queue.call', 'consultation.manage'],
  WAITING_PAYMENT: ['queue.call', 'consultation.manage'],
  COMPLETED: ['queue.manage', 'consultation.manage', 'payments.create'],
  CANCELLED: ['queue.manage'],
  NO_SHOW: ['queue.manage'],
};

export type TransitionCheck = { ok: true; revert: boolean } | { ok: false; reason: string };

export function checkTransition(from: VisitStatus, to: VisitStatus, perms: Set<string>): TransitionCheck {
  if (from === to) return { ok: false, reason: 'الزيارة بالفعل في هذه الحالة' };
  if (!TARGET_PERMISSIONS[to].some((p) => perms.has(p))) return { ok: false, reason: 'ليست لديك صلاحية لنقل الزيارة إلى هذه الحالة' };

  if (to === 'CANCELLED' || to === 'NO_SHOW') {
    if (TERMINAL.includes(from)) return { ok: false, reason: 'لا يمكن إلغاء زيارة منتهية' };
    if (to === 'NO_SHOW' && !['WAITING', 'CALLED'].includes(from)) return { ok: false, reason: 'حالة عدم الحضور متاحة فقط قبل دخول المريض' };
    return { ok: true, revert: false };
  }
  const fi = FLOW.indexOf(from);
  const ti = FLOW.indexOf(to);
  // Returning from the lab to the doctor is part of the normal flow, not a revert.
  const normalReturn = from === 'IN_LAB' && to === 'WITH_DOCTOR';
  const revert = !normalReturn && (TERMINAL.includes(from) || ti < fi);
  if (revert && !perms.has('queue.revert')) return { ok: false, reason: 'إرجاع الزيارة إلى حالة سابقة يتطلب صلاحية خاصة' };
  return { ok: true, revert };
}
