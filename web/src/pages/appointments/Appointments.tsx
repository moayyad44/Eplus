import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { addDays, fmtDate, fmtDateTime, fmtMonth, fmtTime, fmtWeekday, startOfWeek, toLocalInput, ymd } from '@/lib/format';
import type { PatientLite } from '@/lib/types';
import { Button, Card, DataTable, Dialog, Field, IconButton, Input, PageHeader, Segmented, Select, Textarea, useConfirm } from '@/components/ui';
import { PatientPicker } from '@/components/shared/PatientPicker';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { useDoctors, useVisitTypes } from '@/components/shared/VisitQueueForm';

interface Appt {
  id: string; startAt: string; endAt: string; status: string; reason: string | null; notes: string | null;
  patient: { id: string; fullName: string; phone: string; fileNumber: string }; doctor: { id: string; fullName: string };
  visitType: { id: string; name: string; color: string | null } | null; visit: { id: string; status: string; queueNumber: number } | null;
}
type View = 'week' | 'month' | 'list';

export default function Appointments() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => (params.get('date') ? new Date(`${params.get('date')}T00:00`) : new Date()));
  const [doctorId, setDoctorId] = useState(me?.user.staffType === 'DOCTOR' ? me.user.id : '');
  const [dialog, setDialog] = useState<{ appt?: Appt; patientId?: string; start?: Date } | null>(null);
  const [selected, setSelected] = useState<Appt | null>(null);
  const doctors = useDoctors();

  useEffect(() => {
    if (params.get('new') && can('appointments.manage')) {
      setDialog({ patientId: params.get('patientId') ?? undefined });
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams, can]);

  const range = useMemo(() => {
    if (view === 'month') {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const from = startOfWeek(first);
      return { from, to: addDays(from, 42) };
    }
    if (view === 'week') { const from = startOfWeek(anchor); return { from, to: addDays(from, 7) }; }
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    return { from, to: addDays(from, 30) };
  }, [view, anchor]);

  const q = useQuery({
    queryKey: ['appointments', range.from.toISOString(), range.to.toISOString(), doctorId],
    queryFn: () => api.get<Appt[]>('/appointments', { from: range.from.toISOString(), to: range.to.toISOString(), doctorId: doctorId || undefined }),
  });
  const byDay = useMemo(() => {
    const m = new Map<string, Appt[]>();
    for (const a of q.data ?? []) {
      const k = ymd(new Date(a.startAt));
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return m;
  }, [q.data]);

  const shift = (dir: 1 | -1) => setAnchor((a) => (view === 'month' ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, dir * (view === 'week' ? 7 : 30))));
  const title = view === 'month' ? fmtMonth(anchor) : `${fmtDate(range.from)} — ${fmtDate(addDays(range.to, -1))}`;
  const today = ymd();

  const card = (a: Appt) => (
    <button
      key={a.id}
      onClick={() => setSelected(a)}
      className={clsx('w-full rounded-xl border-s-4 bg-white p-2 text-start text-xs shadow-sm ring-1 ring-line transition hover:ring-primary-300', ['CANCELLED', 'NO_SHOW'].includes(a.status) && 'opacity-50 line-through')}
      style={{ borderInlineStartColor: a.visitType?.color ?? '#6cc0ec' }}
    >
      <span className="flex items-center gap-1 font-bold tabular-nums text-primary-700"><Clock className="h-3 w-3" />{fmtTime(a.startAt)}</span>
      <span className="block truncate font-semibold text-ink">{a.patient.fullName}</span>
      {!doctorId && <span className="block truncate text-ink-muted">{a.doctor.fullName}</span>}
    </button>
  );

  return (
    <div>
      <PageHeader
        title={t('appointments.title')}
        subtitle={t('appointments.subtitle')}
        actions={can('appointments.manage') && <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setDialog({})}>{t('appointments.new')}</Button>}
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Segmented items={[{ key: 'week', label: t('appointments.week') }, { key: 'month', label: t('appointments.month') }, { key: 'list', label: t('appointments.list') }]} value={view} onChange={setView} />
          <div className="flex items-center gap-1">
            <IconButton label={t('common.previous')} onClick={() => shift(-1)}><ChevronRight className="h-4 w-4 ltr:rotate-180" /></IconButton>
            <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>{t('appointments.today')}</Button>
            <IconButton label={t('common.next')} onClick={() => shift(1)}><ChevronLeft className="h-4 w-4 ltr:rotate-180" /></IconButton>
          </div>
          <span className="text-sm font-bold">{title}</span>
          <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="ms-auto !h-9 w-48">
            <option value="">{t('appointments.allDoctors')}</option>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
        </div>

        {view === 'week' && (
          <div className="grid gap-2 overflow-x-auto md:grid-cols-7">
            {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d) => {
              const k = ymd(d);
              const list = byDay.get(k) ?? [];
              return (
                <div key={k} className={clsx('min-h-[10rem] rounded-2xl p-2', k === today ? 'bg-primary-50 ring-1 ring-primary-200' : 'bg-surface-subtle')}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold">{fmtWeekday(d)} <span className="font-normal text-ink-muted">{d.getDate()}</span></span>
                    {can('appointments.manage') && <button className="text-primary-600 hover:text-primary-800" onClick={() => setDialog({ start: new Date(d.setHours(9, 0, 0, 0)) })} aria-label={t('appointments.new')}>+</button>}
                  </div>
                  <div className="space-y-1.5">{list.map(card)}</div>
                </div>
              );
            })}
          </div>
        )}

        {view === 'month' && (
          <div className="grid grid-cols-7 gap-1 text-xs">
            {Array.from({ length: 7 }, (_, i) => <div key={i} className="p-1 text-center font-bold text-ink-muted">{fmtWeekday(addDays(range.from, i))}</div>)}
            {Array.from({ length: 42 }, (_, i) => addDays(range.from, i)).map((d) => {
              const k = ymd(d);
              const list = byDay.get(k) ?? [];
              const inMonth = d.getMonth() === anchor.getMonth();
              return (
                <button key={k} onClick={() => { setAnchor(d); setView('week'); }} className={clsx('min-h-[5.5rem] rounded-xl p-1.5 text-start align-top', k === today ? 'bg-primary-50 ring-1 ring-primary-200' : 'bg-surface-subtle hover:bg-primary-50/50', !inMonth && 'opacity-40')}>
                  <span className="font-bold">{d.getDate()}</span>
                  {list.slice(0, 3).map((a) => <span key={a.id} className="mt-0.5 block truncate rounded bg-white px-1 text-[10px]">{fmtTime(a.startAt)} {a.patient.fullName}</span>)}
                  {list.length > 3 && <span className="text-[10px] text-primary-700">{t('appointments.more', { count: list.length - 3 })}</span>}
                </button>
              );
            })}
          </div>
        )}

        {view === 'list' && (
          <DataTable
            rows={q.data}
            loading={q.isFetching}
            error={q.error}
            rowKey={(r) => r.id}
            onRowClick={setSelected}
            columns={[
              { key: 'd', header: t('appointments.startAt'), cell: (r) => <span className="tabular-nums">{fmtDateTime(r.startAt)}</span> },
              { key: 'p', header: t('appointments.patient'), cell: (r) => <b>{r.patient.fullName}</b> },
              { key: 'ph', header: t('common.phone'), hideOnMobile: true, cell: (r) => <span dir="ltr">{r.patient.phone}</span> },
              { key: 'doc', header: t('appointments.doctor'), cell: (r) => r.doctor.fullName },
              { key: 'r', header: t('appointments.reason'), hideOnMobile: true, cell: (r) => r.reason ?? '—' },
              { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="AppointmentStatus" value={r.status} /> },
            ]}
          />
        )}
      </Card>

      {selected && <ApptActions appt={selected} onClose={() => setSelected(null)} onEdit={() => { setDialog({ appt: selected }); setSelected(null); }} onOpenVisit={(id) => nav(`/visits/${id}`)} />}
      {dialog && <ApptDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ApptActions({ appt, onClose, onEdit, onOpenVisit }: { appt: Appt; onClose: () => void; onEdit: () => void; onOpenVisit: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const status = useApiMutation((v: { status: string; reason?: string }) => api.post(`/appointments/${appt.id}/status`, v), { invalidate: [['appointments']], onSuccess: onClose });
  const checkIn = useApiMutation(() => api.post<{ queueNumber: number }>(`/appointments/${appt.id}/check-in`), {
    invalidate: [['appointments'], ['queue']], success: false, onSuccess: (r) => { toast.success(t('appointments.checkedIn', { number: r.queueNumber })); onClose(); },
  });
  const open = ['SCHEDULED', 'CONFIRMED'].includes(appt.status);
  return (
    <Dialog open onClose={onClose} size="sm" title={appt.patient.fullName} subtitle={`${fmtDateTime(appt.startAt)} · ${appt.doctor.fullName}`}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge enumName="AppointmentStatus" value={appt.status} />{appt.visitType && <span className="text-ink-muted">{appt.visitType.name}</span>}</div>
        <p dir="ltr" className="text-end text-ink-muted">{appt.patient.phone}</p>
        {appt.reason && <p><b>{t('appointments.reason')}:</b> {appt.reason}</p>}
        {appt.notes && <p className="text-ink-soft">{appt.notes}</p>}
        <div className="grid grid-cols-2 gap-2 pt-2">
          {open && can('queue.manage') && <Button className="col-span-2" loading={checkIn.isPending} onClick={() => checkIn.mutate(undefined)}>{t('appointments.checkIn')}</Button>}
          {appt.visit && <Button className="col-span-2" variant="secondary" onClick={() => onOpenVisit(appt.visit!.id)}>{t('appointments.openVisit')}</Button>}
          {open && can('appointments.manage') && (
            <>
              {appt.status === 'SCHEDULED' && <Button variant="outline" onClick={() => status.mutate({ status: 'CONFIRMED' })}>{t('appointments.confirm')}</Button>}
              <Button variant="outline" onClick={onEdit}>{t('appointments.edit')}</Button>
              <Button variant="outline" onClick={() => status.mutate({ status: 'NO_SHOW' })}>{t('appointments.noShow')}</Button>
              <Button variant="danger" onClick={async () => { const r = await confirm({ message: appt.patient.fullName, danger: true, reason: { label: t('appointments.cancelReason'), required: true } }); if (r) status.mutate({ status: 'CANCELLED', reason: r }); }}>{t('appointments.cancel')}</Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ApptDialog({ appt, patientId, start, onClose }: { appt?: Appt; patientId?: string; start?: Date; onClose: () => void }) {
  const { t } = useTranslation();
  const doctors = useDoctors();
  const types = useVisitTypes();
  const confirm = useConfirm();
  const { me } = useAuth();
  const [patient, setPatient] = useState<PatientLite | null>(appt ? ({ ...appt.patient, gender: 'MALE', dateOfBirth: null, age: null } as PatientLite) : null);
  const preload = useQuery({ queryKey: ['patient', patientId], queryFn: () => api.get<PatientLite>(`/patients/${patientId}`), enabled: !!patientId && !patient });
  useEffect(() => { if (preload.data && !patient) setPatient(preload.data); }, [preload.data, patient]);
  const [v, setV] = useState({
    doctorId: appt?.doctor.id ?? (me?.user.staffType === 'DOCTOR' ? me.user.id : ''),
    visitTypeId: appt?.visitType?.id ?? '',
    startAt: toLocalInput(appt?.startAt ?? start ?? new Date(Math.ceil(Date.now() / 900_000) * 900_000)),
    durationMin: appt ? String((new Date(appt.endAt).getTime() - new Date(appt.startAt).getTime()) / 60_000) : '15',
    reason: appt?.reason ?? '', notes: appt?.notes ?? '',
  });
  const save = useApiMutation(
    (force: boolean) => {
      const body = { patientId: patient?.id, doctorId: v.doctorId, visitTypeId: v.visitTypeId || null, startAt: new Date(v.startAt).toISOString(), durationMin: Number(v.durationMin), reason: v.reason || null, notes: v.notes || null, force };
      return appt ? api.put(`/appointments/${appt.id}`, body) : api.post('/appointments', body);
    },
    {
      invalidate: [['appointments']], success: t('appointments.saved'), onSuccess: onClose,
      onError: async (e: ApiError) => {
        if (e.code === 'APPOINTMENT_CONFLICT') {
          if (await confirm({ message: `${e.message}. ${t('appointments.conflictForce')}` })) save.mutate(true);
        } else if (e.code !== 'VALIDATION') toast.error(e.message);
      },
    },
  );
  const fe = save.fieldErrors;
  return (
    <Dialog open onClose={onClose} title={appt ? t('appointments.edit') : t('appointments.new')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(false)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('appointments.patient')} required error={fe.patientId} className="sm:col-span-2">
          <PatientPicker value={patient} onChange={setPatient} invalid={!!fe.patientId} />
        </Field>
        <Field label={t('appointments.doctor')} required error={fe.doctorId}>
          <Select value={v.doctorId} onChange={(e) => setV({ ...v, doctorId: e.target.value })} placeholder={t('common.select')} invalid={!!fe.doctorId}>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
        </Field>
        <Field label={t('appointments.type')}>
          <Select value={v.visitTypeId} onChange={(e) => { const vt = types.data?.find((x) => x.id === e.target.value); setV({ ...v, visitTypeId: e.target.value, durationMin: vt ? String(vt.durationMin) : v.durationMin }); }} placeholder={t('common.select')}>
            {types.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label={t('appointments.startAt')} required error={fe.startAt}><Input type="datetime-local" value={v.startAt} onChange={(e) => setV({ ...v, startAt: e.target.value })} /></Field>
        <Field label={t('appointments.duration')}><Input type="number" min={5} step={5} value={v.durationMin} onChange={(e) => setV({ ...v, durationMin: e.target.value })} /></Field>
        <Field label={t('appointments.reason')} className="sm:col-span-2"><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        <Field label={t('appointments.notes')} className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
