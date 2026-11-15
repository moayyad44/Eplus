import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronDown, HandCoins, Plus, Printer, RefreshCw, RotateCcw, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { amt0, today } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, ErrorState, Field, Input, PageHeader, PageLoader, Select, Tabs, useConfirm } from '@/components/ui';
import { Money, ReportActions, TreasurySelect, exportXlsx } from './shared';
import { useAttendancePolicy, type AttendancePolicy } from '../settings/AttendancePolicy';

type Tab = 'runs' | 'profiles' | 'advances';
const STATUS_TONE = { DRAFT: 'warning', APPROVED: 'primary', PAID: 'success' } as const;

export default function Payroll() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'runs';
  return (
    <div>
      <PageHeader title={t('ao.pay.title')} subtitle={t('ao.pay.subtitle')} />
      <Tabs className="mb-4" value={tab} onChange={(k) => setSp({ tab: k })} items={[{ key: 'runs' as Tab, label: t('ao.pay.runs') }, { key: 'profiles' as Tab, label: t('ao.pay.profiles') }, { key: 'advances' as Tab, label: t('ao.pay.advances') }]} />
      {tab === 'runs' && <Runs />}
      {tab === 'profiles' && <Profiles />}
      {tab === 'advances' && <Advances />}
    </div>
  );
}

interface RunRow { id: string; month: string; status: keyof typeof STATUS_TONE; employees: number; total: number; dueDate: string | null; paidDate: string | null }
function Runs() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['acc', 'payroll-runs'], queryFn: () => api.get<RunRow[]>('/accounting/payroll/runs') });
  const [month, setMonth] = useState(today().slice(0, 7));
  const create = useApiMutation(() => api.post<{ id: string }>('/accounting/payroll/runs', { month }), { invalidate: [['acc']], onSuccess: (r) => nav(`/accounting/payroll/${r.id}`) });
  return (
    <Card padded={false}>
      <CardHeader className="p-4" title={t('ao.pay.runs')} actions={can('accounting.payroll.manage') && <div className="flex items-end gap-2"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" /><Button icon={<Plus className="h-4 w-4" />} loading={create.isPending} onClick={() => create.mutate(undefined)}>{t('ao.pay.prepare')}</Button></div>} />
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} onRowClick={(r) => nav(`/accounting/payroll/${r.id}`)} columns={[
        { key: 'm', header: t('ao.pay.month'), cell: (r) => <b dir="ltr">{r.month}</b> },
        { key: 'e', header: t('ao.pay.employees'), align: 'center', cell: (r) => r.employees },
        { key: 't', header: t('ao.pay.net'), align: 'end', cell: (r) => <Money v={r.total} /> },
        { key: 'p', header: t('ao.pay.paidDate'), cell: (r) => r.paidDate ?? '—' },
        { key: 's', header: t('acc.f.status'), cell: (r) => <Badge tone={STATUS_TONE[r.status]} dot={false}>{t(`ao.pay.st.${r.status}`)}</Badge> },
      ]} />
    </Card>
  );
}

interface SlipItem { id: string; kind: string; sourceType: string; sourceId: string; date: string; minutes: number; days: string; amount: string; state: string; note: string | null; waived: boolean; waiveReason: string | null }
interface Slip {
  id: string; userId: string; user: string; jobTitle: string | null; payType: 'MONTHLY' | 'HOURLY'; hours: string; hourlyRate: string; basic: string; allowances: string; commission: string; bonus: string; overtime: string;
  absenceDays: string; lateMinutes: number; absenceDeduction: string; lateDeduction: string; earlyDeduction: string; deductions: string; advance: string; net: string; notes: string | null;
  workDays: number; leaveDays: string; lateCount: number; earlyMinutes: number; overtimeMinutes: number; reviewDays: number; pendingAdjust: { values: Record<string, number>; byName: string; at: string } | null; items: SlipItem[];
}
interface Run extends RunRow { slips: Slip[]; entries: { id: string; number: string; sourceKey: string; status: string }[] }
const EDIT = ['allowances', 'commission', 'bonus', 'deductions', 'advance'] as const;
const ADD = ['basic', 'allowances', 'commission', 'bonus', 'overtime'] as const;
const SUB = ['absenceDeduction', 'lateDeduction', 'earlyDeduction', 'deductions', 'advance'] as const;
const fLabel = (t: (k: string) => string, k: string) => (k === 'lateDeduction' || k === 'earlyDeduction' ? t(`pol.pay.f.${k}`) : t(`ao.pay.f.${k}`));
const ITEM_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'primary'> = { DEDUCTED: 'danger', PAID: 'success', EXEMPT: 'primary', EXCUSED: 'primary', PENDING: 'warning', REJECTED: 'neutral', OFF: 'neutral', BELOW_MIN: 'neutral', NOT_ELIGIBLE: 'neutral', HOURLY: 'neutral' };

export function PayrollRun() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('accounting.payroll.manage');
  const approver = can('accounting.payroll.approve');
  const adjust = can('accounting.payroll.adjust');
  const q = useQuery({ queryKey: ['acc', 'payroll-run', id], queryFn: () => api.get<Run>(`/accounting/payroll/runs/${id}`) });
  const [edit, setEdit] = useState<Slip | null>(null);
  const [paying, setPaying] = useState(false);
  const [print, setPrint] = useState<Slip | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [waive, setWaive] = useState<SlipItem | null>(null);
  const act = useApiMutation((a: 'approve' | 'reopen' | 'recalculate') => api.post(`/accounting/payroll/runs/${id}/${a}`, {}), { invalidate: [['acc']] });
  const adj = useApiMutation((v: { slip: string; accept: boolean }) => api.post(`/accounting/payroll/runs/${id}/slips/${v.slip}/adjust-decision`, { accept: v.accept }), { invalidate: [['acc']] });
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} />;
  const r = q.data!;
  const sum = (k: keyof Slip) => r.slips.reduce((s, x) => s + Number(x[k]), 0);
  const cols = [...ADD, ...SUB, 'net'] as const;
  const pending = r.slips.filter((s) => s.pendingAdjust).length;
  const excel = () => exportXlsx(`${t('ao.pay.title')} ${r.month}`, [{ header: t('ao.pay.employee'), key: 'user' }, { header: t('ao.pay.job'), key: 'jobTitle' }, ...cols.map((c) => ({ header: fLabel(t, c), key: c, money: true })), { header: t('ao.pay.payType'), key: 'pt' }, { header: t('ao.pay.hours'), key: 'hrs' }, { header: t('ao.pay.hourlyRate'), key: 'rate', money: true }, { header: t('pol.pay.workDays'), key: 'workDays' }, { header: t('pol.pay.absenceDays'), key: 'absenceDays' }, { header: t('pol.pay.leaveDays'), key: 'leaveDays' }, { header: t('pol.pay.lateCount'), key: 'lateCount' }, { header: t('pol.pay.lateMinutes'), key: 'lateMinutes' }, { header: t('pol.pay.earlyMinutes'), key: 'earlyMinutes' }, { header: t('pol.pay.overtimeHours'), key: 'otH' }],
    r.slips.map((s) => ({ ...s, ...Object.fromEntries(cols.map((c) => [c, Number(s[c])])), pt: t(`ao.pay.pt.${s.payType}`), hrs: s.payType === 'HOURLY' ? Number(s.hours) : null, rate: s.payType === 'HOURLY' ? Number(s.hourlyRate) : null, absenceDays: Number(s.absenceDays), leaveDays: Number(s.leaveDays), otH: Math.round(s.overtimeMinutes / 6) / 10 })), [...cols]);
  if (print) return <Payslip run={r} slip={print} onBack={() => setPrint(null)} />;
  return (
    <div>
      <PageHeader title={`${t('ao.pay.title')} ${r.month}`} subtitle={<Badge tone={STATUS_TONE[r.status]} dot={false}>{t(`ao.pay.st.${r.status}`)}</Badge>} back={<Link to="/accounting/payroll" className="text-sm text-primary-700">{t('ao.pay.runs')}</Link>} actions={<ReportActions onExcel={excel} extra={<>
        {r.status === 'DRAFT' && manage && <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} loading={act.isPending && act.variables === 'recalculate'} title={t('pol.pay.recalcHint')} onClick={() => act.mutate('recalculate')}>{t('pol.pay.recalc')}</Button>}
        {r.status === 'DRAFT' && approver && <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} disabled={pending > 0} title={pending ? t('pol.pay.approveBlocked') : undefined} onClick={async () => (await confirm({ message: t('ao.pay.approveConfirm', { t: amt0(sum('net')) }) })) && act.mutate('approve')}>{t('ao.approve')}</Button>}
        {r.status === 'APPROVED' && approver && <Button variant="outline" icon={<RotateCcw className="h-4 w-4" />} onClick={() => act.mutate('reopen')}>{t('ao.pay.reopen')}</Button>}
        {r.status === 'APPROVED' && manage && <Button icon={<Wallet className="h-4 w-4" />} onClick={() => setPaying(true)}>{t('ao.pay.pay')}</Button>}
      </>} />} />
      <p className="mb-3 text-xs text-ink-muted print:hidden">{t('ao.pay.runHint')} {r.status === 'DRAFT' && t('pol.pay.recalcHint')}</p>
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
            <thead><tr className="border-b border-line bg-surface-subtle text-xs text-ink-muted"><th className="p-2 text-start">{t('ao.pay.employee')}</th>{cols.map((c) => <th key={c} className="p-2 text-end">{fLabel(t, c)}</th>)}<th className="p-2 print:hidden" /></tr></thead>
            <tbody>{r.slips.map((s) => (
              <Fragment key={s.id}>
                <tr className="border-b border-line/60 align-top">
                  <td className="p-2">
                    <b>{s.user}</b>
                    <span className="block text-xs text-ink-muted">{s.payType === 'HOURLY' && <span className="me-1 rounded bg-primary-50 px-1 text-primary-800">{t('ao.pay.hoursLine', { h: Number(s.hours), r: amt0(s.hourlyRate) })}</span>}{s.jobTitle}</span>
                    <span className="block text-[11px] text-ink-muted">{t('pol.pay.workDays')} {s.workDays} · {t('pol.pay.absenceDays')} {Number(s.absenceDays)} · {t('pol.pay.leaveDays')} {Number(s.leaveDays)} · {t('pol.pay.lateCount')} {s.lateCount} ({s.lateMinutes} د) · {t('pol.pay.overtimeHours')} {Math.round(s.overtimeMinutes / 6) / 10}</span>
                    {s.reviewDays > 0 && <span className="mt-0.5 inline-block rounded bg-warning-50 px-1 text-[11px] text-warning-800">{t('pol.pay.reviewDays', { n: s.reviewDays })}</span>}
                    {s.pendingAdjust && <span className="mt-1 flex flex-wrap items-center gap-1 rounded bg-warning-50 px-1.5 py-1 text-[11px] text-warning-800">
                      {t('pol.pay.pending', { u: s.pendingAdjust.byName })}: {Object.entries(s.pendingAdjust.values).map(([k, x]) => `${k === 'hours' ? t('ao.pay.hours') : k === 'hourlyRate' ? t('ao.pay.hourlyRate') : fLabel(t, k)} ${x}`).join('، ')}
                      {approver && r.status === 'DRAFT' && <><Button size="sm" variant="success" onClick={() => adj.mutate({ slip: s.id, accept: true })}>{t('pol.pay.acceptAdj')}</Button><Button size="sm" variant="outline" onClick={() => adj.mutate({ slip: s.id, accept: false })}>{t('pol.pay.rejectAdj')}</Button></>}
                    </span>}
                  </td>
                  {cols.map((c) => <td key={c} className={`p-2 text-end ${c === 'net' ? 'font-bold' : ''}`}><Money v={s[c]} /></td>)}
                  <td className="p-2 print:hidden"><div className="flex gap-1">
                    {s.items.length > 0 && <Button size="sm" variant="ghost" icon={<ChevronDown className={`h-3.5 w-3.5 transition ${open === s.id ? 'rotate-180' : ''}`} />} onClick={() => setOpen(open === s.id ? null : s.id)}>{t('pol.pay.details')} ({s.items.length})</Button>}
                    {adjust && r.status === 'DRAFT' && <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>{t('common.edit')}</Button>}
                    <Button size="sm" variant="ghost" icon={<Printer className="h-3.5 w-3.5" />} onClick={() => setPrint(s)}>{t('ao.pay.slip')}</Button>
                  </div></td>
                </tr>
                {open === s.id && <tr className="border-b border-line bg-surface-subtle/60"><td colSpan={cols.length + 2} className="p-3"><ItemsTable items={s.items} onWaive={approver && r.status === 'DRAFT' ? setWaive : undefined} /></td></tr>}
              </Fragment>
            ))}</tbody>
            <tfoot><tr className="bg-surface-subtle font-bold"><td className="p-2">{t('acc.f.total')}</td>{cols.map((c) => <td key={c} className="p-2 text-end"><Money v={sum(c)} /></td>)}<td className="print:hidden" /></tr></tfoot>
          </table>
        </div>
      </Card>
      {r.entries.length > 0 && <p className="mt-3 text-sm print:hidden">{r.entries.map((e) => <Link key={e.id} className="me-3 text-primary-700" to={`/accounting/journal/${e.id}`}>{t('ao.v.entry', { n: e.number })}</Link>)}</p>}
      {edit && <SlipForm runId={r.id} slip={edit} onClose={() => setEdit(null)} />}
      {waive && <WaiveForm runId={r.id} item={waive} onClose={() => setWaive(null)} />}
      {paying && <PayForm runId={r.id} total={sum('net')} onClose={() => setPaying(false)} />}
    </div>
  );
}

/** Every attendance line of a slip with its source (day, minutes, rule applied); waived lines stay visible. */
function ItemsTable({ items, onWaive }: { items: SlipItem[]; onWaive?: (i: SlipItem) => void }) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-ink-muted"><th className="p-1 text-start">{t('ao.date')}</th><th className="p-1 text-start">{t('pol.pay.type')}</th><th className="p-1 text-start">{t('pol.a.overtime')}/{t('staff.late')}</th><th className="p-1 text-start">{t('common.status')}</th><th className="p-1 text-start">{t('ao.notes')}</th><th className="p-1 text-end">{t('acc.f.amount')}</th>{onWaive && <th />}</tr></thead>
      <tbody>{items.map((i) => (
        <tr key={i.id} className={`border-t border-line/60 ${i.waived ? 'opacity-60' : ''}`}>
          <td className="p-1 tabular-nums" dir="ltr">{i.date}</td>
          <td className="p-1">{t(`pol.pay.kind.${i.kind}`)}</td>
          <td className="p-1">{i.minutes ? t('pol.pay.minutes', { m: i.minutes }) : Number(i.days) ? `${Number(i.days)} يوم` : '—'}</td>
          <td className="p-1"><Badge tone={i.waived ? 'primary' : ITEM_TONE[i.state] ?? 'neutral'} dot={false}>{t(`pol.pay.state.${i.waived ? 'WAIVED' : i.state}`)}</Badge>{i.waived && i.waiveReason && <span className="block text-[11px] text-ink-muted">{i.waiveReason}</span>}</td>
          <td className="p-1 text-ink-soft">{i.kind === 'LEAVE' ? t(`pol.pay.leaveType.${i.note}`) : i.note}</td>
          <td className={`p-1 text-end font-semibold ${i.waived ? 'line-through' : ''}`}><Money v={i.amount} /></td>
          {onWaive && <td className="p-1 text-end">{Number(i.amount) > 0 && <Button size="sm" variant="ghost" onClick={() => onWaive(i)}>{i.waived ? t('pol.pay.unwaive') : t('pol.pay.waive')}</Button>}</td>}
        </tr>
      ))}</tbody>
    </table>
  );
}

function WaiveForm({ runId, item, onClose }: { runId: string; item: SlipItem; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const save = useApiMutation(() => api.post(`/accounting/payroll/runs/${runId}/items/${item.id}/waive`, { waived: !item.waived, reason }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open size="sm" onClose={onClose} title={`${item.waived ? t('pol.pay.unwaive') : t('pol.pay.waive')}: ${t(`pol.pay.kind.${item.kind}`)} ${item.date}`} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <p className="mb-3 text-sm">{t('acc.f.amount')}: <b><Money v={item.amount} /></b></p>
      <Field label={t('pol.pay.waiveReason')} required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function SlipForm({ runId, slip, onClose }: { runId: string; slip: Slip; onClose: () => void }) {
  const { t } = useTranslation();
  const hourly = slip.payType === 'HOURLY';
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries([...EDIT.map((k) => [k, String(Number(slip[k]))]), ['notes', slip.notes ?? ''], ['hours', String(Number(slip.hours))], ['hourlyRate', String(Number(slip.hourlyRate))]]));
  const save = useApiMutation(() => api.put<{ pending?: boolean }>(`/accounting/payroll/runs/${runId}/slips/${slip.id}`, { ...Object.fromEntries(EDIT.map((k) => [k, Number(v[k] || 0)])), ...(hourly && { hours: Number(v.hours || 0), hourlyRate: Number(v.hourlyRate || 0) }), notes: v.notes || null }), { invalidate: [['acc']], onSuccess: (r) => { if (r?.pending) toast.info(t('pol.pay.pendingSent')); onClose(); } });
  const basic = hourly ? Math.round(Number(v.hours || 0) * Number(v.hourlyRate || 0) * 1000) / 1000 : Number(slip.basic);
  return (
    <Dialog open onClose={onClose} title={slip.user} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      {hourly && <div className="mb-3 grid gap-3 rounded-xl bg-primary-50 p-3 sm:grid-cols-2">
        <Field label={t('ao.pay.hours')} hint={t('ao.pay.hoursHint')}><Input type="number" step="0.25" min="0" dir="ltr" value={v.hours} onChange={(e) => setV({ ...v, hours: e.target.value })} /></Field>
        <Field label={t('ao.pay.hourlyRate')}><Input type="number" step="0.001" min="0" dir="ltr" value={v.hourlyRate} onChange={(e) => setV({ ...v, hourlyRate: e.target.value })} /></Field>
      </div>}
      <p className="mb-3 text-sm text-ink-muted">{t('ao.pay.f.basic')}: <b>{amt0(basic)}</b>{hourly && ` (${t('ao.pay.hoursTimesRate')})`} · {t('ao.pay.f.overtime')}: {amt0(slip.overtime)} · {t('ao.pay.f.absenceDeduction')}: {amt0(slip.absenceDeduction)} · {t('pol.pay.f.lateDeduction')}: {amt0(slip.lateDeduction)} · {t('pol.pay.f.earlyDeduction')}: {amt0(slip.earlyDeduction)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {EDIT.map((k) => <Field key={k} label={t(`ao.pay.f.${k}`)}><Input type="number" step="0.001" min="0" dir="ltr" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}
        <Field label={t('ao.notes')} className="sm:col-span-2"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function PayForm({ runId, total, onClose }: { runId: string; total: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ date: today(), treasuryId: '' });
  const save = useApiMutation(() => api.post(`/accounting/payroll/runs/${runId}/pay`, v), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={t('ao.pay.pay')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button disabled={!v.treasuryId} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <p className="mb-3 text-sm">{t('ao.pay.payTotal', { t: amt0(total) })}</p>
      <div className="space-y-3">
        <Field label={t('ao.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('ao.pay.payFrom')}><TreasurySelect value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>
      </div>
    </Dialog>
  );
}

function Payslip({ run, slip, onBack }: { run: Run; slip: Slip; onBack: () => void }) {
  const { t } = useTranslation();
  const clinic = useQuery({ queryKey: ['public-clinic'], queryFn: () => api.get<{ name: string; hasLogo: boolean }>('/public/clinic') });
  const add = ADD, sub = SUB;
  return (
    <div>
      <div className="mb-3 flex gap-2 print:hidden"><Button variant="outline" onClick={onBack}>{t('common.back')}</Button><Button icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button></div>
      <div className="mx-auto max-w-2xl rounded-2xl border border-line bg-white p-8 print:border-0 print:p-0">
        <div className="flex items-center justify-between border-b-2 border-primary-700 pb-3"><p className="text-xl font-extrabold text-primary-800">{clinic.data?.name}</p>{clinic.data?.hasLogo && <img src="/api/public/logo" alt="" className="h-14" />}</div>
        <p className="my-4 text-center text-lg font-bold">{t('ao.pay.slipTitle', { m: run.month })}</p>
        <p className="mb-4 text-sm">{t('ao.pay.employee')}: <b>{slip.user}</b>{slip.jobTitle && ` — ${slip.jobTitle}`}{slip.payType === 'HOURLY' && <span className="block text-xs text-ink-muted">{t('ao.pay.hoursLine', { h: Number(slip.hours), r: amt0(slip.hourlyRate) })}</span>}</p>
        <div className="grid grid-cols-2 gap-6 text-sm">
          <div><p className="mb-2 font-bold text-success-700">{t('ao.pay.earnings')}</p>{add.map((k) => Number(slip[k]) > 0 && <p key={k} className="flex justify-between border-b border-dotted border-line py-1"><span>{t(`ao.pay.f.${k}`)}</span><Money v={slip[k]} /></p>)}</div>
          <div><p className="mb-2 font-bold text-danger-700">{t('ao.pay.deductionsTitle')}</p>{sub.map((k) => Number(slip[k]) > 0 && <p key={k} className="flex justify-between border-b border-dotted border-line py-1"><span>{fLabel(t, k)}</span><Money v={slip[k]} /></p>)}{Number(slip.absenceDays) > 0 && <p className="text-xs text-ink-muted">{t('ao.pay.absent', { n: Number(slip.absenceDays) })}</p>}</div>
        </div>
        <p className="mt-4 text-xs text-ink-soft">{t('pol.pay.workDays')} {slip.workDays} · {t('pol.pay.absenceDays')} {Number(slip.absenceDays)} · {t('pol.pay.leaveDays')} {Number(slip.leaveDays)} · {t('pol.pay.lateCount')} {slip.lateCount} · {t('pol.pay.lateMinutes')} {slip.lateMinutes} · {t('pol.pay.earlyMinutes')} {slip.earlyMinutes} · {t('pol.pay.overtimeHours')} {Math.round(slip.overtimeMinutes / 6) / 10}</p>
        {slip.items.some((i) => Number(i.amount) > 0) && <div className="mt-3"><ItemsTable items={slip.items.filter((i) => Number(i.amount) > 0)} /></div>}
        <p className="mt-6 flex justify-between rounded-xl bg-primary-50 px-4 py-3 text-lg font-extrabold"><span>{t('ao.pay.f.net')}</span><span><Money v={slip.net} /> JOD</span></p>
        <div className="mt-12 grid grid-cols-2 gap-6 text-center text-sm">{[t('ao.pay.sigEmployee'), t('ao.v.sigManager')].map((s) => <div key={s}><div className="mb-1 h-10 border-b border-dashed border-line-strong" />{s}</div>)}</div>
      </div>
    </div>
  );
}

interface Prof { user: { id: string; fullName: string; staffType: string | null; role: { name: string } }; profile: { jobTitle: string | null; payType: 'MONTHLY' | 'HOURLY'; basic: string; hourlyRate: string; allowances: { name: string; amount: number }[]; paymentMethod: string; treasuryId: string | null; isActive: boolean; policy?: EmpPolicy } | null }
function Profiles() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['acc', 'payroll-profiles'], queryFn: () => api.get<Prof[]>('/accounting/payroll/profiles') });
  const [edit, setEdit] = useState<Prof | null>(null);
  return (
    <Card padded={false}>
      <p className="p-4 text-xs text-ink-muted">{t('ao.pay.profilesHint')}</p>
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} rowKey={(r) => r.user.id} onRowClick={can('accounting.payroll.manage') ? setEdit : undefined} columns={[
        { key: 'n', header: t('ao.pay.employee'), cell: (r) => <><b>{r.user.fullName}</b><span className="block text-xs text-ink-muted">{r.user.role.name}</span></> },
        { key: 'j', header: t('ao.pay.job'), cell: (r) => r.profile?.jobTitle },
        { key: 't', header: t('ao.pay.payType'), cell: (r) => r.profile && <Badge tone={r.profile.payType === 'HOURLY' ? 'primary' : 'neutral'} dot={false}>{t(`ao.pay.pt.${r.profile.payType}`)}</Badge> },
        { key: 'b', header: t('ao.pay.salaryOrRate'), align: 'end', cell: (r) => r.profile ? (r.profile.payType === 'HOURLY' ? <span><Money v={r.profile.hourlyRate} /> <span className="text-xs text-ink-muted">{t('ao.pay.perHour')}</span></span> : <Money v={r.profile.basic} />) : <span className="text-xs text-ink-muted">{t('ao.pay.noProfile')}</span> },
        { key: 'a', header: t('ao.pay.f.allowances'), align: 'end', cell: (r) => r.profile ? <Money v={r.profile.allowances.reduce((s, a) => s + Number(a.amount), 0)} /> : '' },
        { key: 'm', header: t('ao.method'), cell: (r) => r.profile && t(`ao.methods.${r.profile.paymentMethod}`) },
        { key: 's', header: '', cell: (r) => r.profile && !r.profile.isActive && <Badge dot={false}>{t('ao.stopped')}</Badge> },
      ]} />
      {edit && <ProfileForm p={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function ProfileForm({ p, onClose }: { p: Prof; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ jobTitle: p.profile?.jobTitle ?? '', payType: p.profile?.payType ?? 'MONTHLY', basic: p.profile ? String(Number(p.profile.basic)) : '', hourlyRate: p.profile ? String(Number(p.profile.hourlyRate)) : '', paymentMethod: p.profile?.paymentMethod ?? 'TRANSFER', treasuryId: p.profile?.treasuryId ?? '', isActive: p.profile?.isActive ?? true });
  const [al, setAl] = useState<{ name: string; amount: string }[]>((p.profile?.allowances ?? []).map((a) => ({ name: a.name, amount: String(a.amount) })));
  const general = useAttendancePolicy().data;
  // A new profile starts with the pay type chosen in Settings → Medical.
  useEffect(() => { if (!p.profile && general) setV((x) => ({ ...x, payType: general.payroll.defaultPayType })); }, [general, p.profile]);
  const [pol, setPol] = useState<EmpPolicy>(p.profile?.policy ?? {});
  const save = useApiMutation(() => api.put(`/accounting/payroll/profiles/${p.user.id}`, { ...v, jobTitle: v.jobTitle || null, basic: Number(v.basic || 0), hourlyRate: Number(v.hourlyRate || 0), treasuryId: v.treasuryId || null, allowances: al.filter((a) => a.name).map((a) => ({ name: a.name, amount: Number(a.amount || 0) })), policy: Object.fromEntries(Object.entries(pol).filter(([, x]) => x !== undefined && x !== '')) }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={p.user.fullName} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.pay.job')}><Input value={v.jobTitle} onChange={(e) => setV({ ...v, jobTitle: e.target.value })} /></Field>
        <Field label={t('ao.pay.payType')} group>
          <div className="flex gap-2">{(['MONTHLY', 'HOURLY'] as const).map((k) => <Button key={k} size="sm" variant={v.payType === k ? 'primary' : 'outline'} onClick={() => setV({ ...v, payType: k })}>{t(`ao.pay.pt.${k}`)}</Button>)}</div>
        </Field>
        {v.payType === 'MONTHLY'
          ? <Field label={t('ao.pay.monthlySalary')}><Input type="number" step="0.001" dir="ltr" value={v.basic} onChange={(e) => setV({ ...v, basic: e.target.value })} /></Field>
          : <Field label={t('ao.pay.hourlyRate')} hint={t('ao.pay.hourlyHint')}><Input type="number" step="0.001" dir="ltr" value={v.hourlyRate} onChange={(e) => setV({ ...v, hourlyRate: e.target.value })} /></Field>}
        <Field label={t('ao.method')}><Select value={v.paymentMethod} onChange={(e) => setV({ ...v, paymentMethod: e.target.value })}>{['TRANSFER', 'CASH', 'CHEQUE'].map((m) => <option key={m} value={m}>{t(`ao.methods.${m}`)}</option>)}</Select></Field>
        <Field label={t('ao.pay.payFrom')}><TreasurySelect value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>
      </div>
      <p className="mt-3 text-sm font-semibold">{t('ao.pay.f.allowances')}</p>
      {al.map((a, i) => <div key={i} className="mt-1 flex gap-2"><Input placeholder={t('ao.pay.allowanceName')} value={a.name} onChange={(e) => setAl(al.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /><Input type="number" dir="ltr" className="w-32" value={a.amount} onChange={(e) => setAl(al.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /></div>)}
      <Button size="sm" variant="ghost" className="mt-1" onClick={() => setAl([...al, { name: '', amount: '' }])}>+ {t('ao.pay.addAllowance')}</Button>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />{t('ao.pay.inPayroll')}</label>
      <EmpPolicyForm value={pol} onChange={setPol} general={general} />
      <p className="mt-2 text-xs text-ink-muted">{t('ao.pay.ecoinNote')}</p>
    </Dialog>
  );
}

interface Adv { id: string; number: string; user: string; date: string; amount: string; installment: string; recovered: string; remaining: number; status: string }
function Advances() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['acc', 'advances'], queryFn: () => api.get<Adv[]>('/accounting/payroll/advances') });
  const profiles = useQuery({ queryKey: ['acc', 'payroll-profiles'], queryFn: () => api.get<Prof[]>('/accounting/payroll/profiles') });
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState({ userId: '', date: today(), amount: '', installment: '', treasuryId: '', notes: '' });
  const save = useApiMutation(() => api.post('/accounting/payroll/advances', { ...v, amount: Number(v.amount), installment: Number(v.installment), notes: v.notes || null }), { invalidate: [['acc']], onSuccess: () => setAdding(false) });
  const cancel = useApiMutation((id: string) => api.post(`/accounting/payroll/advances/${id}/cancel`, {}), { invalidate: [['acc']] });
  const manage = can('accounting.payroll.manage');
  return (
    <Card padded={false}>
      <CardHeader className="p-4" title={t('ao.pay.advances')} actions={manage && <Button icon={<HandCoins className="h-4 w-4" />} onClick={() => setAdding(true)}>{t('ao.pay.newAdvance')}</Button>} />
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} columns={[
        { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
        { key: 'u', header: t('ao.pay.employee'), cell: (r) => r.user },
        { key: 'd', header: t('ao.date'), cell: (r) => r.date },
        { key: 'a', header: t('acc.f.amount'), align: 'end', cell: (r) => <Money v={r.amount} /> },
        { key: 'i', header: t('ao.pay.installment'), align: 'end', cell: (r) => <Money v={r.installment} /> },
        { key: 'r', header: t('ao.pay.remaining'), align: 'end', cell: (r) => <b><Money v={r.remaining} /></b> },
        { key: 's', header: '', cell: (r) => r.status === 'CANCELLED' ? <Badge dot={false}>{t('ao.cancelled')}</Badge> : manage && Number(r.recovered) === 0 && <Button size="sm" variant="ghost" onClick={async () => (await confirm({ message: t('ao.cancelConfirm', { n: r.number }), danger: true })) && cancel.mutate(r.id)}>{t('ao.cancel')}</Button> },
      ]} />
      {adding && <Dialog open onClose={() => setAdding(false)} title={t('ao.pay.newAdvance')} footer={<><Button variant="outline" onClick={() => setAdding(false)}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('ao.pay.employee')} className="sm:col-span-2"><Select value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })}><option value="">—</option>{(profiles.data ?? []).map((p) => <option key={p.user.id} value={p.user.id}>{p.user.fullName}</option>)}</Select></Field>
          <Field label={t('ao.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
          <Field label={t('ao.pay.paidFrom')}><TreasurySelect value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>
          <Field label={t('acc.f.amount')}><Input type="number" step="0.001" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
          <Field label={t('ao.pay.installment')}><Input type="number" step="0.001" dir="ltr" value={v.installment} onChange={(e) => setV({ ...v, installment: e.target.value })} /></Field>
          <Field label={t('ao.notes')} className="sm:col-span-2"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        </div>
      </Dialog>}
    </Card>
  );
}

interface EmpPolicy { lateExempt?: boolean; graceMinutes?: number; dailyHours?: number; hourValue?: number; overtimeEligible?: boolean; overtimeMultiplier?: number; overtimeNeedsApproval?: boolean }

/** Exceptions for one employee; empty = the general setting (shown next to each field). */
function EmpPolicyForm({ value: v, onChange, general: g }: { value: EmpPolicy; onChange: (v: EmpPolicy) => void; general?: AttendancePolicy }) {
  const { t } = useTranslation();
  const e = (k: string) => t(`pol.emp.${k}`);
  const yn = (k: 'lateExempt' | 'overtimeEligible' | 'overtimeNeedsApproval', def?: boolean) => (
    <Field label={e(k)}>
      <Select value={v[k] === undefined ? '' : v[k] ? '1' : '0'} onChange={(x) => onChange({ ...v, [k]: x.target.value === '' ? undefined : x.target.value === '1' })}>
        <option value="">{e('general')}{def !== undefined ? ` (${def ? e('yes') : e('no')})` : ''}</option><option value="1">{e('yes')}</option><option value="0">{e('no')}</option>
      </Select>
    </Field>
  );
  const nf = (k: 'graceMinutes' | 'dailyHours' | 'hourValue' | 'overtimeMultiplier', def?: number, step = '1') => (
    <Field label={e(k)}><Input type="number" min={0} step={step} dir="ltr" placeholder={def !== undefined ? `${e('general')}: ${def}` : e('general')} value={v[k] ?? ''} onChange={(x) => onChange({ ...v, [k]: x.target.value === '' ? undefined : Number(x.target.value) })} /></Field>
  );
  return (
    <div className="mt-4 rounded-xl border border-line p-3">
      <p className="text-sm font-semibold">{e('title')}</p>
      <p className="mb-3 text-xs text-ink-muted">{e('hint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {yn('lateExempt', false)}
        {nf('graceMinutes', g?.graceMinutes)}
        {nf('dailyHours', g?.payroll.dailyHours, '0.5')}
        {nf('hourValue', undefined, '0.001')}
        {yn('overtimeEligible', true)}
        {nf('overtimeMultiplier', g?.overtime.multiplier, '0.05')}
        {yn('overtimeNeedsApproval', g?.overtime.needsApproval)}
      </div>
    </div>
  );
}
