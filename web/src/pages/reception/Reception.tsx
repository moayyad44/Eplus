import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, FolderOpen, Phone, Plus, Search, UserPlus, UserRound, Users } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useDebounced } from '@/lib/hooks';
import { addDays, fmtDate, fmtTime, ymd } from '@/lib/format';
import type { PatientLite } from '@/lib/types';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { PatientFormDialog } from '@/components/shared/PatientForm';
import { PatientPicker } from '@/components/shared/PatientPicker';
import { VisitQueueForm } from '@/components/shared/VisitQueueForm';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Appt { id: string; startAt: string; status: string; reason: string | null; patient: { id: string; fullName: string; phone: string }; doctor: { fullName: string }; visit: { id: string } | null }

export default function Reception() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const [phone, setPhone] = useState('');
  const [selected, setSelected] = useState<PatientLite | null>(null);
  const [registering, setRegistering] = useState(false);
  const digits = phone.replace(/[^\d٠-٩+]/g, '');
  const dPhone = useDebounced(digits, 300);
  const lookup = useQuery({
    queryKey: ['patients', 'lookup', dPhone],
    queryFn: () => api.get<{ phone: string; items: PatientLite[] }>('/patients/lookup', { phone: dPhone }),
    enabled: dPhone.length >= 7,
  });
  // A single match is selected automatically — one less click for the receptionist.
  useEffect(() => {
    if (lookup.data?.items.length === 1) setSelected(lookup.data.items[0]);
    else if (lookup.data) setSelected(null);
  }, [lookup.data]);

  const today = useMemo(() => new Date(new Date().setHours(0, 0, 0, 0)), []);
  const appts = useQuery({
    queryKey: ['appointments', 'reception', ymd(today)],
    queryFn: () => api.get<Appt[]>('/appointments', { from: today.toISOString(), to: addDays(today, 1).toISOString() }),
    enabled: can('appointments.view'),
    refetchInterval: 60_000,
  });
  const queue = useQuery({
    queryKey: ['queue', 'counts'],
    queryFn: () => api.get<{ counts: Record<string, number> }>('/visits/queue', { status: 'ACTIVE' }),
    refetchInterval: 20_000,
  });
  const checkIn = useApiMutation((id: string) => api.post<{ queueNumber: number }>(`/appointments/${id}/check-in`), {
    invalidate: [['appointments'], ['queue']],
    success: false,
    onSuccess: (r) => toast.success(t('reception.addedToQueue', { name: '', number: r.queueNumber })),
  });

  const pending = appts.data?.filter((a) => ['SCHEDULED', 'CONFIRMED'].includes(a.status)) ?? [];
  const counts = queue.data?.counts ?? {};
  const waiting = ['WAITING', 'CALLED', 'WITH_NURSE', 'WITH_DOCTOR', 'IN_LAB', 'WAITING_PAYMENT'].reduce((a, s) => a + (counts[s] ?? 0), 0);

  return (
    <div>
      <PageHeader title={t('reception.title')} subtitle={t('reception.subtitle')} actions={<Button variant="outline" icon={<Users className="h-4 w-4" />} onClick={() => nav('/queue')}>{t('reception.openQueue')} <Badge tone="primary">{waiting}</Badge></Button>} />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card>
            <label className="mb-2 flex items-center gap-2 text-sm font-bold text-ink"><Phone className="h-4 w-4 text-primary-600" />{t('reception.phoneLabel')}</label>
            <div className="relative">
              <input
                autoFocus
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                dir="ltr"
                placeholder={t('reception.phonePlaceholder')}
                className="h-16 w-full rounded-2xl border-2 border-primary-200 bg-primary-50/40 px-5 text-center text-2xl font-bold tracking-wider text-ink outline-none transition placeholder:text-ink-muted/40 focus:border-primary-400 focus:bg-white focus:ring-4 focus:ring-primary-100"
              />
              {lookup.isFetching && <Spinner className="absolute end-4 top-1/2 -translate-y-1/2" />}
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
              <Search className="h-3.5 w-3.5" /> {t('reception.searchByName')}:
              <div className="flex-1"><PatientPicker value={null} onChange={(p) => { if (p) { setSelected(p); setPhone(p.phone); } }} /></div>
            </div>

            {digits.length > 0 && digits.length < 7 && <p className="mt-4 text-center text-xs text-ink-muted">{t('reception.typeMore')}</p>}

            {lookup.data && (
              <div className="mt-5">
                {lookup.data.items.length ? (
                  <>
                    <p className="mb-2 text-xs font-semibold text-ink-muted">{t('reception.found')} ({lookup.data.items.length})</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {lookup.data.items.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setSelected(p)}
                          className={clsx('flex items-center gap-3 rounded-2xl border p-3 text-start transition', selected?.id === p.id ? 'border-primary-400 bg-primary-50 ring-2 ring-primary-100' : 'border-line hover:border-primary-200')}
                        >
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-primary-600 ring-1 ring-line"><UserRound className="h-5 w-5" /></span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{p.fullName}</span>
                            <span className="block text-xs text-ink-muted">
                              #{p.fileNumber} · {t(`enum.Gender.${p.gender}`)}{p.age != null && ` · ${t('common.yearsOld', { age: p.age })}`}
                            </span>
                            <span className="block text-[11px] text-ink-muted">{t('reception.lastVisit')}: {fmtDate(p.lastVisitAt)} · {p.visitCount} {t('reception.visits')}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {can('patients.create') && (
                      <Button variant="ghost" size="sm" className="mt-2" icon={<Plus className="h-4 w-4" />} onClick={() => setRegistering(true)}>{t('reception.registerAnother')}</Button>
                    )}
                  </>
                ) : (
                  <EmptyState
                    icon={<UserPlus className="h-6 w-6" />}
                    title={t('reception.notFound')}
                    description={<span dir="ltr">{lookup.data.phone}</span>}
                    action={can('patients.create') && <Button size="lg" icon={<UserPlus className="h-5 w-5" />} onClick={() => setRegistering(true)}>{t('reception.registerNew')}</Button>}
                  />
                )}
              </div>
            )}

            {!lookup.data && !selected && digits.length === 0 && (
              <ol className="mt-6 grid gap-2 sm:grid-cols-3">
                {(['one', 'two', 'three'] as const).map((k, i) => (
                  <li key={k} className="flex items-center gap-2 rounded-xl bg-surface-subtle p-3 text-xs font-semibold text-ink-soft">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-primary-100 text-primary-800">{i + 1}</span>{t(`reception.steps.${k}`)}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {selected && (
            <Card className="animate-pop-in">
              <CardHeader
                title={selected.fullName}
                subtitle={<span dir="ltr">#{selected.fileNumber} · {selected.phone}</span>}
                icon={<UserRound className="h-5 w-5" />}
                actions={
                  <>
                    <Button size="sm" variant="outline" icon={<FolderOpen className="h-4 w-4" />} onClick={() => nav(`/patients/${selected.id}`)}>{t('common.open')}</Button>
                    {can('appointments.manage') && <Button size="sm" variant="outline" icon={<CalendarCheck className="h-4 w-4" />} onClick={() => nav(`/appointments?patientId=${selected.id}&new=1`)}>{t('patients.bookAppointment')}</Button>}
                  </>
                }
              />
              {can('queue.manage') && (
                <>
                  <p className="mb-3 text-sm font-bold">{t('reception.newVisit')}</p>
                  <VisitQueueForm patient={selected} onDone={() => { setSelected(null); setPhone(''); }} />
                </>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title={t('reception.queueNow')} actions={<Link to="/queue" className="text-xs font-semibold text-primary-700 hover:underline">{t('common.viewAll')}</Link>} />
            <div className="grid grid-cols-2 gap-2">
              {(['WAITING', 'WITH_NURSE', 'WITH_DOCTOR', 'WAITING_PAYMENT'] as const).map((s) => (
                <div key={s} className="rounded-xl bg-surface-subtle p-3">
                  <p className="text-[11px] font-semibold text-ink-muted">{t(`enum.VisitStatus.${s}`)}</p>
                  <p className="text-2xl font-bold tabular-nums">{counts[s] ?? 0}</p>
                </div>
              ))}
            </div>
          </Card>
          {can('appointments.view') && (
            <Card>
              <CardHeader title={t('reception.todayAppointments')} subtitle={`${pending.length}`} />
              {pending.length === 0 ? <EmptyState title={t('reception.noAppointments')} /> : (
                <ul className="divide-y divide-line">
                  {pending.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-2.5">
                      <span className="w-14 shrink-0 text-center text-sm font-bold tabular-nums text-primary-700">{fmtTime(a.startAt)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{a.patient.fullName}</span>
                        <span className="block truncate text-xs text-ink-muted">{a.doctor.fullName}</span>
                      </span>
                      <StatusBadge enumName="AppointmentStatus" value={a.status} />
                      {can('queue.manage') && <Button size="sm" variant="secondary" loading={checkIn.isPending && checkIn.variables === a.id} onClick={() => checkIn.mutate(a.id)}>{t('reception.checkIn')}</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>

      {registering && (
        <PatientFormDialog
          open
          onClose={() => setRegistering(false)}
          initialPhone={lookup.data?.phone ?? digits}
          onSaved={(p) => { setSelected(p); setPhone(p.phone); }}
        />
      )}
    </div>
  );
}
