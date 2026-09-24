import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDay, fmtTime, ymd } from '@/lib/format';
import type { UserLite } from '@/lib/types';
import { Button, Card, DataTable, DateRangePicker, Dialog, Field, Input, PageHeader, Pagination, Select, StatCard, presetRange } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Row { id: string; date: string; checkIn: string | null; checkOut: string | null; status: string; lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number; notes: string | null; user: { id: string; fullName: string; staffType: string }; shiftAssignment: { startTime: string; endTime: string; shift: { name: string } } | null }

export default function Attendance() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('attendance.manage');
  const users = useQuery({ queryKey: ['users', 'lookup'], queryFn: () => api.get<UserLite[]>('/users/lookup'), enabled: manage });
  const list = usePagedList<Row, { from: string; to: string; userId?: string; status?: string }>('attendance', '/staff/attendance', { pageSize: 30, filters: presetRange('week') });
  const totals = (list.data as unknown as { totals?: { lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number } })?.totals;
  const [rec, setRec] = useState(false);
  return (
    <div>
      <PageHeader
        title={t('staff.attendance')}
        subtitle={t('staff.attendanceSubtitle')}
        actions={
          <>
            <Button variant="outline" onClick={() => list.data && exportCsv('attendance', [
              { header: t('common.date'), value: (r: Row) => fmtDay(r.date) }, { header: t('staff.employee'), value: (r) => r.user.fullName }, { header: t('staff.shift'), value: (r) => r.shiftAssignment?.shift.name ?? '' },
              { header: t('staff.checkIn'), value: (r) => fmtTime(r.checkIn) }, { header: t('staff.checkOut'), value: (r) => fmtTime(r.checkOut) }, { header: t('common.status'), value: (r) => t(`enum.AttendanceStatus.${r.status}`) },
              { header: t('staff.late'), value: (r) => r.lateMinutes }, { header: t('staff.early'), value: (r) => r.earlyLeaveMinutes }, { header: t('staff.worked'), value: (r) => (r.workedMinutes / 60).toFixed(1) },
            ], list.data.items)}>{t('common.exportCsv')}</Button>
            {manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRec(true)}>{t('staff.record')}</Button>}
          </>
        }
      />
      {totals && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <StatCard label={t('staff.worked')} value={`${((totals.workedMinutes ?? 0) / 60).toFixed(1)} ${t('common.hours')}`} tone="success" />
          <StatCard label={t('staff.late')} value={t('staff.minutesShort', { m: totals.lateMinutes ?? 0 })} tone="warning" />
          <StatCard label={t('staff.early')} value={t('staff.minutesShort', { m: totals.earlyLeaveMinutes ?? 0 })} tone="danger" />
        </div>
      )}
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {manage && (
            <Select value={list.filters.userId ?? ''} onChange={(e) => list.setFilters({ userId: e.target.value || undefined })} className="w-auto">
              <option value="">{t('staff.allEmployees')}</option>
              {users.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          )}
          <Select value={list.filters.status ?? ''} onChange={(e) => list.setFilters({ status: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.status')}: {t('common.all')}</option>
            {['PRESENT', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'ABSENT', 'LEAVE'].map((s) => <option key={s} value={s}>{t(`enum.AttendanceStatus.${s}`)}</option>)}
          </Select>
          <DateRangePicker value={{ from: list.filters.from, to: list.filters.to }} onChange={(r) => list.setFilters(r)} />
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          columns={[
            { key: 'd', header: t('common.date'), cell: (r) => fmtDay(r.date) },
            { key: 'u', header: t('staff.employee'), cell: (r) => <b>{r.user.fullName}</b> },
            { key: 's', header: t('staff.shift'), hideOnMobile: true, cell: (r) => (r.shiftAssignment ? <>{r.shiftAssignment.shift.name} <span className="text-xs text-ink-muted" dir="ltr">{r.shiftAssignment.startTime}–{r.shiftAssignment.endTime}</span></> : '—') },
            { key: 'i', header: t('staff.checkIn'), cell: (r) => <span className="tabular-nums">{fmtTime(r.checkIn)}</span> },
            { key: 'o', header: t('staff.checkOut'), cell: (r) => <span className="tabular-nums">{fmtTime(r.checkOut)}</span> },
            { key: 'st', header: t('common.status'), cell: (r) => <StatusBadge enumName="AttendanceStatus" value={r.status} /> },
            { key: 'l', header: t('staff.late'), hideOnMobile: true, cell: (r) => (r.lateMinutes ? t('staff.minutesShort', { m: r.lateMinutes }) : '—') },
            { key: 'e', header: t('staff.early'), hideOnMobile: true, cell: (r) => (r.earlyLeaveMinutes ? t('staff.minutesShort', { m: r.earlyLeaveMinutes }) : '—') },
            { key: 'w', header: t('staff.worked'), hideOnMobile: true, cell: (r) => (r.workedMinutes ? (r.workedMinutes / 60).toFixed(1) : '—') },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {rec && <RecordDialog users={users.data ?? []} onClose={() => setRec(false)} />}
    </div>
  );
}

function RecordDialog({ users, onClose }: { users: UserLite[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ userId: '', date: ymd(), status: '', checkIn: '', checkOut: '', notes: '' });
  const at = (hhmm: string) => (hhmm ? new Date(`${v.date}T${hhmm}:00`).toISOString() : null);
  const save = useApiMutation(() => api.post('/staff/attendance', { userId: v.userId, date: v.date, status: v.status || undefined, checkIn: at(v.checkIn), checkOut: at(v.checkOut), notes: v.notes || null }), { invalidate: [['attendance'], ['schedule']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={t('staff.record')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('staff.employee')} required error={save.fieldErrors.userId}><Select value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })} placeholder={t('common.select')}>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></Field>
        <Field label={t('common.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('common.status')} hint="—">
          <Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>
            <option value="">{t('enum.AttendanceStatus.PRESENT')}</option>
            <option value="ABSENT">{t('enum.AttendanceStatus.ABSENT')}</option>
            <option value="LEAVE">{t('enum.AttendanceStatus.LEAVE')}</option>
          </Select>
        </Field>
        <div />
        {!v.status && <><Field label={t('staff.checkIn')}><Input type="time" value={v.checkIn} onChange={(e) => setV({ ...v, checkIn: e.target.value })} /></Field><Field label={t('staff.checkOut')}><Input type="time" value={v.checkOut} onChange={(e) => setV({ ...v, checkOut: e.target.value })} /></Field></>}
        <Field label={t('common.notes')} className="sm:col-span-2"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
