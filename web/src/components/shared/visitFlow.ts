import type { VisitStatus } from '@/lib/types';

export const FLOW: VisitStatus[] = ['WAITING', 'CALLED', 'WITH_NURSE', 'WITH_DOCTOR', 'IN_LAB', 'WAITING_PAYMENT', 'COMPLETED'];
export const ACTIVE: VisitStatus[] = ['WAITING', 'CALLED', 'WITH_NURSE', 'WITH_DOCTOR', 'IN_LAB', 'WAITING_PAYMENT'];

/** Mirrors server/src/modules/visits/stateMachine.ts so the UI only offers allowed moves. */
const TARGET_PERMS: Record<VisitStatus, string[]> = {
  WAITING: ['queue.manage', 'queue.call'], CALLED: ['queue.call'], WITH_NURSE: ['queue.call'], WITH_DOCTOR: ['queue.call', 'consultation.manage'],
  IN_LAB: ['queue.call', 'consultation.manage'], WAITING_PAYMENT: ['queue.call', 'consultation.manage'],
  COMPLETED: ['queue.manage', 'consultation.manage', 'payments.create'], CANCELLED: ['queue.manage'], NO_SHOW: ['queue.manage'],
};

export function allowedTargets(from: VisitStatus, canAny: (...p: string[]) => boolean, can: (p: string) => boolean): { status: VisitStatus; revert: boolean }[] {
  const out: { status: VisitStatus; revert: boolean }[] = [];
  const terminal = ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(from);
  for (const to of [...FLOW, 'CANCELLED', 'NO_SHOW'] as VisitStatus[]) {
    if (to === from || !canAny(...TARGET_PERMS[to])) continue;
    if (to === 'CANCELLED' || to === 'NO_SHOW') {
      if (terminal) continue;
      if (to === 'NO_SHOW' && !['WAITING', 'CALLED'].includes(from)) continue;
      out.push({ status: to, revert: false });
      continue;
    }
    const normalReturn = from === 'IN_LAB' && to === 'WITH_DOCTOR';
    const revert = !normalReturn && (terminal || FLOW.indexOf(to) < FLOW.indexOf(from));
    if (revert && !can('queue.revert')) continue;
    out.push({ status: to, revert });
  }
  return out;
}
