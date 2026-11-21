import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDay, fmtTime, ymd } from '@/lib/format';
import type { UserLite } from '@/lib/types';
import { Badge, Button, Card, Checkbox, DataTable, DateRangePicker, Dialog, Field, Input, PageHeader, Pagination, Select, StatCard, Tabs, presetRange, type Tone } from '@/components/ui';
import { useAttendancePolicy } from '../settings/AttendancePolicy';

interface Row {
  id: string; userId: string; date: string; checkIn: string | null; checkOut: string | null; status: string; lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number; overtimeMinutes: number;
  notes: string | null; excused: boolean; lateDecision: string | null; lateExcuse: string | null; lateExcuseStatus: string | null; overtimeDecision: string | null; editReason: string | null; editedBy: string | null;
  jobTitle: string | null; state: string; review: 'OK' | 'APPROVED' | 'NEEDS_REVIEW'; pending: string[];
  /** A shift that is over with nothing recorded: listed for review, not saved. */
  virtual?: boolean;
  user: { id: string; fullName: string; staffType: string }; shiftAssignment: { id: string; startTime: string; endTime: string; shift: { name: string } } | null;
}

const STATE_TONE: Record<string, Tone> = { PRESENT: 'success', COMPLETE: 'success', LATE: 'warning', EARLY_LEAVE: 'warning', ABSENT: 'danger', LEAVE: 'violet', NO_RECORD: 'neutral', NO_CHECKOUT: 'warning' };
const REVIEW_TONE: Record<string, Tone> = { OK: 'neutral', APPROVED: 'success', NEEDS_REVIEW: 'warning' };
const mins = (m: number) => (m ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)}س ` : ''}${m % 60 ? `${m % 60}د` : ''}`.trim() : '—');

export default function Attendance() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('attendance.manage');
  const otApprover = can('attendance.overtime.approve');
  const [tab, setTab] = useState<'records' | 'overtime'>('records');
  return (
    <div>
      <PageHeader title={t('staff.attendance')} subtitle={t('staff.attendanceSubtitle')} />
      {(otApprover || manage) && <Tabs className="mb-4" value={tab} onChange={setTab} items={[{ key: 'records' as const, label: t('staff.attendance') }, { key: 'overtime' as const, label: t('pol.a.manualOt') }]} />}
      {tab === 'records' ? <Records /> : <ManualOvertime />}
    </div>
  );
}

function Records() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const user = me?.user;
  const manage = can('attendance.manage');
  const policy = useAttendancePolicy();
  const users = useQuery({ queryKey: ['users', 'lookup'], queryFn: () => api.get<UserLite[]>('/users/lookup'), enabled: manage });
  const list = usePagedList<Row, { from: string; to: string; userId?: string; status?: string; pending?: string }>('attendance', '/staff/attendance', { pageSize: 30, filters: presetRange('week') });
  const totals = (list.data as unknown as { totals?: { lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number; overtimeMinutes: number } })?.totals;
  const [rec, setRec] = useState(false);
  const [fix, setFix] = useState<Row | null>(null);
  const [act, setAct] = useState<Row | null>(null);
  const [create, setCreate] = useState<Row | null>(null);
  const canAct = (r: Row) => manage || can('attendance.late.approve') || can('attendance.overtime.approve') || (r.userId === user?.id && r.lateMinutes > 0 && policy.data?.late.allowExcuse);
  return (
    <>
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => list.data && exportCsv('attendance', [
          { header: t('common.date'), value: (r: Row) => fmtDay(r.date) }, { header: t('staff.employee'), value: (r) => r.user.fullName }, { header: t('pol.a.job'), value: (r) => r.jobTitle ?? '' }, { header: t('staff.shift'), value: (r) => r.shiftAssignment?.shift.name ?? '' },
          { header: t('pol.a.start'), value: (r) => r.shiftAssignment?.startTime ?? '' }, { header: t('pol.a.end'), value: (r) => r.shiftAssignment?.endTime ?? '' },
          { header: t('staff.checkIn'), value: (r) => fmtTime(r.checkIn) }, { header: t('staff.checkOut'), value: (r) => fmtTime(r.checkOut) }, { header: t('common.status'), value: (r) => t(`pol.st.${r.state}`) },
          { header: t('staff.late'), value: (r) => r.lateMinutes }, { header: t('staff.early'), value: (r) => r.earlyLeaveMinutes }, { header: t('pol.a.overtime'), value: (r) => r.overtimeMinutes }, { header: t('staff.worked'), value: (r) => (r.workedMinutes / 60).toFixed(1) }, { header: t('pol.a.review'), value: (r) => t(`pol.rv.${r.review}`) },
        ], list.data.items)}>{t('common.exportCsv')}</Button>
        {manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRec(true)}>{t('staff.record')}</Button>}
      </div>
      {totals && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <StatCard label={t('staff.worked')} value={`${((totals.workedMinutes ?? 0) / 60).toFixed(1)} ${t('common.hours')}`} tone="success" />
          <StatCard label={t('staff.late')} value={t('staff.minutesShort', { m: totals.lateMinutes ?? 0 })} tone="warning" />
          <StatCard label={t('staff.early')} value={t('staff.minutesShort', { m: totals.earlyLeaveMinutes ?? 0 })} tone="danger" />
          <StatCard label={t('pol.a.overtime')} value={t('staff.minutesShort', { m: totals.overtimeMinutes ?? 0 })} tone="primary" />
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
            {['PRESENT', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'ABSENT', 'LEAVE', 'NO_RECORD'].map((s) => <option key={s} value={s}>{t(`enum.AttendanceStatus.${s}`)}</option>)}
          </Select>
          <DateRangePicker value={{ from: list.filters.from, to: list.filters.to }} onChange={(r) => list.setFilters(r)} />
          {manage && <Checkbox label={t('pol.a.pendingOnly')} checked={!!list.filters.pending} onChange={(e) => list.setFilters({ pending: e.target.checked ? '1' : undefined })} />}
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          columns={[
            { key: 'd', header: t('common.date'), cell: (r) => fmtDay(r.date) },
            { key: 'u', header: t('staff.employee'), cell: (r) => <><b>{r.user.fullName}</b>{r.jobTitle && <span className="block text-xs text-ink-muted">{r.jobTitle}</span>}</> },
            { key: 's', header: t('staff.shift'), hideOnMobile: true, cell: (r) => (r.shiftAssignment ? <>{r.shiftAssignment.shift.name}<span className="block text-xs text-ink-muted" dir="ltr">{r.shiftAssignment.startTime}–{r.shiftAssignment.endTime}</span></> : <span className="text-xs text-ink-muted">{t('pol.a.noShift')}</span>) },
            { key: 'i', header: t('staff.checkIn'), cell: (r) => <span className="tabular-nums">{fmtTime(r.checkIn)}</span> },
            { key: 'o', header: t('staff.checkOut'), cell: (r) => <span className="tabular-nums">{fmtTime(r.checkOut)}</span> },
            { key: 'l', header: t('staff.late'), hideOnMobile: true, cell: (r) => <>{mins(r.lateMinutes)}{r.lateDecision === 'EXEMPT' && <span className="block text-xs text-success-700">{t('pol.a.exempt')}</span>}{r.lateExcuseStatus && <span className="block text-xs text-ink-muted" title={r.lateExcuse ?? ''}>{t(`pol.a.excuseState.${r.lateExcuseStatus}`)}</span>}{r.earlyLeaveMinutes > 0 && <span className="block text-xs text-danger-700">{t('staff.early')}: {mins(r.earlyLeaveMinutes)}</span>}</> },
            { key: 'ot', header: t('pol.a.overtime'), hideOnMobile: true, cell: (r) => <>{mins(r.overtimeMinutes)}{r.overtimeDecision && <span className="block text-xs text-ink-muted">{t(`pol.pay.state.${r.overtimeDecision}`)}</span>}</> },
            { key: 'w', header: t('staff.worked'), hideOnMobile: true, cell: (r) => (r.workedMinutes ? (r.workedMinutes / 60).toFixed(1) : '—') },
            { key: 'st', header: t('common.status'), cell: (r) => <><Badge tone={STATE_TONE[r.state] ?? 'neutral'} dot>{t(`pol.st.${r.state}`)}</Badge>{r.status === 'ABSENT' && r.excused && <span className="block text-xs text-ink-muted">{t('pol.a.excused')}</span>}</> },
            { key: 'rv', header: t('pol.a.review'), cell: (r) => <span title={r.pending.map((p) => t(`pol.pend.${p}`)).join('، ')}><Badge tone={REVIEW_TONE[r.review]} dot={false}>{t(`pol.rv.${r.review}`)}</Badge>{r.editReason && <span className="block max-w-40 truncate text-[11px] text-ink-muted" title={r.editReason}>{t('pol.a.edited', { r: r.editReason, u: r.editedBy ?? '' })}</span>}</span> },
            { key: 'x', header: '', cell: (r) => r.virtual ? manage && <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} title={t('pol.a.recordHint')} onClick={() => setCreate(r)}>{t('pol.a.recordNow')}</Button> : canAct(r) && <Button size="sm" variant="ghost" icon={<MoreHorizontal className="h-4 w-4" />} onClick={() => setAct(r)}>{t('pol.a.actions')}</Button> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {rec && <RecordDialog users={users.data ?? []} onClose={() => setRec(false)} />}
      {fix && <RecordDialog users={users.data ?? []} onClose={() => setFix(null)} editing initial={{ userId: fix.user.id, date: fix.date.slice(0, 10), assignmentId: fix.shiftAssignment?.id ?? null, checkIn: hhmm(fix.checkIn), checkOut: hhmm(fix.checkOut), notes: fix.notes ?? '', status: ['ABSENT', 'LEAVE', 'NO_RECORD'].includes(fix.status) ? fix.status : '', excused: fix.excused, shift: fix.shiftAssignment ? { start: fix.shiftAssignment.startTime, end: fix.shiftAssignment.endTime } : undefined }} />}
      {create && <RecordDialog users={users.data ?? []} onClose={() => setCreate(null)} initial={{ userId: create.userId, date: create.date.slice(0, 10), assignmentId: create.shiftAssignment?.id ?? null, shift: create.shiftAssignment ? { start: create.shiftAssignment.startTime, end: create.shiftAssignment.endTime } : undefined }} />}
      {act && <ActionsDialog row={act} onEdit={() => { setFix(act); setAct(null); }} onClose={() => setAct(null)} />}
    </>
  );
}

const hhmm = (v: string | null) => (v ? `${String(new Date(v).getHours()).padStart(2, '0')}:${String(new Date(v).getMinutes()).padStart(2, '0')}` : '');

/** Every decision on one record, each with its reason (kept in the audit log). Only what the user may do is shown. */
function ActionsDialog({ row: r, onEdit, onClose }: { row: Row; onEdit: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const user = me?.user;
  const policy = useAttendancePolicy().data;
  const [reason, setReason] = useState('');
  const [excuse, setExcuse] = useState(r.lateExcuse ?? '');
  const post = useApiMutation((v: { path: string; body: object }) => api.post(`/staff/attendance/${r.id}/${v.path}`, v.body), { invalidate: [['attendance']], onSuccess: onClose });
  const go = (path: string, body: object) => post.mutate({ path, body: { ...body, reason } });
  const own = r.userId === user?.id;
  const block = (title: string, children: React.ReactNode) => <div className="rounded-xl border border-line p-3"><p className="mb-2 text-xs font-semibold text-ink-soft">{title}</p><div className="flex flex-wrap gap-2">{children}</div></div>;
  return (
    <Dialog open onClose={onClose} title={`${r.user.fullName} — ${fmtDay(r.date)}`} footer={<Button variant="outline" onClick={onClose}>{t('common.close')}</Button>}>
      <div className="space-y-3">
        {r.pending.length > 0 && <p className="rounded-lg bg-warning-50 px-3 py-2 text-xs text-warning-800">{r.pending.map((p) => t(`pol.pend.${p}`)).join(' · ')}</p>}
        {(can('attendance.manage') || can('attendance.late.approve') || can('attendance.overtime.approve')) && <Field label={t('pol.a.reasonReq')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        {can('attendance.manage') && block(t('staff.fixRow'), <>
          <Button size="sm" variant="outline" onClick={onEdit}>{t('common.edit')}</Button>
          {r.review !== 'APPROVED' && <Button size="sm" variant="success" loading={post.isPending} onClick={() => go('review', {})}>{t('pol.a.approveRecord')}</Button>}
        </>)}
        {can('attendance.manage') && r.status === 'ABSENT' && block(t('pol.a.absence'), <>
          <Button size="sm" variant={r.excused ? 'primary' : 'outline'} disabled={reason.length < 3} onClick={() => go('absence', { excused: true })}>{t('pol.a.excused')}</Button>
          <Button size="sm" variant={!r.excused ? 'primary' : 'outline'} disabled={reason.length < 3} onClick={() => go('absence', { excused: false })}>{t('pol.a.unexcused')}</Button>
        </>)}
        {r.lateMinutes > 0 && can('attendance.late.approve') && block(t('pol.a.lateDecision'), <>
          <Button size="sm" variant={r.lateDecision === 'DEDUCT' ? 'primary' : 'outline'} disabled={reason.length < 3} onClick={() => go('late', { decision: 'DEDUCT' })}>{t('pol.a.deduct')}</Button>
          {policy?.late.allowExemption && <Button size="sm" variant={r.lateDecision === 'EXEMPT' ? 'primary' : 'outline'} disabled={reason.length < 3} onClick={() => go('late', { decision: 'EXEMPT' })}>{t('pol.a.exempt')}</Button>}
          {r.lateDecision && <Button size="sm" variant="ghost" disabled={reason.length < 3} onClick={() => go('late', { decision: null })}>{t('pol.a.byPolicy')}</Button>}
          {r.lateExcuseStatus === 'PENDING' && <>
            <span className="w-full text-xs text-ink-soft">«{r.lateExcuse}»</span>
            <Button size="sm" variant="success" onClick={() => go('excuse-decision', { accept: true })}>{t('pol.a.acceptExcuse')}</Button>
            <Button size="sm" variant="outline" onClick={() => go('excuse-decision', { accept: false })}>{t('pol.a.rejectExcuse')}</Button>
          </>}
        </>)}
        {r.lateMinutes > 0 && own && policy?.late.allowExcuse && (!r.lateExcuseStatus || r.lateExcuseStatus === 'PENDING') && block(t('pol.a.excuse'), <>
          <Input value={excuse} onChange={(e) => setExcuse(e.target.value)} placeholder={t('pol.a.excuseText')} />
          <Button size="sm" disabled={excuse.trim().length < 3} loading={post.isPending} onClick={() => post.mutate({ path: 'excuse', body: { text: excuse } })}>{t('common.save')}</Button>
        </>)}
        {r.overtimeMinutes > 0 && can('attendance.overtime.approve') && block(`${t('pol.a.otDecision')} (${mins(r.overtimeMinutes)})`, <>
          <Button size="sm" variant={r.overtimeDecision === 'APPROVED' ? 'primary' : 'outline'} disabled={reason.length < 3} onClick={() => go('overtime', { decision: 'APPROVED' })}>{t('pol.a.approveOt')}</Button>
          <Button size="sm" variant={r.overtimeDecision === 'REJECTED' ? 'primary' : 'outline'} disabled={reason.length < 3} onClick={() => go('overtime', { decision: 'REJECTED' })}>{t('pol.a.rejectOt')}</Button>
          {r.overtimeDecision && <Button size="sm" variant="ghost" disabled={reason.length < 3} onClick={() => go('overtime', { decision: null })}>{t('pol.a.byPolicy')}</Button>}
        </>)}
      </div>
    </Dialog>
  );
}

/** Manual attendance entry or correction (a correction needs a reason); also used from the schedule to fix an automatic «غائب». */
export function RecordDialog({ users, onClose, initial, editing }: { users: UserLite[]; onClose: () => void; editing?: boolean; initial?: { userId: string; date: string; assignmentId?: string | null; checkIn?: string; checkOut?: string; notes?: string; status?: string; excused?: boolean; shift?: { start: string; end: string } } }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ userId: initial?.userId ?? '', date: initial?.date ?? ymd(), status: initial?.status ?? '', checkIn: initial?.checkIn ?? '', checkOut: initial?.checkOut ?? '', notes: initial?.notes ?? '', excused: initial?.excused ?? false, reason: '', assignmentId: '' });
  // Attendance is per shift: a record opened from a shift keeps it; a new entry picks the employee's shift that day.
  const fixed = initial?.assignmentId !== undefined;
  const shifts = useQuery({
    queryKey: ['schedule', 'day', v.userId, v.date], enabled: !fixed && !!v.userId && !!v.date,
    queryFn: () => api.get<{ assignments: { id: string; startTime: string; endTime: string; shift: { name: string } }[] }>('/staff/schedule', { from: v.date, to: v.date, userId: v.userId }),
  });
  const list = shifts.data?.assignments ?? [];
  const chosen = fixed ? initial?.assignmentId ?? null : list.length === 1 ? list[0].id : v.assignmentId === 'none' ? null : v.assignmentId || undefined;
  const sel = list.find((a) => a.id === chosen);
  const shiftTimes = initial?.shift ?? (sel && { start: sel.startTime, end: sel.endTime });
  const at = (hm: string) => (hm ? new Date(`${v.date}T${hm}:00`).toISOString() : null);
  // Overnight shifts: a leave time earlier than the arrival time belongs to the next day.
  const out = () => { const o = at(v.checkOut); return o && v.checkIn && v.checkOut <= v.checkIn ? new Date(new Date(o).getTime() + 86_400_000).toISOString() : o; };
  const save = useApiMutation(() => api.post('/staff/attendance', { userId: v.userId, date: v.date, assignmentId: chosen, status: v.status || undefined, checkIn: at(v.checkIn), checkOut: out(), excused: v.status === 'ABSENT' ? v.excused : undefined, notes: v.notes || null, reason: v.reason || undefined }), { invalidate: [['attendance'], ['schedule']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={editing ? t('staff.fixRow') : t('staff.record')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={(editing && v.reason.trim().length < 3) || (!fixed && list.length > 1 && !v.assignmentId)} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('staff.employee')} required error={save.fieldErrors.userId}><Select value={v.userId} disabled={!!initial} onChange={(e) => setV({ ...v, userId: e.target.value })} placeholder={t('common.select')}>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></Field>
        <Field label={t('common.date')}><Input type="date" value={v.date} disabled={!!initial} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        {!fixed && list.length > 1 && (
          <Field label={t('staff.shift')} required className="sm:col-span-2">
            <Select value={v.assignmentId} onChange={(e) => setV({ ...v, assignmentId: e.target.value })} placeholder={t('common.select')}>
              {list.map((a) => <option key={a.id} value={a.id}>{a.shift.name} ({a.startTime}–{a.endTime})</option>)}
              <option value="none">{t('pol.a.noShift')}</option>
            </Select>
          </Field>
        )}
        <Field label={t('common.status')}>
          <Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>
            <option value="">{t('enum.AttendanceStatus.PRESENT')}</option>
            <option value="ABSENT">{t('enum.AttendanceStatus.ABSENT')}</option>
            <option value="LEAVE">{t('enum.AttendanceStatus.LEAVE')}</option>
            <option value="NO_RECORD">{t('enum.AttendanceStatus.NO_RECORD')}</option>
          </Select>
        </Field>
        <div className="flex items-end">{v.status === 'ABSENT' && <Checkbox label={t('pol.a.excused')} checked={v.excused} onChange={(e) => setV({ ...v, excused: e.target.checked })} />}
          {!v.status && shiftTimes && <Button size="sm" variant="outline" onClick={() => setV({ ...v, checkIn: shiftTimes.start, checkOut: shiftTimes.end })}>{t('pol.a.byShift')} ({shiftTimes.start}–{shiftTimes.end})</Button>}</div>
        {!v.status && <><Field label={t('staff.checkIn')}><Input type="time" value={v.checkIn} onChange={(e) => setV({ ...v, checkIn: e.target.value })} /></Field><Field label={t('staff.checkOut')}><Input type="time" value={v.checkOut} onChange={(e) => setV({ ...v, checkOut: e.target.value })} /></Field></>}
        <Field label={t('common.notes')} className="sm:col-span-2"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        <Field label={t('pol.reason')} required={editing} hint={t('pol.reasonHint')} className="sm:col-span-2"><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

interface OtRow { id: string; userId: string; user: string; date: string; startAt: string; endAt: string; minutes: number; reason: string; createdBy: string | null }

function ManualOvertime() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const edit = can('attendance.overtime.approve');
  const [range, setRange] = useState(presetRange('month'));
  const q = useQuery({ queryKey: ['attendance', 'overtime', range], queryFn: () => api.get<OtRow[]>('/staff/overtime', { ...range }) });
  const users = useQuery({ queryKey: ['users', 'lookup'], queryFn: () => api.get<UserLite[]>('/users/lookup') });
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState<OtRow | null>(null);
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">{t('pol.a.manualOtHint')}</p>
        <div className="flex gap-2"><DateRangePicker value={range} onChange={(r) => setRange({ from: r.from ?? range.from, to: r.to ?? range.to })} />{edit && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdd(true)}>{t('pol.a.addOt')}</Button>}</div>
      </div>
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} columns={[
        { key: 'd', header: t('common.date'), cell: (r) => fmtDay(r.date) },
        { key: 'u', header: t('staff.employee'), cell: (r) => <b>{r.user}</b> },
        { key: 'p', header: `${t('pol.a.from')} – ${t('pol.a.to')}`, cell: (r) => <span dir="ltr" className="tabular-nums">{fmtTime(r.startAt)} – {fmtTime(r.endAt)}</span> },
        { key: 'm', header: t('pol.a.overtime'), cell: (r) => mins(r.minutes) },
        { key: 'r', header: t('pol.a.reason'), cell: (r) => <>{r.reason}<span className="block text-xs text-ink-muted">{r.createdBy}</span></> },
        { key: 'x', header: '', cell: (r) => edit && <Button size="sm" variant="ghost" onClick={() => setDel(r)}>{t('pol.a.delete')}</Button> },
      ]} />
      {add && <OvertimeForm users={users.data ?? []} onClose={() => setAdd(false)} />}
      {del && <DeleteOvertime row={del} onClose={() => setDel(null)} />}
    </Card>
  );
}

function OvertimeForm({ users, onClose }: { users: UserLite[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ userId: '', date: ymd(), start: '', end: '', reason: '' });
  const save = useApiMutation(() => api.post('/staff/overtime', v), { invalidate: [['attendance']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={t('pol.a.addOt')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={!v.userId || !v.start || !v.end || v.reason.trim().length < 3} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('staff.employee')} required><Select value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })} placeholder={t('common.select')}>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></Field>
        <Field label={t('common.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('pol.a.from')}><Input type="time" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} /></Field>
        <Field label={t('pol.a.to')}><Input type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} /></Field>
        <Field label={t('pol.a.reasonReq')} className="sm:col-span-2"><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function DeleteOvertime({ row, onClose }: { row: OtRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const del = useApiMutation(() => api.post(`/staff/overtime/${row.id}/delete`, { reason }), { invalidate: [['attendance']], onSuccess: onClose });
  return (
    <Dialog open size="sm" onClose={onClose} title={`${t('pol.a.delete')}: ${row.user} — ${fmtDay(row.date)}`} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button variant="danger" loading={del.isPending} disabled={reason.trim().length < 3} onClick={() => del.mutate(undefined)}>{t('pol.a.delete')}</Button></>}>
      <Field label={t('pol.a.deleteReason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}
