import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, Coins, Download, Plus, Save, Trash2, Wallet } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { addDays, fmtDateTime, fmtDay, startOfWeek, ymd } from '@/lib/format';
import { useCatalog } from '@/lib/catalogs';
import { Badge, Button, Card, CardHeader, Checkbox, DataTable, DateRangePicker, Dialog, EmptyState, Field, IconButton, Input, PageHeader, PageLoader, Pagination, Select, StatCard, Tabs, Textarea, presetRange, useConfirm } from '@/components/ui';
import { BalancePill, CoinAmount } from '@/components/shared/ECoin';

type Tab = 'wallet' | 'wallets' | 'ops' | 'reports' | 'penalties' | 'settings';
const isoDay = (d: string | null | undefined) => (d ? `⁨${fmtDay(d.length === 10 ? `${d}T00:00:00Z` : d)}⁩` : '—');

export default function ECoinPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const [params, setParams] = useSearchParams();
  const doctor = me?.user.staffType === 'DOCTOR' && can('ecoin.use');
  const tabs: Tab[] = [
    ...(doctor ? (['wallet'] as const) : []),
    ...(can('ecoin.view_all') ? (['wallets', 'ops', 'reports', 'penalties'] as const) : []),
    ...(can('ecoin.manage') || can('ecoin.view_all') ? (['settings'] as const) : []),
  ];
  const tab = tabs.find((k) => k === params.get('tab')) ?? tabs[0];
  const userFilter = params.get('user') ?? undefined;
  return (
    <div>
      <PageHeader title={<span className="flex items-center gap-2"><Coins className="h-6 w-6 text-warning-600" />{t('ec.title')}</span>} subtitle={t('ec.subtitle')} />
      {tabs.length > 1 && <Tabs items={tabs.map((k) => ({ key: k, label: t(`ec.tabs.${k}`) }))} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} className="mb-4" />}
      {tab === 'wallet' && <MyWallet />}
      {tab === 'wallets' && <Wallets onOpen={(u) => setParams({ tab: 'ops', user: u }, { replace: true })} />}
      {tab === 'ops' && <Ledger all initialUser={userFilter} />}
      {tab === 'reports' && <Reports />}
      {tab === 'penalties' && <Penalties />}
      {tab === 'settings' && <SettingsTab />}
      {!tabs.length && <EmptyState title={t('ec.off')} />}
    </div>
  );
}

interface Summary {
  balance: number; earnedFromInvoices: number; spentOnPurchases: number; spentOnSecuring: number; expired: number; clawedBack: number; adjustments: number;
  expiringSoon: { id: string; remaining: number; expiresAt: string; earnedAt: string }[]; expiryWarnDays: number; enabled: boolean;
  penalty: { discount: number; usesLeft: number; usesTotal: number; windowStart: string; windowEnd: string } | null; penaltyWindowShifts: number;
}

function MyWallet() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['ecoin', 'me'], queryFn: () => api.get<Summary>('/ecoin/me') });
  if (q.isLoading || !q.data) return <PageLoader />;
  const s = q.data;
  return (
    <div className="space-y-4">
      {!s.enabled && <p className="rounded-2xl bg-warning-50 px-4 py-3 text-sm text-warning-800">{t('ec.off')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <BalancePill value={s.balance} label={t('ec.balance')} />
        <Link to="/staff/board" className="text-sm font-semibold text-primary-700 hover:underline">{t('sx.title')} ←</Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label={t('ec.earned')} value={s.earnedFromInvoices} tone="success" icon={<Coins className="h-5 w-5" />} />
        <StatCard label={t('ec.spentPurchases')} value={s.spentOnPurchases} tone="primary" icon={<Wallet className="h-5 w-5" />} />
        <StatCard label={t('ec.spentSecuring')} value={s.spentOnSecuring} tone="primary" icon={<Wallet className="h-5 w-5" />} />
        <StatCard label={t('ec.expired')} value={s.expired} tone="danger" icon={<Ban className="h-5 w-5" />} />
        <StatCard label={t('ec.clawedBack')} value={s.clawedBack} tone="warning" icon={<Ban className="h-5 w-5" />} hint={s.adjustments ? `${t('ec.adjustments')}: ${s.adjustments}` : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('ec.expiringSoon')} />
          {!s.expiringSoon.length ? <p className="text-sm text-ink-muted">{t('ec.noExpiring', { days: s.expiryWarnDays })}</p> : (
            <ul className="space-y-1.5 text-sm">
              {s.expiringSoon.map((l) => <li key={l.id} className="flex justify-between rounded-lg bg-warning-50 px-3 py-1.5 text-warning-800"><CoinAmount value={l.remaining} /><span>{t('ec.expiresOn', { date: isoDay(l.expiresAt) })}</span></li>)}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title={t('ec.penalty.title')} />
          {s.penalty ? (
            <p className="rounded-xl bg-warning-50 px-3 py-2 text-sm text-warning-800">
              {t('ec.penalty.active', { n: s.penaltyWindowShifts, d: s.penalty.discount, left: s.penalty.usesLeft, total: s.penalty.usesTotal })}
              <span className="mt-1 block text-xs">{t('ec.penalty.window', { from: isoDay(s.penalty.windowStart), to: isoDay(s.penalty.windowEnd) })}</span>
            </p>
          ) : <p className="text-sm text-ink-muted">{t('ec.penalty.none')}</p>}
        </Card>
      </div>
      <Ledger all={false} />
    </div>
  );
}

interface Txn {
  id: string; userId: string; user: string | null; type: string; amount: number; balanceBefore: number; balanceAfter: number; createdAt: string; reason: string | null; by: string | null;
  invoiceId: string | null; invoiceNumber: string | null; slot: { id: string; name: string; date: string; startTime: string; endTime: string } | null;
  lot: { earnedAt: string; expiresAt: string } | null; reversedBy: string | null; reversalOfId: string | null;
}
const TYPES = ['EARN', 'EXPIRE', 'PURCHASE', 'SECURE', 'ADJUST', 'CLAWBACK', 'REVERSAL'];

function Ledger({ all, initialUser }: { all: boolean; initialUser?: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const doctors = useDoctors(all);
  const list = usePagedList<Txn, { userId?: string; type?: string; from?: string; to?: string }>(all ? 'ecoin-ops' : 'ecoin-mine', '/ecoin/transactions', { filters: { userId: initialUser } });
  const [rev, setRev] = useState<Txn | null>(null);
  return (
    <Card>
      <CardHeader title={t('ec.ledger')} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {all && (
          <Select value={list.filters.userId ?? ''} onChange={(e) => list.setFilters({ userId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('ec.filters.allDoctors')}</option>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
        )}
        <Select value={list.filters.type ?? ''} onChange={(e) => list.setFilters({ type: e.target.value || undefined })} className="w-auto">
          <option value="">{t('ec.filters.all')}</option>
          {TYPES.map((x) => <option key={x} value={x}>{t(`ec.type.${x}`)}</option>)}
        </Select>
        <DateRangePicker value={{ from: list.filters.from ?? '', to: list.filters.to ?? '' }} onChange={(r) => list.setFilters(r)} />
      </div>
      <DataTable rows={list.data?.items} loading={list.query.isFetching} error={list.query.error} rowKey={(r) => r.id} dense
        empty={<p className="py-4 text-center text-sm text-ink-muted">{t('common.noData')}</p>}
        columns={[
          { key: 'd', header: t('ec.col.date'), cell: (r) => <bdi className="text-xs">{fmtDateTime(r.createdAt)}</bdi> },
          ...(all ? [{ key: 'u', header: t('ec.col.doctor'), cell: (r: Txn) => <b className="text-xs">{r.user}</b> }] : []),
          { key: 't', header: t('ec.col.type'), cell: (r) => <Badge dot={false} tone={r.amount > 0 ? 'success' : r.type === 'EXPIRE' ? 'danger' : 'neutral'}>{t(`ec.type.${r.type}`)}</Badge> },
          { key: 'a', header: t('ec.col.amount'), cell: (r) => <span className={clsx('font-bold tabular-nums', r.amount > 0 ? 'text-success-700' : r.amount < 0 ? 'text-danger-700' : '')} dir="ltr">{r.amount > 0 ? '+' : ''}{r.amount}</span> },
          { key: 'b', header: `${t('ec.col.before')} → ${t('ec.col.after')}`, cell: (r) => <span className="tabular-nums text-xs" dir="ltr">{r.balanceBefore} → {r.balanceAfter}</span> },
          {
            key: 's', header: t('ec.col.source'), cell: (r) => (
              <span className="text-xs">
                {r.invoiceNumber && <Link to={`/billing/invoices/${r.invoiceId}`} className="font-mono font-semibold text-primary-700 hover:underline">{t('ec.invoice', { n: r.invoiceNumber })}</Link>}
                {r.slot && <span className="block">{r.slot.name} {isoDay(r.slot.date)} <span dir="ltr">{r.slot.startTime}–{r.slot.endTime}</span></span>}
                {r.type === 'EARN' && r.lot && <span className="block text-ink-muted">{t('ec.expiresOn', { date: isoDay(r.lot.expiresAt) })}</span>}
              </span>
            ),
          },
          { key: 'r', header: t('ec.col.reason'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.reason}{r.by && <span className="block text-ink-muted">{t('ec.col.by')}: {r.by}</span>}{r.reversedBy && <Badge dot={false} tone="violet" className="mt-1">{t('ec.reversed')}</Badge>}</span> },
          ...(all && can('ecoin.manage') ? [{ key: 'x', header: '', cell: (r: Txn) => !r.reversedBy && ['PURCHASE', 'SECURE', 'ADJUST', 'EARN'].includes(r.type) && <Button size="sm" variant="ghost" onClick={() => setRev(r)}>{t('ec.reverse.btn')}</Button> }] : []),
        ]} />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      {rev && <ReverseDialog txn={rev} onClose={() => setRev(null)} />}
    </Card>
  );
}

function ReverseDialog({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const m = useApiMutation(() => api.post(`/ecoin/transactions/${txn.id}/reverse`, { reason }), { invalidate: [['ecoin-ops'], ['ecoin'], ['board']], success: t('ec.reverse.done'), onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={t('ec.reverse.title')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('ec.reverse.btn')}</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="rounded-xl bg-warning-50 px-3 py-2 text-xs text-warning-800">{t('ec.reverse.hint')}</p>
        <p><b>{t(`ec.type.${txn.type}`)}</b> · {txn.user} · <span dir="ltr">{txn.amount > 0 ? '+' : ''}{txn.amount}</span> · {txn.reason}</p>
        <Field label={t('ec.reverse.reason')} required error={m.fieldErrors.reason}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

const useDoctors = (enabled = true) => useQuery({ queryKey: ['ecoin', 'wallets'], queryFn: () => api.get<WalletRow[]>('/ecoin/wallets'), enabled });
interface WalletRow { id: string; fullName: string; isActive: boolean; balance: number; earned: number; spentPurchases: number; spentSecuring: number; expired: number; adjustments: number; clawedBack: number; penalty: { discount: number; usesLeft: number } | null }

function Wallets({ onOpen }: { onOpen: (userId: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useDoctors();
  const [adj, setAdj] = useState<WalletRow | null>(null);
  return (
    <Card>
      <DataTable rows={q.data} loading={q.isFetching} error={q.error} rowKey={(r) => r.id}
        columns={[
          { key: 'n', header: t('ec.col.doctor'), cell: (r) => <button type="button" className="font-semibold text-primary-700 hover:underline" onClick={() => onOpen(r.id)}>{r.fullName}</button> },
          { key: 'b', header: t('ec.balance'), cell: (r) => <CoinAmount value={r.balance} className="text-base" /> },
          { key: 'e', header: t('ec.earned'), cell: (r) => r.earned },
          { key: 's', header: t('ec.spentPurchases'), hideOnMobile: true, cell: (r) => r.spentPurchases },
          { key: 'c', header: t('ec.spentSecuring'), hideOnMobile: true, cell: (r) => r.spentSecuring },
          { key: 'x', header: t('ec.expired'), hideOnMobile: true, cell: (r) => r.expired },
          { key: 'p', header: t('ec.penalty.title'), cell: (r) => (r.penalty ? <Badge tone="warning" dot={false}>−{r.penalty.discount} · {r.penalty.usesLeft}</Badge> : '—') },
          ...(can('ecoin.adjust') ? [{ key: 'a', header: '', cell: (r: WalletRow) => <Button size="sm" variant="outline" onClick={() => setAdj(r)}>{t('ec.adjust.btn')}</Button> }] : []),
        ]} />
      {adj && <AdjustDialog row={adj} onClose={() => setAdj(null)} />}
    </Card>
  );
}

function AdjustDialog({ row, onClose }: { row: WalletRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ amount: '', reason: '' });
  const m = useApiMutation(() => api.post('/ecoin/adjust', { userId: row.id, amount: Number(v.amount), reason: v.reason }), { invalidate: [['ecoin'], ['ecoin-ops']], success: t('ec.adjust.done'), onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={t('ec.adjust.title', { name: row.fullName })} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button disabled={!Number(v.amount) || v.reason.trim().length < 5} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm">{t('ec.balance')}: <CoinAmount value={row.balance} /></p>
        <Field label={t('ec.adjust.amount')} required error={m.fieldErrors.amount}><Input type="number" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label={t('ec.adjust.reason')} required error={m.fieldErrors.reason}><Textarea rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

interface ReportRow { id: string; name: string; balance: number; earned: number; spent: number; expired: number; bought: number; lost: number; secured: number; released: number; swaps: number; coverRequests: number; lateMinutes: number; extendedMinutes: number; penalties: number }
function Reports() {
  const { t } = useTranslation();
  const [range, setRange] = useState(presetRange('month'));
  const [userId, setUserId] = useState('');
  const doctors = useDoctors();
  const q = useQuery({ queryKey: ['ecoin', 'reports', range, userId], queryFn: () => api.get<{ rows: ReportRow[]; totals: Record<string, number> }>('/ecoin/reports', { ...range, userId: userId || undefined }) });
  const cols: { k: keyof ReportRow; l: string }[] = [
    { k: 'balance', l: t('ec.report.balance') }, { k: 'earned', l: t('ec.report.earned') }, { k: 'spent', l: t('ec.report.spent') }, { k: 'expired', l: t('ec.report.expired') },
    { k: 'bought', l: t('ec.report.bought') }, { k: 'lost', l: t('ec.report.lost') }, { k: 'secured', l: t('ec.report.secured') }, { k: 'released', l: t('ec.report.released') },
    { k: 'swaps', l: t('ec.report.swaps') }, { k: 'coverRequests', l: t('ec.report.coverRequests') }, { k: 'lateMinutes', l: t('ec.report.late') }, { k: 'extendedMinutes', l: t('ec.report.extended') }, { k: 'penalties', l: t('ec.report.penalties') },
  ];
  const tot = q.data?.totals;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker value={range} onChange={setRange} />
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-auto">
            <option value="">{t('ec.filters.allDoctors')}</option>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
          <Button className="ms-auto" variant="outline" icon={<Download className="h-4 w-4" />} disabled={!q.data} onClick={() => exportCsv(`ecoin-${range.from}-${range.to}.csv`, [{ header: t('ec.col.doctor'), value: (r: ReportRow) => r.name }, ...cols.map((c) => ({ header: c.l, value: (r: ReportRow) => r[c.k] }))], q.data!.rows)}>CSV</Button>
        </div>
      </Card>
      {tot && (
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {(['earned', 'spent', 'expired', 'purchases', 'secured', 'releases', 'swaps', 'coverRequests', 'handovers', 'penalties'] as const).map((k) => (
            <StatCard key={k} label={t(`ec.report.${k === 'releases' ? 'released' : k === 'handovers' ? 'handovers' : k}`)} value={tot[k] ?? 0} tone={k === 'expired' ? 'danger' : 'primary'} />
          ))}
        </div>
      )}
      <Card>
        <DataTable rows={q.data?.rows} loading={q.isFetching} rowKey={(r) => r.id} dense
          columns={[{ key: 'n', header: t('ec.col.doctor'), cell: (r) => <b>{r.name}</b> }, ...cols.map((c) => ({ key: c.k, header: c.l, cell: (r: ReportRow) => <span className="tabular-nums">{r[c.k]}</span> }))]} />
      </Card>
    </div>
  );
}

interface PenaltyRow { id: string; user: string; status: string; discount: number; usesLeft: number; usesTotal: number; coinsEarned: number; windowStart: string; windowEnd: string; triggeredAt: string; windowShifts: { date: string; start: string; end: string }[] }
function Penalties() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['ecoin', 'penalties'], queryFn: () => api.get<PenaltyRow[]>('/ecoin/penalties') });
  return (
    <Card>
      <DataTable rows={q.data} loading={q.isFetching} rowKey={(r) => r.id}
        empty={<p className="py-4 text-center text-sm text-ink-muted">{t('common.noData')}</p>}
        columns={[
          { key: 'u', header: t('ec.col.doctor'), cell: (r) => <b>{r.user}</b> },
          { key: 's', header: t('common.status'), cell: (r) => <Badge tone={r.status === 'ACTIVE' ? 'warning' : 'neutral'} dot={false}>{t(`ec.penalty.status.${r.status}`)}</Badge> },
          { key: 'd', header: t('ec.s.penaltyDiscount'), cell: (r) => <CoinAmount value={r.discount} /> },
          { key: 'l', header: t('ec.penalty.uses'), cell: (r) => `${r.usesLeft} / ${r.usesTotal}` },
          { key: 'c', header: t('ec.penalty.coins'), cell: (r) => r.coinsEarned },
          { key: 'w', header: t('ec.col.source'), cell: (r) => <span className="text-xs">{r.windowShifts.map((w) => `${w.date} ${w.start}–${w.end}`).join(' · ')}</span> },
          { key: 't', header: t('ec.col.date'), hideOnMobile: true, cell: (r) => <bdi className="text-xs">{fmtDateTime(r.triggeredAt)}</bdi> },
        ]} />
    </Card>
  );
}

// ── Settings & prices ──

interface Cfg {
  enabled: boolean; coinsPerLabInvoice: number; expiryDays: number; expiryWarnDays: number; securePrice: number; durationPrices: { hours: number; price: number }[]; otherPrice: number;
  purchaseLeadMinutes: number; penaltyEnabled: boolean; penaltyWindowShifts: number; penaltyMinCoins: number; penaltyDiscount: number; penaltyUses: number;
}
interface Ex { swapEnabled: boolean; releaseEnabled: boolean; coverEnabled: boolean; changeLeadMinutes: number; minCoverMinutes: number; maxCoverMinutes: number }

function SettingsTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const edit = can('ecoin.manage');
  const q = useQuery({ queryKey: ['ecoin', 'settings'], queryFn: () => api.get<Cfg>('/ecoin/settings') });
  const exq = useQuery({ queryKey: ['shifts', 'exchange-settings'], queryFn: () => api.get<Ex>('/shifts/settings/exchange') });
  const [v, setV] = useState<Cfg | null>(null);
  const [x, setX] = useState<Ex | null>(null);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  useEffect(() => { if (exq.data) setX(exq.data); }, [exq.data]);
  const save = useApiMutation(() => api.put('/ecoin/settings', v!), { invalidate: [['ecoin'], ['board']], success: t('ec.s.saved') });
  const saveEx = useApiMutation(() => api.put('/shifts/settings/exchange', x!), { invalidate: [['shifts'], ['board']], success: t('ec.s.saved') });
  if (!v || !x) return <PageLoader />;
  const num = (k: keyof Cfg) => (e: { target: { value: string } }) => setV({ ...v, [k]: Number(e.target.value) });
  const exNum = (k: keyof Ex) => (e: { target: { value: string } }) => setX({ ...x, [k]: Number(e.target.value) });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('ec.s.coin')} />
          <fieldset disabled={!edit} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Checkbox label={<b>{t('ec.s.enabled')}</b>} checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /></div>
            <Field label={t('ec.s.coinsPerLabInvoice')}><Input type="number" min={0} value={v.coinsPerLabInvoice} onChange={num('coinsPerLabInvoice')} /></Field>
            <Field label={t('ec.s.expiryDays')}><Input type="number" min={1} value={v.expiryDays} onChange={num('expiryDays')} /></Field>
            <Field label={t('ec.s.expiryWarnDays')}><Input type="number" min={0} value={v.expiryWarnDays} onChange={num('expiryWarnDays')} /></Field>
            <Field label={t('ec.s.securePrice')}><Input type="number" min={0} value={v.securePrice} onChange={num('securePrice')} /></Field>
            <Field label={t('ec.s.purchaseLeadMinutes')}><Input type="number" min={0} value={v.purchaseLeadMinutes} onChange={num('purchaseLeadMinutes')} /></Field>
          </fieldset>
          <CardHeader title={t('ec.s.prices')} className="mt-5" />
          <fieldset disabled={!edit} className="space-y-2">
            {v.durationPrices.map((d, i) => (
              <div key={i} className="flex items-end gap-2">
                <Field label={t('ec.s.hours')} className="flex-1"><Input type="number" min={0.5} step={0.5} value={d.hours} onChange={(e) => setV({ ...v, durationPrices: v.durationPrices.map((y, j) => (j === i ? { ...y, hours: Number(e.target.value) } : y)) })} /></Field>
                <Field label={t('ec.s.price')} className="flex-1"><Input type="number" min={0} value={d.price} onChange={(e) => setV({ ...v, durationPrices: v.durationPrices.map((y, j) => (j === i ? { ...y, price: Number(e.target.value) } : y)) })} /></Field>
                <IconButton label={t('common.delete')} onClick={() => setV({ ...v, durationPrices: v.durationPrices.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setV({ ...v, durationPrices: [...v.durationPrices, { hours: 6, price: 2 }] })}>{t('ec.s.addDuration')}</Button>
            <Field label={t('ec.s.otherPrice')}><Input type="number" min={0} value={v.otherPrice} onChange={num('otherPrice')} /></Field>
          </fieldset>
        </Card>
        <Card>
          <CardHeader title={t('ec.s.incentive')} />
          <fieldset disabled={!edit} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Checkbox label={<b>{t('ec.s.penaltyEnabled')}</b>} checked={v.penaltyEnabled} onChange={(e) => setV({ ...v, penaltyEnabled: e.target.checked })} /></div>
            <Field label={t('ec.s.penaltyWindowShifts')}><Input type="number" min={1} value={v.penaltyWindowShifts} onChange={num('penaltyWindowShifts')} /></Field>
            <Field label={t('ec.s.penaltyMinCoins')}><Input type="number" min={1} value={v.penaltyMinCoins} onChange={num('penaltyMinCoins')} /></Field>
            <Field label={t('ec.s.penaltyDiscount')}><Input type="number" min={0} value={v.penaltyDiscount} onChange={num('penaltyDiscount')} /></Field>
            <Field label={t('ec.s.penaltyUses')}><Input type="number" min={1} value={v.penaltyUses} onChange={num('penaltyUses')} /></Field>
          </fieldset>
          {edit && <Button className="mt-4" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button>}
          <CardHeader title={t('ec.s.exchange')} className="mt-6" />
          <fieldset disabled={!can('shifts.manage')} className="grid gap-3 sm:grid-cols-2">
            <Checkbox label={t('ec.s.swapEnabled')} checked={x.swapEnabled} onChange={(e) => setX({ ...x, swapEnabled: e.target.checked })} />
            <Checkbox label={t('ec.s.releaseEnabled')} checked={x.releaseEnabled} onChange={(e) => setX({ ...x, releaseEnabled: e.target.checked })} />
            <Checkbox label={t('ec.s.coverEnabled')} checked={x.coverEnabled} onChange={(e) => setX({ ...x, coverEnabled: e.target.checked })} />
            <Field label={t('ec.s.changeLeadMinutes')}><Input type="number" min={0} value={x.changeLeadMinutes} onChange={exNum('changeLeadMinutes')} /></Field>
            <Field label={t('ec.s.minCoverMinutes')}><Input type="number" min={5} value={x.minCoverMinutes} onChange={exNum('minCoverMinutes')} /></Field>
            <Field label={t('ec.s.maxCoverMinutes')}><Input type="number" min={5} value={x.maxCoverMinutes} onChange={exNum('maxCoverMinutes')} /></Field>
          </fieldset>
          <p className="mt-2 text-xs text-ink-muted">{t('ec.s.permsHint')}</p>
          {can('shifts.manage') && <Button className="mt-3" icon={<Save className="h-4 w-4" />} loading={saveEx.isPending} onClick={() => saveEx.mutate(undefined)}>{t('common.save')}</Button>}
        </Card>
      </div>
      <PriceRules edit={edit} />
      <PricePreview />
    </div>
  );
}

interface Rule { id: string; shiftId: string; weekday: number | null; date: string | null; price: number; shift?: { name: string; startTime: string; endTime: string } }
function PriceRules({ edit }: { edit: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const shifts = useCatalog<{ id: string; name: string; startTime: string; endTime: string; isActive?: boolean }>('shifts');
  const q = useQuery({ queryKey: ['ecoin', 'rules'], queryFn: () => api.get<Rule[]>('/ecoin/price-rules') });
  const [v, setV] = useState({ shiftId: '', on: 'weekday' as 'weekday' | 'date', weekday: '5', date: '', price: '3' });
  const inv = [['ecoin'], ['board']];
  const add = useApiMutation(() => api.post('/ecoin/price-rules', { shiftId: v.shiftId, price: Number(v.price), ...(v.on === 'weekday' ? { weekday: Number(v.weekday) } : { date: v.date }) }), { invalidate: inv, success: t('ec.s.saved') });
  const upd = useApiMutation((r: { id: string; price: number }) => api.put(`/ecoin/price-rules/${r.id}`, { price: r.price }), { invalidate: inv, success: t('ec.s.saved') });
  const del = useApiMutation((rid: string) => api.del(`/ecoin/price-rules/${rid}`), { invalidate: inv, success: t('common.done') });
  const dayNames = t('staff.dayNames', { returnObjects: true }) as string[];
  return (
    <Card>
      <CardHeader title={t('ec.s.rules')} subtitle={t('ec.s.rulesHint')} />
      {edit && (
        <div className="mb-4 grid items-end gap-3 rounded-2xl bg-surface-subtle p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t('ec.s.shift')} required error={add.fieldErrors.shiftId}>
            <Select value={v.shiftId} onChange={(e) => setV({ ...v, shiftId: e.target.value })} placeholder={t('common.select')}>
              {(shifts.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
            </Select>
          </Field>
          <Field label={t('ec.s.on')}>
            <Select value={v.on} onChange={(e) => setV({ ...v, on: e.target.value as 'weekday' | 'date' })}>
              <option value="weekday">{t('ec.s.weekday')}</option>
              <option value="date">{t('ec.s.date')}</option>
            </Select>
          </Field>
          {v.on === 'weekday'
            ? <Field label={t('ec.s.weekday')}><Select value={v.weekday} onChange={(e) => setV({ ...v, weekday: e.target.value })}>{dayNames.map((n, i) => <option key={i} value={i}>{n}</option>)}</Select></Field>
            : <Field label={t('ec.s.date')} error={add.fieldErrors.date}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>}
          <Field label={t('ec.s.price')}><Input type="number" min={0} value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} /></Field>
          <Button icon={<Plus className="h-4 w-4" />} disabled={!v.shiftId || (v.on === 'date' && !v.date)} loading={add.isPending} onClick={() => add.mutate(undefined)}>{t('ec.s.addRule')}</Button>
        </div>
      )}
      <DataTable rows={q.data} loading={q.isFetching} rowKey={(r) => r.id} dense empty={<p className="py-3 text-center text-sm text-ink-muted">{t('common.noData')}</p>}
        columns={[
          { key: 's', header: t('ec.s.shift'), cell: (r) => <b>{r.shift?.name}</b> },
          { key: 'o', header: t('ec.s.on'), cell: (r) => (r.date ? isoDay(r.date) : t('ec.s.every', { day: dayNames[r.weekday ?? 0] })) },
          { key: 'p', header: t('ec.s.price'), cell: (r) => (edit ? <Input type="number" min={0} defaultValue={r.price} className="!h-8 w-20" onBlur={(e) => Number(e.target.value) !== r.price && upd.mutate({ id: r.id, price: Number(e.target.value) })} /> : <CoinAmount value={r.price} />) },
          ...(edit ? [{ key: 'x', header: '', cell: (r: Rule) => <IconButton size="sm" label={t('common.delete')} onClick={async () => (await confirm({ message: `${r.shift?.name}`, danger: true })) && del.mutate(r.id)}><Trash2 className="h-4 w-4" /></IconButton> }] : []),
        ]} />
    </Card>
  );
}

function PricePreview() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(ymd(startOfWeek(new Date())));
  const to = ymd(addDays(new Date(`${from}T12:00:00`), 6));
  const q = useQuery({ queryKey: ['ecoin', 'prices', from], queryFn: () => api.get<{ id: string; date: string; shift: string; startTime: string; endTime: string; hours: number; holder: string | null; price: number; source: string }[]>('/ecoin/prices', { from, to }) });
  return (
    <Card>
      <CardHeader title={t('ec.s.preview')} actions={<Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="!h-9 w-40" />} />
      <DataTable rows={q.data} loading={q.isFetching} rowKey={(r) => r.id} dense empty={<p className="py-3 text-center text-sm text-ink-muted">{t('common.noData')}</p>}
        columns={[
          { key: 'd', header: t('common.date'), cell: (r) => isoDay(r.date) },
          { key: 's', header: t('ec.s.shift'), cell: (r) => <span>{r.shift} <span dir="ltr" className="text-xs text-ink-muted">{r.startTime}–{r.endTime}</span></span> },
          { key: 'h', header: t('ec.s.hours'), cell: (r) => Math.round(r.hours * 100) / 100 },
          { key: 'u', header: t('sx.holder'), cell: (r) => r.holder ?? t('sx.vacant') },
          { key: 'p', header: t('ec.s.price'), cell: (r) => <CoinAmount value={r.price} /> },
          { key: 'o', header: t('ec.col.source'), cell: (r) => <Badge dot={false}>{t(`ec.s.source.${r.source}`)}</Badge> },
        ]} />
    </Card>
  );
}
