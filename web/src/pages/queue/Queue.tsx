import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronsUp, Clock, FileText, HeartPulse, Megaphone, MoreVertical, Pencil, RefreshCw, Stethoscope, UserRound } from 'lucide-react';
import clsx from 'clsx';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtTime, minutesSince, duration, money, ymd } from '@/lib/format';
import type { Priority, VisitStatus } from '@/lib/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, Select, Skeleton, Tabs, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { useDoctors, useVisitTypes } from '@/components/shared/VisitQueueForm';
import { ACTIVE, allowedTargets } from '@/components/shared/visitFlow';

export interface QueueVisit {
  id: string; visitNumber: string; queueNumber: number; status: VisitStatus; priority: Priority; arrivedAt: string; calledAt: string | null; completedAt: string | null;
  chiefComplaint: string | null; notes: string | null; cancelReason: string | null;
  patient: { id: string; fullName: string; phone: string; fileNumber: string; gender: string; age: number | null };
  doctor: { id: string; fullName: string } | null; visitType: { id: string; name: string; color: string | null } | null;
  _count: { vitalSigns: number; labOrders: number; invoices: number };
  invoices: { id: string; status: string; balance: number; total: number }[];
}

type TabKey = 'ACTIVE' | 'WAITING' | 'WITH_NURSE' | 'WITH_DOCTOR' | 'WAITING_PAYMENT' | 'COMPLETED' | 'ALL';

export default function Queue() {
  const { t } = useTranslation();
  const { can, canAny, me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const doctors = useDoctors();
  const [date, setDate] = useState(ymd());
  const [doctorId, setDoctorId] = useState('');
  const [tab, setTab] = useState<TabKey>('ACTIVE');
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<QueueVisit | null>(null);
  const viewAll = can('queue.view_all');

  const q = useQuery({
    queryKey: ['queue', date, doctorId],
    queryFn: () => api.get<{ items: QueueVisit[]; counts: Record<string, number> }>('/visits/queue', { date, doctorId: doctorId || undefined }),
    refetchInterval: 15_000,
  });
  const items = useMemo(() => {
    const all = q.data?.items ?? [];
    if (tab === 'ALL') return all;
    if (tab === 'ACTIVE') return all.filter((v) => ACTIVE.includes(v.status));
    if (tab === 'WAITING') return all.filter((v) => v.status === 'WAITING' || v.status === 'CALLED');
    return all.filter((v) => v.status === tab);
  }, [q.data, tab]);
  const counts = q.data?.counts ?? {};
  const c = (...s: string[]) => s.reduce((a, k) => a + (counts[k] ?? 0), 0);

  const status = useApiMutation((v: { id: string; status: VisitStatus; note?: string }) => api.post(`/visits/${v.id}/status`, v), {
    invalidate: [['queue']],
    success: t('queue.statusChanged'),
  });
  const move = useApiMutation((v: { id: string; direction: 'up' | 'down' | 'top' }) => api.post(`/visits/${v.id}/move`, v), { invalidate: [['queue']], success: false });

  const changeTo = async (v: QueueVisit, to: VisitStatus) => {
    setMenu(null);
    if (to === 'CANCELLED' || to === 'NO_SHOW') {
      const reason = await confirm({ title: t(`enum.VisitStatus.${to}`), message: `${v.patient.fullName} — #${v.queueNumber}`, danger: true, reason: { label: t('queue.cancelReason'), required: true } });
      if (reason) status.mutate({ id: v.id, status: to, note: reason });
      return;
    }
    status.mutate({ id: v.id, status: to });
  };

  const primaryAction = (v: QueueVisit) => {
    const b = (label: string, icon: React.ReactNode, onClick: () => void, variant: 'primary' | 'secondary' = 'primary') => (
      <Button size="sm" variant={variant} icon={icon} onClick={onClick} loading={status.isPending && status.variables?.id === v.id}>{label}</Button>
    );
    switch (v.status) {
      case 'WAITING': return can('queue.call') && b(t('queue.call'), <Megaphone className="h-4 w-4" />, () => changeTo(v, 'CALLED'));
      case 'CALLED': return can('queue.call') && (
        <div className="flex gap-1.5">
          {b(t('queue.toNurse'), <HeartPulse className="h-4 w-4" />, () => changeTo(v, 'WITH_NURSE'), 'secondary')}
          {b(t('queue.toDoctor'), <Stethoscope className="h-4 w-4" />, () => changeTo(v, 'WITH_DOCTOR'))}
        </div>
      );
      case 'WITH_NURSE': return (
        <div className="flex gap-1.5">
          {can('vitals.record') && b(t('queue.vitals'), <HeartPulse className="h-4 w-4" />, () => nav(`/visits/${v.id}?tab=vitals`), 'secondary')}
          {can('queue.call') && b(t('queue.toDoctor'), <Stethoscope className="h-4 w-4" />, () => changeTo(v, 'WITH_DOCTOR'))}
        </div>
      );
      case 'WITH_DOCTOR':
      case 'IN_LAB':
        return can('consultation.manage') ? b(t('queue.consultation'), <Stethoscope className="h-4 w-4" />, () => nav(`/visits/${v.id}`)) : b(t('queue.openVisit'), <UserRound className="h-4 w-4" />, () => nav(`/visits/${v.id}`), 'secondary');
      case 'WAITING_PAYMENT': {
        const inv = v.invoices[0];
        if (inv) return can('invoices.view') && b(inv.status === 'PAID' ? t('queue.paid') : t('queue.unpaidBalance', { amount: money(inv.balance) }), <FileText className="h-4 w-4" />, () => nav(`/billing/invoices/${inv.id}`), 'secondary');
        return can('invoices.create') && b(t('queue.createInvoice'), <FileText className="h-4 w-4" />, () => nav(`/billing/invoices/new?visitId=${v.id}`));
      }
      default: return null;
    }
  };

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'ACTIVE', label: t('queue.active'), count: c(...ACTIVE) },
    { key: 'WAITING', label: t('enum.VisitStatus.WAITING'), count: c('WAITING', 'CALLED') },
    { key: 'WITH_NURSE', label: t('enum.VisitStatus.WITH_NURSE'), count: c('WITH_NURSE') },
    { key: 'WITH_DOCTOR', label: t('enum.VisitStatus.WITH_DOCTOR'), count: c('WITH_DOCTOR', 'IN_LAB') },
    { key: 'WAITING_PAYMENT', label: t('enum.VisitStatus.WAITING_PAYMENT'), count: c('WAITING_PAYMENT') },
    { key: 'COMPLETED', label: t('enum.VisitStatus.COMPLETED'), count: c('COMPLETED') },
    { key: 'ALL', label: t('common.all'), count: Object.values(counts).reduce((a, b) => a + b, 0) },
  ];

  return (
    <div>
      <PageHeader
        title={viewAll ? t('queue.title') : t('queue.myQueue')}
        subtitle={<span className="inline-flex items-center gap-1.5"><RefreshCw className={clsx('h-3.5 w-3.5', q.isFetching && 'animate-spin')} />{t('queue.autoRefresh')}</span>}
        actions={
          <>
            <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="!h-9 w-40" />
            {viewAll && (
              <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="!h-9 w-44">
                <option value="">{t('queue.allDoctors')}</option>
                {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
              </Select>
            )}
            {canAny('patients.create', 'queue.manage') && <Button size="sm" onClick={() => nav('/reception')}>{t('reception.addToQueue')}</Button>}
          </>
        }
      />
      <Card padded={false}>
        <div className="px-4 pt-2"><Tabs items={tabs} value={tab} onChange={setTab} /></div>
        <div className="p-3 sm:p-4">
          {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
          ) : items.length === 0 ? <EmptyState title={t('queue.empty')} /> : (
            <ul className="space-y-2">
              {items.map((v, idx) => {
                const waitingMin = minutesSince(v.arrivedAt);
                const active = ACTIVE.includes(v.status);
                const targets = allowedTargets(v.status, canAny, can);
                return (
                  <li
                    key={v.id}
                    className={clsx(
                      'relative flex flex-wrap items-center gap-3 rounded-2xl border bg-white p-3 transition sm:flex-nowrap sm:p-4',
                      v.priority === 'EMERGENCY' ? 'border-danger-100 bg-danger-50/40' : v.priority === 'URGENT' ? 'border-warning-100 bg-warning-50/30' : 'border-line',
                      !active && 'opacity-70',
                      v.doctor?.id === me?.user.id && active && 'ring-1 ring-primary-200',
                    )}
                  >
                    <div className={clsx('grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-2xl font-extrabold tabular-nums', v.priority === 'EMERGENCY' ? 'bg-danger-600 text-white' : v.priority === 'URGENT' ? 'bg-warning-100 text-warning-700' : 'bg-primary-50 text-primary-700')}>
                      {v.queueNumber}
                    </div>
                    <button onClick={() => nav(`/visits/${v.id}`)} className="min-w-0 flex-1 text-start">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-bold">{v.patient.fullName}</span>
                        <StatusBadge enumName="VisitStatus" value={v.status} />
                        {v.priority !== 'NORMAL' && <StatusBadge enumName="Priority" value={v.priority} dot={false} />}
                        {v._count.vitalSigns > 0 && <span title={t('queue.hasVitals')}><HeartPulse className="h-4 w-4 text-success-600" /></span>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted">
                        <span dir="ltr">{v.patient.phone}</span>
                        <span>{t(`enum.Gender.${v.patient.gender}`)}{v.patient.age != null && ` · ${t('common.yearsOld', { age: v.patient.age })}`}</span>
                        <span className="inline-flex items-center gap-1"><Stethoscope className="h-3.5 w-3.5" />{v.doctor?.fullName ?? t('queue.unassigned')}</span>
                        {v.visitType && <Badge tone="neutral" dot={false}>{v.visitType.name}</Badge>}
                        <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{fmtTime(v.arrivedAt)}{active && <b className={clsx('font-semibold', waitingMin > 30 ? 'text-danger-600' : 'text-ink-soft')}> · {duration(waitingMin)}</b>}</span>
                      </div>
                      {v.chiefComplaint && <p className="mt-1 line-clamp-1 text-xs text-ink-soft">{v.chiefComplaint}</p>}
                      {v.cancelReason && <p className="mt-1 text-xs text-danger-700">{v.cancelReason}</p>}
                    </button>
                    <div className="flex w-full items-center justify-end gap-1.5 sm:w-auto">
                      {primaryAction(v)}
                      {active && can('queue.reorder') && tab !== 'COMPLETED' && (
                        <div className="hidden flex-col sm:flex">
                          <IconButton size="sm" label={t('queue.moveUp')} disabled={idx === 0} onClick={() => move.mutate({ id: v.id, direction: 'up' })}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
                          <IconButton size="sm" label={t('queue.moveDown')} disabled={idx === items.length - 1} onClick={() => move.mutate({ id: v.id, direction: 'down' })}><ArrowDown className="h-3.5 w-3.5" /></IconButton>
                        </div>
                      )}
                      {(targets.length > 0 || can('queue.manage')) && (
                        <div className="relative">
                          <IconButton label={t('common.actions')} onClick={() => setMenu(menu === v.id ? null : v.id)}><MoreVertical className="h-4 w-4" /></IconButton>
                          {menu === v.id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                              <div className="absolute end-0 top-full z-20 mt-1 w-56 animate-pop-in rounded-xl border border-line bg-white p-1 shadow-pop">
                                <button onClick={() => nav(`/visits/${v.id}`)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-subtle"><UserRound className="h-4 w-4" />{t('queue.openVisit')}</button>
                                {can('queue.manage') && active && <button onClick={() => { setMenu(null); setEditing(v); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-subtle"><Pencil className="h-4 w-4" />{t('queue.edit')}</button>}
                                {can('queue.reorder') && active && <button onClick={() => { setMenu(null); move.mutate({ id: v.id, direction: 'top' }); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-subtle"><ChevronsUp className="h-4 w-4" />{t('queue.moveTop')}</button>}
                                {targets.length > 0 && <p className="px-3 pb-1 pt-2 text-[11px] font-bold text-ink-muted">{t('queue.changeStatus')}</p>}
                                {targets.map((tg) => (
                                  <button key={tg.status} onClick={() => changeTo(v, tg.status)} className={clsx('flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-sm hover:bg-surface-subtle', ['CANCELLED', 'NO_SHOW'].includes(tg.status) && 'text-danger-700')}>
                                    {tg.revert ? `${t('queue.revert')} ` : ''}{t(`enum.VisitStatus.${tg.status}`)}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
      {editing && <EditVisitDialog visit={editing} onClose={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['queue'] }); }} />}
    </div>
  );
}

function EditVisitDialog({ visit, onClose }: { visit: QueueVisit; onClose: () => void }) {
  const { t } = useTranslation();
  const doctors = useDoctors();
  const types = useVisitTypes();
  const [v, setV] = useState({ doctorId: visit.doctor?.id ?? '', visitTypeId: visit.visitType?.id ?? '', priority: visit.priority, chiefComplaint: visit.chiefComplaint ?? '', notes: visit.notes ?? '' });
  const save = useApiMutation(() => api.put(`/visits/${visit.id}`, { ...v, doctorId: v.doctorId || null, visitTypeId: v.visitTypeId || null }), { invalidate: [['queue']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={t('queue.edit')} subtitle={`${visit.patient.fullName} — #${visit.queueNumber}`} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('reception.doctor')}>
          <Select value={v.doctorId} onChange={(e) => setV({ ...v, doctorId: e.target.value })}>
            <option value="">{t('queue.unassigned')}</option>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
        </Field>
        <Field label={t('reception.visitType')}>
          <Select value={v.visitTypeId} onChange={(e) => setV({ ...v, visitTypeId: e.target.value })} placeholder={t('common.select')}>
            {types.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label={t('reception.priority')}>
          <Select value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value as Priority })}>
            {(['NORMAL', 'URGENT', 'EMERGENCY'] as const).map((p) => <option key={p} value={p}>{t(`enum.Priority.${p}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('reception.complaint')}><Input value={v.chiefComplaint} onChange={(e) => setV({ ...v, chiefComplaint: e.target.value })} /></Field>
        <Field label={t('common.notes')} className="sm:col-span-2"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

