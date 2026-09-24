import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { useCatalog } from '@/lib/catalogs';
import { addDays, fmtDate, fmtMonth, startOfWeek, ymd } from '@/lib/format';
import type { UserLite } from '@/lib/types';
import { Button, Card, Checkbox, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Segmented, Select, useConfirm } from '@/components/ui';

interface Assignment { id: string; userId: string; date: string; startTime: string; endTime: string; user: { id: string; fullName: string; staffType: string }; shift: { id: string; name: string; type: string; color: string | null } }
interface Leave { id: string; userId: string; startDate: string; endDate: string; type: string; user: { fullName: string } }
interface Shift { id: string; name: string; type: string; startTime: string; endTime: string; color: string | null }

export default function Schedule() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(new Date());
  const [staffType, setStaffType] = useState('');
  const [assigning, setAssigning] = useState(false);
  const days = useMemo(() => {
    if (view === 'week') { const s = startOfWeek(anchor); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const n = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    return Array.from({ length: n }, (_, i) => addDays(first, i));
  }, [view, anchor]);
  const from = ymd(days[0]), to = ymd(days[days.length - 1]);
  const q = useQuery({ queryKey: ['schedule', from, to, staffType], queryFn: () => api.get<{ assignments: Assignment[]; leaves: Leave[]; attendance: { userId: string; date: string; status: string }[] }>('/staff/schedule', { from, to, staffType: staffType || undefined }) });
  const staff = useQuery({ queryKey: ['users', 'lookup'], queryFn: () => api.get<UserLite[]>('/users/lookup') });
  const del = useApiMutation((id: string) => api.del(`/staff/schedule/${id}`), { invalidate: [['schedule']], success: t('common.done') });

  const people = (staff.data ?? []).filter((u) => !staffType || u.staffType === staffType).filter((u) => q.data?.assignments.some((a) => a.userId === u.id) || q.data?.leaves.some((l) => l.userId === u.id) || view === 'week');
  const cell = (uid: string, d: Date) => {
    const k = ymd(d);
    const as = q.data?.assignments.filter((a) => a.userId === uid && a.date.slice(0, 10) === k) ?? [];
    const onLeave = q.data?.leaves.some((l) => l.userId === uid && l.startDate.slice(0, 10) <= k && l.endDate.slice(0, 10) >= k);
    const att = q.data?.attendance.find((a) => a.userId === uid && a.date.slice(0, 10) === k);
    return { as, onLeave, att };
  };
  const shift = (dir: 1 | -1) => setAnchor((a) => (view === 'week' ? addDays(a, dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  const dayNames = t('staff.dayNames', { returnObjects: true }) as string[];

  return (
    <div>
      <PageHeader
        title={t('staff.schedule')}
        subtitle={t('staff.scheduleSubtitle')}
        actions={
          <>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
            {can('shifts.manage') && <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setAssigning(true)}>{t('staff.assign')}</Button>}
          </>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
          <Segmented items={[{ key: 'week', label: t('staff.week') }, { key: 'month', label: t('staff.month') }]} value={view} onChange={setView} />
          <IconButton label={t('common.previous')} onClick={() => shift(-1)}><ChevronRight className="h-4 w-4 ltr:rotate-180" /></IconButton>
          <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>{t('common.today')}</Button>
          <IconButton label={t('common.next')} onClick={() => shift(1)}><ChevronLeft className="h-4 w-4 ltr:rotate-180" /></IconButton>
          <span className="text-sm font-bold">{view === 'month' ? fmtMonth(anchor) : `${fmtDate(days[0])} — ${fmtDate(days[6])}`}</span>
          <Select value={staffType} onChange={(e) => setStaffType(e.target.value)} className="ms-auto !h-9 w-40">
            <option value="">{t('common.all')}</option>
            {['DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'ACCOUNTANT', 'ADMIN', 'OTHER'].map((x) => <option key={x} value={x}>{t(`enum.StaffType.${x}`)}</option>)}
          </Select>
        </div>
        {!people.length ? <EmptyState title={t('staff.noSchedule')} /> : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="sticky start-0 z-[1] min-w-[9rem] border-b border-line bg-surface-subtle p-2 text-start">{t('staff.employee')}</th>
                  {days.map((d) => (
                    <th key={ymd(d)} className={clsx('min-w-[5.5rem] border-b border-line p-2 text-center font-semibold', ymd(d) === ymd() ? 'bg-primary-50 text-primary-800' : 'bg-surface-subtle')}>
                      {dayNames[d.getDay()]}<span className="block font-normal text-ink-muted">{d.getDate()}/{d.getMonth() + 1}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map((u) => (
                  <tr key={u.id}>
                    <td className="sticky start-0 z-[1] border-b border-line bg-white p-2"><b className="text-sm">{u.fullName}</b><span className="block text-ink-muted">{t(`enum.StaffType.${u.staffType}`)}</span></td>
                    {days.map((d) => {
                      const c = cell(u.id, d);
                      return (
                        <td key={ymd(d)} className="border-b border-line p-1 align-top">
                          {c.onLeave && <span className="mb-1 block rounded-lg bg-violet-50 px-1.5 py-1 text-center font-semibold text-violet-700">{t('staff.onLeave')}</span>}
                          {c.as.map((a) => (
                            <button
                              key={a.id}
                              disabled={!can('shifts.manage')}
                              onClick={async () => (await confirm({ message: `${t('staff.removeShift')}: ${a.user.fullName} — ${a.shift.name} ${a.date.slice(0, 10)}`, danger: true })) && del.mutate(a.id)}
                              className="mb-1 block w-full rounded-lg px-1.5 py-1 text-center font-semibold text-ink"
                              style={{ background: `${a.shift.color ?? '#9dd6f4'}33`, borderInlineStart: `3px solid ${a.shift.color ?? '#6cc0ec'}` }}
                              title={t('staff.removeShift')}
                            >
                              {a.shift.name}<span className="block font-normal" dir="ltr">{a.startTime}–{a.endTime}</span>
                            </button>
                          ))}
                          {c.att && <span className={clsx('block text-center text-[10px] font-semibold', ['ABSENT', 'LATE_AND_EARLY'].includes(c.att.status) ? 'text-danger-600' : c.att.status === 'PRESENT' ? 'text-success-700' : 'text-warning-700')}>{t(`enum.AttendanceStatus.${c.att.status}`)}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {assigning && <AssignDialog staff={staff.data ?? []} onClose={() => setAssigning(false)} defaultFrom={from} defaultTo={to} />}
    </div>
  );
}

function AssignDialog({ staff, onClose, defaultFrom, defaultTo }: { staff: UserLite[]; onClose: () => void; defaultFrom: string; defaultTo: string }) {
  const { t } = useTranslation();
  const shifts = useCatalog<Shift>('shifts');
  const dayNames = t('staff.dayNames', { returnObjects: true }) as string[];
  const [v, setV] = useState({ userIds: [] as string[], shiftId: '', from: defaultFrom, to: defaultTo, weekdays: [0, 1, 2, 3, 4, 6], startTime: '', endTime: '' });
  const save = useApiMutation(() => api.post<{ created: number; skippedLeave: number; skippedExisting: number }>('/staff/schedule/bulk', { ...v, startTime: v.startTime || undefined, endTime: v.endTime || undefined }), {
    invalidate: [['schedule']], success: false, onSuccess: (r) => { toast.success(t('staff.scheduled', { created: r.created, skipped: r.skippedLeave + r.skippedExisting })); onClose(); },
  });
  const fe = save.fieldErrors;
  return (
    <Dialog open onClose={onClose} size="lg" title={t('staff.assign')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field group label={t('staff.employees')} required error={fe.userIds}>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
            {staff.map((u) => (
              <Checkbox key={u.id} className="w-full rounded-lg px-2 py-1 hover:bg-surface-subtle" label={<>{u.fullName} <span className="text-xs text-ink-muted">({t(`enum.StaffType.${u.staffType}`)})</span></>} checked={v.userIds.includes(u.id)} onChange={(e) => setV({ ...v, userIds: e.target.checked ? [...v.userIds, u.id] : v.userIds.filter((x) => x !== u.id) })} />
            ))}
          </div>
        </Field>
        <div className="space-y-3">
          <Field label={t('staff.shift')} required error={fe.shiftId}>
            <Select value={v.shiftId} onChange={(e) => setV({ ...v, shiftId: e.target.value })} placeholder={t('common.select')}>
              {shifts.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('common.from')}><Input type="date" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} /></Field>
            <Field label={t('common.to')}><Input type="date" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} /></Field>
          </div>
          <Field group label={t('staff.weekdays')} error={fe.weekdays}>
            <div className="flex flex-wrap gap-1">
              {[6, 0, 1, 2, 3, 4, 5].map((d) => (
                <button key={d} type="button" onClick={() => setV({ ...v, weekdays: v.weekdays.includes(d) ? v.weekdays.filter((x) => x !== d) : [...v.weekdays, d] })} className={clsx('rounded-lg px-2.5 py-1.5 text-xs font-semibold', v.weekdays.includes(d) ? 'bg-primary-600 text-white' : 'bg-surface-sunken text-ink-muted')}>
                  {dayNames[d]}
                </button>
              ))}
            </div>
          </Field>
          <Field group label={t('staff.customTime')}>
            <div className="grid grid-cols-2 gap-2">
              <Input type="time" value={v.startTime} onChange={(e) => setV({ ...v, startTime: e.target.value })} />
              <Input type="time" value={v.endTime} onChange={(e) => setV({ ...v, endTime: e.target.value })} />
            </div>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
