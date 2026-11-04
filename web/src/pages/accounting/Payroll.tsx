import { useState } from 'react';
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, HandCoins, Plus, Printer, RotateCcw, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { amt0, today } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, ErrorState, Field, Input, PageHeader, PageLoader, Select, Tabs, useConfirm } from '@/components/ui';
import { Money, ReportActions, TreasurySelect, exportXlsx } from './shared';

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

interface Slip { id: string; userId: string; user: string; jobTitle: string | null; basic: string; allowances: string; commission: string; bonus: string; overtime: string; absenceDays: string; lateMinutes: number; absenceDeduction: string; deductions: string; advance: string; net: string; notes: string | null }
interface Run extends RunRow { slips: Slip[]; entries: { id: string; number: string; sourceKey: string; status: string }[] }
const EDIT = ['commission', 'bonus', 'overtime', 'absenceDeduction', 'deductions', 'advance'] as const;

export function PayrollRun() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('accounting.payroll.manage');
  const q = useQuery({ queryKey: ['acc', 'payroll-run', id], queryFn: () => api.get<Run>(`/accounting/payroll/runs/${id}`) });
  const [edit, setEdit] = useState<Slip | null>(null);
  const [paying, setPaying] = useState(false);
  const [print, setPrint] = useState<Slip | null>(null);
  const act = useApiMutation((a: 'approve' | 'reopen') => api.post(`/accounting/payroll/runs/${id}/${a}`, {}), { invalidate: [['acc']] });
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} />;
  const r = q.data!;
  const sum = (k: keyof Slip) => r.slips.reduce((s, x) => s + Number(x[k]), 0);
  const cols = ['basic', 'allowances', 'commission', 'bonus', 'overtime', 'absenceDeduction', 'deductions', 'advance', 'net'] as const;
  const excel = () => exportXlsx(`${t('ao.pay.title')} ${r.month}`, [{ header: t('ao.pay.employee'), key: 'user' }, { header: t('ao.pay.job'), key: 'jobTitle' }, ...cols.map((c) => ({ header: t(`ao.pay.f.${c}`), key: c, money: true })), { header: t('ao.pay.f.absenceDays'), key: 'absenceDays' }],
    r.slips.map((s) => ({ ...s, ...Object.fromEntries(cols.map((c) => [c, Number(s[c])])), absenceDays: Number(s.absenceDays) })), [...cols]);
  if (print) return <Payslip run={r} slip={print} onBack={() => setPrint(null)} />;
  return (
    <div>
      <PageHeader title={`${t('ao.pay.title')} ${r.month}`} subtitle={<Badge tone={STATUS_TONE[r.status]} dot={false}>{t(`ao.pay.st.${r.status}`)}</Badge>} back={<Link to="/accounting/payroll" className="text-sm text-primary-700">{t('ao.pay.runs')}</Link>} actions={<ReportActions onExcel={excel} extra={manage && <>
        {r.status === 'DRAFT' && <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={async () => (await confirm({ message: t('ao.pay.approveConfirm', { t: amt0(sum('net')) }) })) && act.mutate('approve')}>{t('ao.approve')}</Button>}
        {r.status === 'APPROVED' && <><Button variant="outline" icon={<RotateCcw className="h-4 w-4" />} onClick={() => act.mutate('reopen')}>{t('ao.pay.reopen')}</Button><Button icon={<Wallet className="h-4 w-4" />} onClick={() => setPaying(true)}>{t('ao.pay.pay')}</Button></>}
      </>} />} />
      <p className="mb-3 text-xs text-ink-muted print:hidden">{t('ao.pay.runHint')}</p>
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead><tr className="border-b border-line bg-surface-subtle text-xs text-ink-muted"><th className="p-2 text-start">{t('ao.pay.employee')}</th>{cols.map((c) => <th key={c} className="p-2 text-end">{t(`ao.pay.f.${c}`)}</th>)}<th className="p-2 print:hidden" /></tr></thead>
            <tbody>{r.slips.map((s) => (
              <tr key={s.id} className="border-b border-line/60">
                <td className="p-2"><b>{s.user}</b><span className="block text-xs text-ink-muted">{s.jobTitle}{Number(s.absenceDays) > 0 && ` · ${t('ao.pay.absent', { n: Number(s.absenceDays) })}`}{s.lateMinutes > 0 && ` · ${t('ao.pay.late', { n: s.lateMinutes })}`}</span></td>
                {cols.map((c) => <td key={c} className={`p-2 text-end ${c === 'net' ? 'font-bold' : ''}`}><Money v={s[c]} /></td>)}
                <td className="p-2 print:hidden"><div className="flex gap-1">{manage && r.status === 'DRAFT' && <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>{t('common.edit')}</Button>}<Button size="sm" variant="ghost" icon={<Printer className="h-3.5 w-3.5" />} onClick={() => setPrint(s)}>{t('ao.pay.slip')}</Button></div></td>
              </tr>
            ))}</tbody>
            <tfoot><tr className="bg-surface-subtle font-bold"><td className="p-2">{t('acc.f.total')}</td>{cols.map((c) => <td key={c} className="p-2 text-end"><Money v={sum(c)} /></td>)}<td className="print:hidden" /></tr></tfoot>
          </table>
        </div>
      </Card>
      {r.entries.length > 0 && <p className="mt-3 text-sm print:hidden">{r.entries.map((e) => <Link key={e.id} className="me-3 text-primary-700" to={`/accounting/journal/${e.id}`}>{t('ao.v.entry', { n: e.number })}</Link>)}</p>}
      {edit && <SlipForm runId={r.id} slip={edit} onClose={() => setEdit(null)} />}
      {paying && <PayForm runId={r.id} total={sum('net')} onClose={() => setPaying(false)} />}
    </div>
  );
}

function SlipForm({ runId, slip, onClose }: { runId: string; slip: Slip; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries([...EDIT.map((k) => [k, String(Number(slip[k]))]), ['notes', slip.notes ?? '']]));
  const save = useApiMutation(() => api.put(`/accounting/payroll/runs/${runId}/slips/${slip.id}`, { ...Object.fromEntries(EDIT.map((k) => [k, Number(v[k] || 0)])), notes: v.notes || null }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={slip.user} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <p className="mb-3 text-sm text-ink-muted">{t('ao.pay.f.basic')}: {amt0(slip.basic)} · {t('ao.pay.f.allowances')}: {amt0(slip.allowances)}</p>
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
  const add = ['basic', 'allowances', 'commission', 'bonus', 'overtime'] as const, sub = ['absenceDeduction', 'deductions', 'advance'] as const;
  return (
    <div>
      <div className="mb-3 flex gap-2 print:hidden"><Button variant="outline" onClick={onBack}>{t('common.back')}</Button><Button icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button></div>
      <div className="mx-auto max-w-2xl rounded-2xl border border-line bg-white p-8 print:border-0 print:p-0">
        <div className="flex items-center justify-between border-b-2 border-primary-700 pb-3"><p className="text-xl font-extrabold text-primary-800">{clinic.data?.name}</p>{clinic.data?.hasLogo && <img src="/api/public/logo" alt="" className="h-14" />}</div>
        <p className="my-4 text-center text-lg font-bold">{t('ao.pay.slipTitle', { m: run.month })}</p>
        <p className="mb-4 text-sm">{t('ao.pay.employee')}: <b>{slip.user}</b>{slip.jobTitle && ` — ${slip.jobTitle}`}</p>
        <div className="grid grid-cols-2 gap-6 text-sm">
          <div><p className="mb-2 font-bold text-success-700">{t('ao.pay.earnings')}</p>{add.map((k) => Number(slip[k]) > 0 && <p key={k} className="flex justify-between border-b border-dotted border-line py-1"><span>{t(`ao.pay.f.${k}`)}</span><Money v={slip[k]} /></p>)}</div>
          <div><p className="mb-2 font-bold text-danger-700">{t('ao.pay.deductionsTitle')}</p>{sub.map((k) => Number(slip[k]) > 0 && <p key={k} className="flex justify-between border-b border-dotted border-line py-1"><span>{t(`ao.pay.f.${k}`)}</span><Money v={slip[k]} /></p>)}{Number(slip.absenceDays) > 0 && <p className="text-xs text-ink-muted">{t('ao.pay.absent', { n: Number(slip.absenceDays) })}</p>}</div>
        </div>
        <p className="mt-6 flex justify-between rounded-xl bg-primary-50 px-4 py-3 text-lg font-extrabold"><span>{t('ao.pay.f.net')}</span><span><Money v={slip.net} /> JOD</span></p>
        <div className="mt-12 grid grid-cols-2 gap-6 text-center text-sm">{[t('ao.pay.sigEmployee'), t('ao.v.sigManager')].map((s) => <div key={s}><div className="mb-1 h-10 border-b border-dashed border-line-strong" />{s}</div>)}</div>
      </div>
    </div>
  );
}

interface Prof { user: { id: string; fullName: string; staffType: string | null; role: { name: string } }; profile: { jobTitle: string | null; basic: string; allowances: { name: string; amount: number }[]; paymentMethod: string; treasuryId: string | null; isActive: boolean } | null }
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
        { key: 'b', header: t('ao.pay.f.basic'), align: 'end', cell: (r) => r.profile ? <Money v={r.profile.basic} /> : <span className="text-xs text-ink-muted">{t('ao.pay.noProfile')}</span> },
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
  const [v, setV] = useState({ jobTitle: p.profile?.jobTitle ?? '', basic: p.profile ? String(Number(p.profile.basic)) : '', paymentMethod: p.profile?.paymentMethod ?? 'TRANSFER', treasuryId: p.profile?.treasuryId ?? '', isActive: p.profile?.isActive ?? true });
  const [al, setAl] = useState<{ name: string; amount: string }[]>((p.profile?.allowances ?? []).map((a) => ({ name: a.name, amount: String(a.amount) })));
  const save = useApiMutation(() => api.put(`/accounting/payroll/profiles/${p.user.id}`, { ...v, jobTitle: v.jobTitle || null, basic: Number(v.basic || 0), treasuryId: v.treasuryId || null, allowances: al.filter((a) => a.name).map((a) => ({ name: a.name, amount: Number(a.amount || 0) })) }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={p.user.fullName} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.pay.job')}><Input value={v.jobTitle} onChange={(e) => setV({ ...v, jobTitle: e.target.value })} /></Field>
        <Field label={t('ao.pay.f.basic')}><Input type="number" step="0.001" dir="ltr" value={v.basic} onChange={(e) => setV({ ...v, basic: e.target.value })} /></Field>
        <Field label={t('ao.method')}><Select value={v.paymentMethod} onChange={(e) => setV({ ...v, paymentMethod: e.target.value })}>{['TRANSFER', 'CASH', 'CHEQUE'].map((m) => <option key={m} value={m}>{t(`ao.methods.${m}`)}</option>)}</Select></Field>
        <Field label={t('ao.pay.payFrom')}><TreasurySelect value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>
      </div>
      <p className="mt-3 text-sm font-semibold">{t('ao.pay.f.allowances')}</p>
      {al.map((a, i) => <div key={i} className="mt-1 flex gap-2"><Input placeholder={t('ao.pay.allowanceName')} value={a.name} onChange={(e) => setAl(al.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /><Input type="number" dir="ltr" className="w-32" value={a.amount} onChange={(e) => setAl(al.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /></div>)}
      <Button size="sm" variant="ghost" className="mt-1" onClick={() => setAl([...al, { name: '', amount: '' }])}>+ {t('ao.pay.addAllowance')}</Button>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />{t('ao.pay.inPayroll')}</label>
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
