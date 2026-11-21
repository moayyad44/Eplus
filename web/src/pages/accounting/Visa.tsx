import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { CreditCard, FileSearch, Flag, Upload } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { amt0, today } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, PageHeader, Pagination, SearchInput, Select, StatCard, Tabs, useConfirm } from '@/components/ui';
import { Money, ReportActions, TreasurySelect, exportXlsx } from './shared';

interface Txn { id: string; date: string; amount: string; settled: string; remaining: number; posReference: string | null; terminal: string | null; invoiceNumber: string | null; patientName: string | null; recordedBy: string | null; status: string; notes: string | null; ageDays: number; late: boolean; sourceType: string; lines: { amount: string; settlement: { id: string; number: string; date: string; status: string } }[] }
interface Summary { notReached: number; notReachedCount: number; late: number; lateCount: number; lateDays: number; reached: number; settledGross: number; fees: number; settlements: number; review: number; cancelledOrRefunded: number }
const TONE: Record<string, 'warning' | 'primary' | 'success' | 'neutral' | 'danger'> = { PENDING: 'warning', PARTIAL: 'primary', SETTLED: 'success', CANCELLED: 'neutral', REFUNDED: 'neutral', REVIEW: 'danger' };
type Tab = 'open' | 'all' | 'settlements' | 'match';

export default function Visa() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'open';
  const s = useQuery({ queryKey: ['acc', 'visa-summary'], queryFn: () => api.get<Summary>('/accounting/visa/summary') });
  const manage = can('accounting.visa.manage');
  return (
    <div>
      <PageHeader title={t('ao.visa.title')} subtitle={t('ao.visa.subtitle')} />
      {s.data && <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label={t('ao.visa.notReached')} value={amt0(s.data.notReached)} hint={t('ao.visa.ops', { n: s.data.notReachedCount })} tone="warning" />
        <StatCard label={t('ao.visa.late', { d: s.data.lateDays })} value={amt0(s.data.late)} hint={t('ao.visa.ops', { n: s.data.lateCount })} tone="danger" onClick={() => setSp({ tab: 'open', late: 'true' })} />
        <StatCard label={t('ao.visa.reached')} value={amt0(s.data.reached)} hint={t('ao.visa.settlementsN', { n: s.data.settlements })} tone="success" />
        <StatCard label={t('ao.visa.fees')} value={amt0(s.data.fees)} tone="violet" />
        <StatCard label={t('ao.visa.review')} value={String(s.data.review)} tone="neutral" />
      </div>}
      <Tabs className="mb-4" value={tab} onChange={(k) => setSp({ tab: k })} items={[
        { key: 'open' as Tab, label: t('ao.visa.tabOpen') }, { key: 'all' as Tab, label: t('ao.visa.tabAll') }, { key: 'settlements' as Tab, label: t('ao.visa.tabSettlements') },
        ...(manage ? [{ key: 'match' as Tab, label: t('ao.visa.tabMatch') }] : []),
      ]} />
      {(tab === 'open' || tab === 'all') && <Transactions open={tab === 'open'} late={sp.get('late') === 'true'} manage={manage} />}
      {tab === 'settlements' && <Settlements manage={manage} />}
      {tab === 'match' && <Match />}
    </div>
  );
}

function Transactions({ open, late, manage }: { open: boolean; late: boolean; manage: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [f, setF] = useState({ q: '', from: '', to: '', status: '', page: 1 });
  const [pick, setPick] = useState<Record<string, number>>({});
  const [settling, setSettling] = useState(false);
  const params = { ...f, status: open ? 'PENDING,PARTIAL' : f.status, late: late && open ? 'true' : undefined, pageSize: open ? 200 : 30 };
  const q = useQuery({ queryKey: ['acc', 'visa', params], queryFn: () => api.get<Paged<Txn> & { totalAmount: string }>('/accounting/visa/transactions', params) });
  const review = useApiMutation((v: { id: string; review: boolean; note: string }) => api.post(`/accounting/visa/transactions/${v.id}/review`, v), { invalidate: [['acc']] });
  const chosen = Object.entries(pick).filter(([, a]) => a > 0);
  const gross = chosen.reduce((s, [, a]) => s + a, 0);
  const excel = () => exportXlsx(t('ao.visa.title'), [{ header: t('ao.date'), key: 'd' }, { header: t('ao.visa.ref'), key: 'posReference' }, { header: t('ao.visa.invoice'), key: 'invoiceNumber' }, { header: t('ao.visa.patient'), key: 'patientName' }, { header: t('acc.f.amount'), key: 'a', money: true }, { header: t('ao.visa.remaining'), key: 'remaining', money: true }, { header: t('acc.f.status'), key: 's' }],
    (q.data?.items ?? []).map((x) => ({ ...x, d: x.date.slice(0, 10), a: Number(x.amount), s: t(`ao.visa.st.${x.status}`) })), ['a', 'remaining']);
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-2 p-4 print:hidden">
        <SearchInput value={f.q} onChange={(x) => setF({ ...f, q: x, page: 1 })} placeholder={t('ao.visa.search')} className="w-56" />
        {!open && <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} className="!h-10 w-36"><option value="">{t('acc.f.all')}</option>{Object.keys(TONE).map((s) => <option key={s} value={s}>{t(`ao.visa.st.${s}`)}</option>)}</Select>}
        <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="w-40" />
        <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-40" />
        {late && open && <Badge tone="danger" dot={false}>{t('ao.visa.lateOnly')}</Badge>}
        <div className="ms-auto flex gap-2">
          <ReportActions onExcel={excel} />
          {open && manage && <Button icon={<CreditCard className="h-4 w-4" />} disabled={!chosen.length} onClick={() => setSettling(true)}>{t('ao.visa.settle')} {chosen.length ? `(${chosen.length} — ${amt0(gross)})` : ''}</Button>}
        </div>
      </div>
      {open && manage && <p className="px-4 pb-2 text-xs text-ink-muted print:hidden">{t('ao.visa.pickHint')}</p>}
      <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} rowClassName={(r) => clsx(r.late && 'bg-danger-50/50')} columns={[
        ...(open && manage ? [{ key: 'p', header: '', cell: (r: Txn) => <input type="checkbox" checked={!!pick[r.id]} onChange={(e) => setPick({ ...pick, [r.id]: e.target.checked ? r.remaining : 0 })} /> }] : []),
        { key: 'd', header: t('ao.date'), cell: (r) => <>{new Date(r.date).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}<span className="block text-xs text-ink-muted">{t('ao.visa.age', { n: r.ageDays })}</span></> },
        { key: 'r', header: t('ao.visa.ref'), cell: (r) => <span dir="ltr" className="font-mono text-xs">{r.posReference ?? '—'}</span> },
        { key: 'i', header: t('ao.visa.invoice'), cell: (r) => <>{r.invoiceNumber}<span className="block text-xs text-ink-muted">{r.patientName}</span></> },
        { key: 'a', header: t('acc.f.amount'), align: 'end', cell: (r) => <Money v={r.amount} /> },
        { key: 'm', header: t('ao.visa.remaining'), align: 'end', cell: (r) => open && manage && pick[r.id] ? <Input type="number" step="0.001" dir="ltr" className="!h-8 w-28" value={pick[r.id]} onChange={(e) => setPick({ ...pick, [r.id]: Math.min(r.remaining, Number(e.target.value)) })} /> : <Money v={r.remaining} /> },
        { key: 's', header: t('acc.f.status'), cell: (r) => <><Badge tone={TONE[r.status]} dot={false}>{t(`ao.visa.st.${r.status}`)}</Badge>{r.late && <Badge tone="danger" dot={false} className="ms-1">{t('ao.visa.lateBadge')}</Badge>}{r.lines.map((l) => <span key={l.settlement.id} className="block text-xs text-ink-muted">{l.settlement.number}: {amt0(l.amount)}</span>)}</> },
        { key: 'u', header: t('ao.visa.by'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.recordedBy}{r.notes && <span className="block text-warning-700">{r.notes}</span>}</span> },
        ...(manage ? [{ key: 'x', header: '', cell: (r: Txn) => ['PENDING', 'PARTIAL', 'REVIEW'].includes(r.status) && <Button size="sm" variant="ghost" icon={<Flag className="h-3.5 w-3.5" />} onClick={async () => { const note = await confirm({ message: r.status === 'REVIEW' ? t('ao.visa.unreview') : t('ao.visa.markReview'), reason: { label: t('ao.notes'), required: r.status !== 'REVIEW' } }); if (note !== false) review.mutate({ id: r.id, review: r.status !== 'REVIEW', note: note || '' }); }}>{r.status === 'REVIEW' ? t('ao.visa.endReview') : t('ao.visa.flag')}</Button> }] : []),
      ]} />
      {q.data && !open && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
      {settling && <SettleForm lines={chosen.map(([transactionId, amount]) => ({ transactionId, amount }))} gross={gross} onClose={(done) => { setSettling(false); if (done) setPick({}); }} />}
    </Card>
  );
}

function SettleForm({ lines, gross, onClose }: { lines: { transactionId: string; amount: number }[]; gross: number; onClose: (done?: boolean) => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ date: today(), treasuryId: '', fee: '', reference: '', notes: '', net: '' });
  const fee = v.net !== '' ? Math.round((gross - Number(v.net)) * 1000) / 1000 : Number(v.fee || 0);
  const save = useApiMutation(() => api.post('/accounting/visa/settlements', { date: v.date, treasuryId: v.treasuryId, fee, reference: v.reference || null, notes: v.notes || null, lines }), { invalidate: [['acc']], onSuccess: () => onClose(true) });
  return (
    <Dialog open onClose={() => onClose()} title={t('ao.visa.settle')} footer={<><Button variant="outline" onClick={() => onClose()}>{t('common.cancel')}</Button><Button disabled={!v.treasuryId} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.visa.gross')}><Input disabled dir="ltr" value={amt0(gross)} /></Field>
        <Field label={t('ao.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('ao.visa.bank')} className="sm:col-span-2"><TreasurySelect kind="BANK" value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>
        <Field label={t('ao.visa.netReceived')} hint={t('ao.visa.netHint')}><Input type="number" step="0.001" dir="ltr" value={v.net} onChange={(e) => setV({ ...v, net: e.target.value })} /></Field>
        <Field label={t('ao.fee')}><Input type="number" step="0.001" dir="ltr" value={v.net !== '' ? String(fee) : v.fee} disabled={v.net !== ''} onChange={(e) => setV({ ...v, fee: e.target.value })} /></Field>
        <Field label={t('acc.f.reference')}><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
        <Field label={t('ao.notes')}><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
      <p className="mt-3 rounded-xl bg-surface-subtle px-3 py-2 text-sm">{t('ao.visa.entryPreview', { net: amt0(gross - fee), fee: amt0(fee), gross: amt0(gross) })}</p>
    </Dialog>
  );
}

interface Settlement { id: string; number: string; date: string; treasury: string; gross: string; fee: string; net: string; reference: string | null; notes: string | null; status: string; _count: { lines: number } }
function Settlements({ manage }: { manage: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['acc', 'visa-settlements', page], queryFn: () => api.get<Paged<Settlement>>('/accounting/visa/settlements', { page }) });
  const cancel = useApiMutation((v: { id: string; reason: string }) => api.post(`/accounting/visa/settlements/${v.id}/cancel`, { reason: v.reason }), { invalidate: [['acc']] });
  return (
    <Card padded={false}>
      <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} rowClassName={(r) => clsx(r.status === 'CANCELLED' && 'opacity-50')} columns={[
        { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
        { key: 'd', header: t('ao.date'), cell: (r) => r.date },
        { key: 'b', header: t('ao.visa.bank'), cell: (r) => r.treasury },
        { key: 'c', header: t('ao.visa.count'), align: 'center', cell: (r) => r._count.lines },
        { key: 'g', header: t('ao.visa.gross'), align: 'end', cell: (r) => <Money v={r.gross} /> },
        { key: 'f', header: t('ao.fee'), align: 'end', cell: (r) => <Money v={r.fee} /> },
        { key: 'net', header: t('ao.visa.net'), align: 'end', cell: (r) => <b><Money v={r.net} /></b> },
        { key: 'r', header: t('acc.f.reference'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.reference}{r.notes && <span className="block text-ink-muted">{r.notes}</span>}</span> },
        { key: 'x', header: '', cell: (r) => manage && r.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={async () => { const reason = await confirm({ message: t('ao.cancelConfirm', { n: r.number }), danger: true, reason: { label: t('ao.reason'), required: false } }); if (reason !== false) cancel.mutate({ id: r.id, reason: reason || '' }); }}>{t('ao.cancel')}</Button> },
      ]} />
      {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={setPage} />}
    </Card>
  );
}

interface MatchRow { line: number; date: string; amount: number | null; reference: string | null; fee: number; match: string; status: 'MATCHED' | 'AMOUNT_DIFFERS' | 'NOT_IN_SYSTEM'; difference: number | null; transaction: { posReference: string | null; amount: number; remaining: number; invoiceNumber: string | null; patientName: string | null } | null }
interface MatchRes { rows: MatchRow[]; missingFromStatement: { id: string; date: string; amount: number; remaining: number; posReference: string | null; invoiceNumber: string | null; patientName: string | null }[]; totals: { lines: number; matched: number; differs: number; notInSystem: number; fees: number } }
function Match() {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const run = useApiMutation(() => { const fd = new FormData(); fd.append('file', file!); return api.upload<MatchRes>('/accounting/visa/match', fd); }, { success: false });
  const r = run.data;
  const tone = useMemo(() => ({ MATCHED: 'success', AMOUNT_DIFFERS: 'warning', NOT_IN_SYSTEM: 'danger' }) as const, []);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('ao.visa.matchTitle')} subtitle={t('ao.visa.matchHint')} icon={<FileSearch className="h-5 w-5" />} />
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('acc.opening.file')}><Input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Button icon={<Upload className="h-4 w-4" />} disabled={!file} loading={run.isPending} onClick={() => run.mutate(undefined)}>{t('ao.visa.compare')}</Button>
        </div>
      </Card>
      {r && <>
        <div className="flex flex-wrap gap-2">
          <Badge tone="success" dot={false}>{t('ao.visa.m.MATCHED')}: {r.totals.matched}</Badge>
          <Badge tone="warning" dot={false}>{t('ao.visa.m.AMOUNT_DIFFERS')}: {r.totals.differs}</Badge>
          <Badge tone="danger" dot={false}>{t('ao.visa.m.NOT_IN_SYSTEM')}: {r.totals.notInSystem}</Badge>
          <Badge dot={false}>{t('ao.visa.m.missing')}: {r.missingFromStatement.length}</Badge>
          {r.totals.fees > 0 && <Badge tone="violet" dot={false}>{t('ao.fee')}: {amt0(r.totals.fees)}</Badge>}
        </div>
        <Card padded={false}>
          <DataTable rows={r.rows} rowKey={(x) => String(x.line)} columns={[
            { key: 'l', header: '#', cell: (x) => x.line },
            { key: 'd', header: t('ao.date'), cell: (x) => x.date },
            { key: 'r', header: t('ao.visa.ref'), cell: (x) => <span dir="ltr" className="font-mono text-xs">{x.reference}</span> },
            { key: 'a', header: t('ao.visa.statementAmount'), align: 'end', cell: (x) => <Money v={x.amount} /> },
            { key: 't', header: t('ao.visa.inSystem'), cell: (x) => x.transaction ? <span className="text-xs">{x.transaction.invoiceNumber} · {x.transaction.patientName} · <Money v={x.transaction.remaining} /></span> : '—' },
            { key: 's', header: t('acc.f.status'), cell: (x) => <><Badge tone={tone[x.status]} dot={false}>{t(`ao.visa.m.${x.status}`)}</Badge>{x.difference ? <span className="ms-1 text-xs"><Money v={x.difference} /></span> : null}</> },
          ]} />
        </Card>
        {!!r.missingFromStatement.length && <Card padded={false}>
          <CardHeader className="p-4" title={t('ao.visa.m.missing')} subtitle={t('ao.visa.m.missingHint')} />
          <DataTable rows={r.missingFromStatement} rowKey={(x) => x.id} columns={[
            { key: 'd', header: t('ao.date'), cell: (x) => String(x.date).slice(0, 10) },
            { key: 'r', header: t('ao.visa.ref'), cell: (x) => <span dir="ltr" className="font-mono text-xs">{x.posReference}</span> },
            { key: 'i', header: t('ao.visa.invoice'), cell: (x) => `${x.invoiceNumber ?? ''} ${x.patientName ?? ''}` },
            { key: 'a', header: t('ao.visa.remaining'), align: 'end', cell: (x) => <Money v={x.remaining} /> },
          ]} />
        </Card>}
        <p className="text-xs text-ink-muted">{t('ao.visa.m.next')} <Link className="text-primary-700" to="/accounting/visa?tab=open">{t('ao.visa.tabOpen')}</Link></p>
      </>}
    </div>
  );
}
