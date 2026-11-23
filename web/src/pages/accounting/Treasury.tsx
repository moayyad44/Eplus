import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Banknote, Building2, Calculator, Pencil } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { amt0, monthStart, today } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Pagination, Select, Tabs, Textarea, useConfirm } from '@/components/ui';
import { AccountSelect, Money, TreasurySelect, useTreasuries, type Treasury } from './shared';

type Tab = 'list' | 'transfers' | 'counts';

export default function TreasuryPage() {
  const { t } = useTranslation();
  const { can, canAny } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'list';
  const items = [
    { key: 'list' as Tab, label: t('ao.tr.list') },
    ...(canAny('accounting.treasury.view', 'accounting.treasury.manage') ? [{ key: 'transfers' as Tab, label: t('ao.tr.transfers') }] : []),
    ...(canAny('accounting.cash.count', 'accounting.cash.approve', 'accounting.treasury.view') ? [{ key: 'counts' as Tab, label: t('ao.cc.title') }] : []),
  ];
  return (
    <div>
      <PageHeader title={t('ao.tr.title')} subtitle={t('ao.tr.subtitle')} />
      <Tabs items={items} value={tab} onChange={(k) => setSp({ tab: k })} className="mb-4" />
      {tab === 'list' && <List manage={can('accounting.treasury.manage')} />}
      {tab === 'transfers' && <Transfers manage={can('accounting.treasury.manage')} />}
      {tab === 'counts' && <Counts />}
    </div>
  );
}

function List({ manage }: { manage: boolean }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useTreasuries();
  const [edit, setEdit] = useState<Partial<Treasury> | null>(null);
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} />;
  const rows = q.data!;
  const sum = (k: 'CASH' | 'BANK') => rows.filter((r) => r.kind === k).reduce((s, r) => s + r.balance, 0);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Badge tone="success" dot={false}>{t('ao.tr.totalCash')}: {amt0(sum('CASH'))}</Badge>
        <Badge tone="primary" dot={false}>{t('ao.tr.totalBank')}: {amt0(sum('BANK'))}</Badge>
        {manage && <div className="ms-auto flex gap-2">
          <Button variant="outline" icon={<Banknote className="h-4 w-4" />} onClick={() => setEdit({ kind: 'CASH' })}>{t('ao.tr.newCash')}</Button>
          <Button icon={<Building2 className="h-4 w-4" />} onClick={() => setEdit({ kind: 'BANK' })}>{t('ao.tr.newBank')}</Button>
        </div>}
      </div>
      {!rows.length && <EmptyState title={t('ao.tr.empty')} />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <Card key={r.id} className={r.isActive ? '' : 'opacity-60'}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="flex items-center gap-2 font-bold">{r.kind === 'BANK' ? <Building2 className="h-4 w-4 text-primary-600" /> : <Banknote className="h-4 w-4 text-success-600" />}{r.name}</p>
                <p className="text-xs text-ink-muted">{r.kind === 'BANK' ? [r.bankName, r.accountNumber, r.iban].filter(Boolean).join(' · ') : r.custodian ? t('ao.tr.custodian', { n: r.custodian }) : t('ao.tr.cash')}</p>
                <p className="text-xs text-ink-muted" dir="ltr">{r.account?.code} {r.account?.name}</p>
              </div>
              {!r.isActive && <Badge dot={false}>{t('ao.stopped')}</Badge>}
            </div>
            <p className="my-3 text-2xl font-extrabold"><Money v={r.balance} /> <span className="text-xs font-semibold text-ink-muted">JOD</span></p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => nav(`/accounting/statement?accountId=${r.accountId}&from=${monthStart()}&to=${today()}`)}>{t('acc.accounts.statement')}</Button>
              {manage && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(r)}>{t('common.edit')}</Button>}
            </div>
          </Card>
        ))}
      </div>
      {edit && <TreasuryForm value={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TreasuryForm({ value, onClose }: { value: Partial<Treasury>; onClose: () => void }) {
  const { t } = useTranslation();
  const users = useQuery({ queryKey: ['users-lite'], queryFn: () => api.get<Paged<{ id: string; fullName: string }>>('/users', { pageSize: 200 }) });
  const [v, setV] = useState({ name: value.name ?? '', custodianId: value.custodianId ?? '', bankName: value.bankName ?? '', branch: value.branch ?? '', accountNumber: value.accountNumber ?? '', iban: value.iban ?? '', holderName: value.holderName ?? '', notes: value.notes ?? '', accountId: '', isActive: value.isActive ?? true });
  const bank = value.kind === 'BANK';
  const save = useApiMutation(() => {
    const body = { name: v.name, custodianId: v.custodianId || null, bankName: v.bankName || null, branch: v.branch || null, accountNumber: v.accountNumber || null, iban: v.iban || null, holderName: v.holderName || null, notes: v.notes || null };
    return value.id ? api.put(`/accounting/treasuries/${value.id}`, { ...body, isActive: v.isActive }) : api.post('/accounting/treasuries', { ...body, kind: value.kind, accountId: v.accountId || null });
  }, { invalidate: [['acc']], onSuccess: onClose });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <Dialog open onClose={onClose} title={value.id ? value.name : bank ? t('ao.tr.newBank') : t('ao.tr.newCash')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.tr.name')} required className="sm:col-span-2"><Input value={v.name} onChange={set('name')} /></Field>
        {bank ? <>
          <Field label={t('ao.tr.bankName')}><Input value={v.bankName} onChange={set('bankName')} /></Field>
          <Field label={t('ao.tr.branch')}><Input value={v.branch} onChange={set('branch')} /></Field>
          <Field label={t('ao.tr.accountNumber')}><Input dir="ltr" value={v.accountNumber} onChange={set('accountNumber')} /></Field>
          <Field label="IBAN"><Input dir="ltr" value={v.iban} onChange={set('iban')} /></Field>
          <Field label={t('ao.tr.holder')} className="sm:col-span-2"><Input value={v.holderName} onChange={set('holderName')} /></Field>
        </> : (
          <Field label={t('ao.tr.custodianLabel')} className="sm:col-span-2"><Select value={v.custodianId} onChange={set('custodianId')}><option value="">—</option>{(users.data?.items ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></Field>
        )}
        {!value.id && <Field label={t('ao.tr.account')} hint={t('ao.tr.accountHint')} className="sm:col-span-2"><AccountSelect value={v.accountId} onChange={(x) => setV({ ...v, accountId: x })} types={['ASSET']} placeholder={t('ao.tr.autoAccount')} /></Field>}
        <Field label={t('acc.f.description')} className="sm:col-span-2"><Textarea value={v.notes} onChange={set('notes')} rows={2} /></Field>
        {value.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />{t('ao.active')}</label>}
      </div>
    </Dialog>
  );
}

interface Transfer { id: string; number: string; date: string; from: string; to: string; amount: string; fee: string; reference: string | null; notes: string | null; status: string; cancelReason: string | null }
function Transfers({ manage }: { manage: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['acc', 'transfers', page], queryFn: () => api.get<Paged<Transfer>>('/accounting/transfers', { page }) });
  const cancel = useApiMutation((v: { id: string; reason: string }) => api.post(`/accounting/transfers/${v.id}/cancel`, { reason: v.reason }), { invalidate: [['acc']] });
  return (
    <Card padded={false}>
      <CardHeader className="p-4" title={t('ao.tr.transfers')} actions={manage && <Button icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setAdding(true)}>{t('ao.tr.newTransfer')}</Button>} />
      <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} columns={[
        { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
        { key: 'd', header: t('ao.date'), cell: (r) => r.date },
        { key: 'f', header: t('ao.tr.from'), cell: (r) => r.from },
        { key: 't', header: t('ao.tr.to'), cell: (r) => r.to },
        { key: 'a', header: t('acc.f.amount'), align: 'end', cell: (r) => <Money v={r.amount} /> },
        { key: 'fee', header: t('ao.fee'), align: 'end', hideOnMobile: true, cell: (r) => Number(r.fee) ? <Money v={r.fee} /> : '' },
        { key: 'r', header: t('acc.f.reference'), hideOnMobile: true, cell: (r) => r.reference },
        { key: 's', header: t('acc.f.status'), cell: (r) => r.status === 'CANCELLED' ? <Badge tone="neutral" dot={false} >{t('ao.cancelled')}</Badge> : <Badge tone="success" dot={false}>{t('ao.active')}</Badge> },
        { key: 'x', header: '', cell: (r) => manage && r.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={async () => { const reason = await confirm({ message: t('ao.cancelConfirm', { n: r.number }), danger: true, reason: { label: t('ao.reason'), required: false } }); if (reason !== false) cancel.mutate({ id: r.id, reason: reason || '' }); }}>{t('ao.cancel')}</Button> },
      ]} />
      {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={setPage} />}
      {adding && <TransferForm onClose={() => setAdding(false)} />}
    </Card>
  );
}

function TransferForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ date: today(), fromId: '', toId: '', amount: '', fee: '', reference: '', notes: '' });
  const save = useApiMutation(() => api.post('/accounting/transfers', { ...v, amount: Number(v.amount), fee: Number(v.fee || 0), reference: v.reference || null, notes: v.notes || null }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={t('ao.tr.newTransfer')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('acc.f.amount')}><Input type="number" step="0.001" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label={t('ao.tr.from')}><TreasurySelect value={v.fromId} onChange={(x) => setV({ ...v, fromId: x })} /></Field>
        <Field label={t('ao.tr.to')}><TreasurySelect value={v.toId} onChange={(x) => setV({ ...v, toId: x })} /></Field>
        <Field label={t('ao.fee')} hint={t('ao.tr.feeHint')}><Input type="number" step="0.001" dir="ltr" value={v.fee} onChange={(e) => setV({ ...v, fee: e.target.value })} /></Field>
        <Field label={t('acc.f.reference')}><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
        <Field label={t('ao.notes')} className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

const DENOMS = [50, 20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005];
interface Count { id: string; number: string; date: string; treasury: string; counted: string; book: string; difference: string; reason: string | null; isClose: boolean; status: string; countedBy: string | null; approvedBy: string | null; decisionNote: string | null; denominations: Record<string, number> }
function Counts() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['acc', 'cash-counts', page, status], queryFn: () => api.get<Paged<Count>>('/accounting/cash-counts', { page, status }) });
  const decide = useApiMutation((v: { id: string; approve: boolean; note: string }) => api.post(`/accounting/cash-counts/${v.id}/decide`, v), { invalidate: [['acc']] });
  const tone = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'neutral' } as const;
  return (
    <Card padded={false}>
      <CardHeader className="p-4" title={t('ao.cc.title')} subtitle={t('ao.cc.subtitle')} actions={<div className="flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!h-9 w-40"><option value="">{t('acc.f.all')}</option>{['PENDING', 'APPROVED', 'REJECTED'].map((s) => <option key={s} value={s}>{t(`ao.approval.${s}`)}</option>)}</Select>
        {can('accounting.cash.count') && <Button icon={<Calculator className="h-4 w-4" />} onClick={() => setAdding(true)}>{t('ao.cc.new')}</Button>}
      </div>} />
      <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} columns={[
        { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
        { key: 'd', header: t('ao.date'), cell: (r) => <>{r.date}{r.isClose && <Badge className="ms-1" dot={false}>{t('ao.cc.close')}</Badge>}</> },
        { key: 't', header: t('ao.treasury'), cell: (r) => r.treasury },
        { key: 'c', header: t('ao.cc.counted'), align: 'end', cell: (r) => <Money v={r.counted} /> },
        { key: 'b', header: t('ao.cc.book'), align: 'end', cell: (r) => <Money v={r.book} /> },
        { key: 'x', header: t('acc.f.difference'), align: 'end', cell: (r) => Number(r.difference) ? <b><Money v={r.difference} /></b> : '✓' },
        { key: 'r', header: t('ao.reason'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.reason}{r.decisionNote && <span className="block text-ink-muted">{r.decisionNote}</span>}</span> },
        { key: 'u', header: t('ao.cc.by'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.countedBy}{r.approvedBy && <span className="block text-ink-muted">✓ {r.approvedBy}</span>}</span> },
        { key: 's', header: t('acc.f.status'), cell: (r) => <Badge tone={tone[r.status as keyof typeof tone]} dot={false}>{t(`ao.approval.${r.status}`)}</Badge> },
        { key: 'a', header: '', cell: (r) => r.status === 'PENDING' && can('accounting.cash.approve') && <div className="flex gap-1">
          <Button size="sm" variant="success" onClick={async () => { const note = await confirm({ message: t('ao.cc.approveConfirm', { d: amt0(r.difference) }), reason: { label: t('ao.notes'), required: false } }); if (note !== false) decide.mutate({ id: r.id, approve: true, note: note || '' }); }}>{t('ao.approve')}</Button>
          <Button size="sm" variant="ghost" onClick={async () => { const note = await confirm({ message: t('ao.cc.rejectConfirm'), danger: true, reason: { label: t('ao.reason'), required: true } }); if (note) decide.mutate({ id: r.id, approve: false, note }); }}>{t('ao.reject')}</Button>
        </div> },
      ]} />
      {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={setPage} />}
      {adding && <CountForm onClose={() => setAdding(false)} />}
    </Card>
  );
}

function CountForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const ts = useTreasuries();
  const [treasuryId, setTreasuryId] = useState('');
  const [date, setDate] = useState(today());
  const [isClose, setIsClose] = useState(false);
  const [reason, setReason] = useState('');
  const [n, setN] = useState<Record<string, string>>({});
  const counted = DENOMS.reduce((s, d) => s + d * Number(n[d] || 0), 0);
  const book = ts.data?.find((x) => x.id === treasuryId)?.balance;
  const diff = book == null ? null : Math.round((counted - book) * 1000) / 1000;
  const save = useApiMutation(() => api.post('/accounting/cash-counts', { treasuryId, date, isClose, reason: reason || null, denominations: Object.fromEntries(DENOMS.map((d) => [String(d), Number(n[d] || 0)]).filter(([, c]) => c)) }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="lg" title={t('ao.cc.new')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button disabled={!treasuryId} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('ao.treasury')}><TreasurySelect kind="CASH" value={treasuryId} onChange={setTreasuryId} /></Field>
        <Field label={t('ao.date')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={isClose} onChange={(e) => setIsClose(e.target.checked)} />{t('ao.cc.isClose')}</label>
      </div>
      <table className="mt-3 w-full text-sm">
        <thead><tr className="border-b border-line text-xs text-ink-muted"><th className="p-1.5 text-start">{t('ao.cc.denom')}</th><th className="p-1.5">{t('ao.cc.qty')}</th><th className="p-1.5 text-end">{t('acc.f.total')}</th></tr></thead>
        <tbody>{DENOMS.map((d) => (
          <tr key={d} className="border-b border-line/60">
            <td className="p-1.5" dir="ltr">{d >= 1 ? `${d} JOD` : `${Math.round(d * 1000)} fils`}</td>
            <td className="p-1.5"><Input type="number" min={0} className="!h-8 w-28" dir="ltr" value={n[d] ?? ''} onChange={(e) => setN({ ...n, [d]: e.target.value })} /></td>
            <td className="p-1.5 text-end"><Money v={d * Number(n[d] || 0)} /></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="mt-3 flex flex-wrap gap-2">
        <Badge tone="primary" dot={false}>{t('ao.cc.counted')}: {amt0(counted)}</Badge>
        {book != null && <Badge dot={false}>{t('ao.cc.bookNow')}: {amt0(book)}</Badge>}
        {diff != null && <Badge tone={diff ? 'warning' : 'success'} dot={false}>{diff > 0 ? t('ao.cc.over') : diff < 0 ? t('ao.cc.short') : t('ao.cc.match')} {diff ? amt0(Math.abs(diff)) : ''}</Badge>}
      </div>
      <p className="mt-1 text-xs text-ink-muted">{t('ao.cc.bookHint')}</p>
      <Field label={t('ao.cc.reason')} className="mt-3"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}
