import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ClipboardCheck, Landmark } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { amt0, today } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, PageHeader, PageLoader, Pagination, SearchInput, Select, Tabs, Textarea } from '@/components/ui';
import { Money, ReportActions, TreasurySelect, exportXlsx } from './shared';

interface Cheque { id: string; ref: string; direction: 'IN' | 'OUT'; number: string; bankName: string; drawer: string; counterparty: string; dueDate: string; issueDate: string | null; amount: string; status: string; reason: string | null; treasuryId: string | null; fees: string; next: string[] }
const TONE: Record<string, 'warning' | 'primary' | 'success' | 'neutral' | 'danger' | 'violet'> = {
  RECEIVED: 'warning', IN_SAFE: 'warning', READY: 'primary', DEPOSITED: 'primary', UNDER_COLLECTION: 'violet', COLLECTED: 'success', BOUNCED: 'danger', CANCELLED: 'neutral', REPLACED: 'neutral', RETURNED_TO_OWNER: 'neutral',
  DRAFT: 'neutral', ISSUED: 'warning', DELIVERED: 'primary', DUE: 'violet', CLEARED: 'success', STOPPED: 'danger',
};
type Tab = 'IN' | 'OUT' | 'deposits' | 'counts';

export default function Cheques() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || (sp.get('alert') ? 'IN' : 'IN');
  return (
    <div>
      <PageHeader title={t('ao.ch.title')} subtitle={t('ao.ch.subtitle')} />
      <Tabs className="mb-4" value={tab} onChange={(k) => setSp({ tab: k })} items={[
        { key: 'IN' as Tab, label: t('ao.ch.in') }, { key: 'OUT' as Tab, label: t('ao.ch.out') }, { key: 'deposits' as Tab, label: t('ao.ch.deposits') }, { key: 'counts' as Tab, label: t('ao.ch.counts') },
      ]} />
      {(tab === 'IN' || tab === 'OUT') && <List dir={tab} alert={sp.get('alert') ?? ''} />}
      {tab === 'deposits' && <Deposits />}
      {tab === 'counts' && <Counts />}
    </div>
  );
}

function List({ dir, alert }: { dir: 'IN' | 'OUT'; alert: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('accounting.cheques.manage');
  const [f, setF] = useState({ q: '', status: '', dueFrom: '', dueTo: '', alert, page: 1 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [move, setMove] = useState<{ c: Cheque; to: string } | null>(null);
  const [depositing, setDepositing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['acc', 'cheques', dir, f], queryFn: () => api.get<Paged<Cheque> & { totalAmount: string }>('/accounting/cheques', { ...f, direction: dir, pageSize: 50 }) });
  const rows = q.data?.items ?? [];
  const selRows = rows.filter((r) => sel.has(r.id));
  const excel = () => exportXlsx(dir === 'IN' ? t('ao.ch.in') : t('ao.ch.out'), [{ header: t('ao.ch.ref'), key: 'ref' }, { header: t('ao.ch.number'), key: 'number' }, { header: t('ao.ch.bank'), key: 'bankName' }, { header: dir === 'IN' ? t('ao.ch.drawer') : t('ao.ch.payee'), key: 'counterparty' }, { header: t('ao.ch.dueDate'), key: 'dueDate' }, { header: t('acc.f.amount'), key: 'a', money: true }, { header: t('acc.f.status'), key: 's' }],
    rows.map((r) => ({ ...r, a: Number(r.amount), s: t(`ao.ch.st.${r.status}`) })), ['a']);
  const late = (r: Cheque) => r.dueDate < today() && (['RECEIVED', 'IN_SAFE', 'READY', 'ISSUED', 'DELIVERED', 'DUE'] as string[]).includes(r.status);
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-2 p-4 print:hidden">
        <SearchInput value={f.q} onChange={(x) => setF({ ...f, q: x, page: 1 })} placeholder={t('ao.ch.search')} className="w-56" />
        <Select value={f.alert} onChange={(e) => setF({ ...f, alert: e.target.value, page: 1 })} className="!h-10 w-44"><option value="">{t('ao.ch.anyAlert')}</option>{['due', 'overdue', 'collecting', 'bounced'].map((a) => <option key={a} value={a}>{t(`ao.ch.alert.${a}`)}</option>)}</Select>
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} className="!h-10 w-40"><option value="">{t('acc.f.all')}</option>{Object.keys(TONE).filter((s) => (dir === 'IN') === !['DRAFT', 'ISSUED', 'DELIVERED', 'DUE', 'CLEARED', 'STOPPED'].includes(s) || s === 'BOUNCED' || s === 'CANCELLED' || s === 'REPLACED').map((s) => <option key={s} value={s}>{t(`ao.ch.st.${s}`)}</option>)}</Select>
        <Field label={t('ao.ch.dueFrom')}><Input type="date" value={f.dueFrom} onChange={(e) => setF({ ...f, dueFrom: e.target.value })} className="w-40" /></Field>
        <Field label={t('ao.ch.dueTo')}><Input type="date" value={f.dueTo} onChange={(e) => setF({ ...f, dueTo: e.target.value })} className="w-40" /></Field>
        <div className="ms-auto flex flex-wrap gap-2">
          {q.data && <Badge tone="primary" dot={false}>{t('acc.f.total')}: {amt0(q.data.totalAmount)}</Badge>}
          <ReportActions onExcel={excel} />
          {dir === 'IN' && manage && <Button icon={<Landmark className="h-4 w-4" />} disabled={!selRows.length} onClick={() => setDepositing(true)}>{t('ao.ch.deposit')} {selRows.length ? `(${selRows.length})` : ''}</Button>}
        </div>
      </div>
      <p className="px-4 pb-2 text-xs text-ink-muted print:hidden">{dir === 'IN' ? t('ao.ch.inHint') : t('ao.ch.outHint')} <Link className="text-primary-700" to={`/accounting/vouchers/new?kind=${dir === 'IN' ? 'RECEIPT' : 'PAYMENT'}`}>{dir === 'IN' ? t('ao.v.newReceipt') : t('ao.v.newPayment')}</Link></p>
      <DataTable rows={rows} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} rowClassName={(r) => clsx(late(r) && 'bg-danger-50/50', r.status === 'BOUNCED' && 'bg-danger-50')} columns={[
        ...(dir === 'IN' && manage ? [{ key: 'sel', header: '', cell: (r: Cheque) => ['RECEIVED', 'IN_SAFE', 'READY'].includes(r.status) && <input type="checkbox" checked={sel.has(r.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(r.id) : s.delete(r.id); setSel(s); }} /> }] : []),
        { key: 'n', header: t('ao.ch.number'), cell: (r) => <button type="button" className="text-start" onClick={() => setOpen(r.id)}><b dir="ltr">{r.number}</b><span className="block text-xs text-ink-muted">{r.bankName}</span></button> },
        { key: 'p', header: dir === 'IN' ? t('ao.ch.drawer') : t('ao.ch.payee'), cell: (r) => <>{r.counterparty}{r.reason && <span className="block text-xs text-ink-muted">{r.reason}</span>}</> },
        { key: 'd', header: t('ao.ch.dueDate'), cell: (r) => <span className={clsx(late(r) && 'font-bold text-danger-700')}>{r.dueDate}</span> },
        { key: 'a', header: t('acc.f.amount'), align: 'end', cell: (r) => <Money v={r.amount} /> },
        { key: 's', header: t('acc.f.status'), cell: (r) => <Badge tone={TONE[r.status]} dot={false}>{t(`ao.ch.st.${r.status}`)}</Badge> },
        ...(manage ? [{ key: 'x', header: '', cell: (r: Cheque) => r.next.length > 0 && <Select className="!h-8 w-36 text-xs" value="" onChange={(e) => e.target.value && setMove({ c: r, to: e.target.value })}><option value="">{t('ao.ch.changeStatus')}</option>{r.next.map((s) => <option key={s} value={s}>{t(`ao.ch.st.${s}`)}</option>)}</Select> }] : []),
      ]} />
      {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
      {move && <MoveForm c={move.c} to={move.to} onClose={() => setMove(null)} />}
      {depositing && <DepositForm cheques={selRows} onClose={(ok) => { setDepositing(false); if (ok) setSel(new Set()); }} />}
      {open && <ChequeDetail id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function MoveForm({ c, to, onClose }: { c: Cheque; to: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ date: today(), treasuryId: c.treasuryId ?? '', fee: '', note: '' });
  const needBank = to === 'COLLECTED' || to === 'CLEARED' || to === 'BOUNCED';
  const needNote = ['BOUNCED', 'CANCELLED', 'STOPPED', 'RETURNED_TO_OWNER'].includes(to);
  const save = useApiMutation(() => api.post(`/accounting/cheques/${c.id}/status`, { to, date: v.date, treasuryId: v.treasuryId || null, fee: Number(v.fee || 0), note: v.note || null }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={`${t('ao.ch.number')} ${c.number} → ${t(`ao.ch.st.${to}`)}`} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button variant={to === 'BOUNCED' ? 'danger' : 'primary'} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">{t(`ao.ch.effect.${to}`, { defaultValue: '' })}</p>
        <Field label={t('ao.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        {needBank && <Field label={t('ao.ch.bankAccount')}><TreasurySelect kind="BANK" value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>}
        {to === 'BOUNCED' && <Field label={t('ao.ch.bounceFee')}><Input type="number" step="0.001" dir="ltr" value={v.fee} onChange={(e) => setV({ ...v, fee: e.target.value })} /></Field>}
        <Field label={needNote ? t('ao.reason') : t('ao.notes')} required={needNote}><Textarea rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function DepositForm({ cheques, onClose }: { cheques: Cheque[]; onClose: (ok?: boolean) => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ date: today(), treasuryId: '', slipNumber: '', reference: '', notes: '' });
  const total = cheques.reduce((s, c) => s + Number(c.amount), 0);
  const save = useApiMutation(() => api.post('/accounting/cheques/deposits', { ...v, chequeIds: cheques.map((c) => c.id), slipNumber: v.slipNumber || null, reference: v.reference || null, notes: v.notes || null }), { invalidate: [['acc']], onSuccess: () => onClose(true) });
  return (
    <Dialog open onClose={() => onClose()} title={t('ao.ch.deposit')} footer={<><Button variant="outline" onClick={() => onClose()}>{t('common.cancel')}</Button><Button disabled={!v.treasuryId} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <p className="mb-3 text-sm">{t('ao.ch.depositSummary', { n: cheques.length, t: amt0(total) })}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('ao.ch.bankAccount')}><TreasurySelect kind="BANK" value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>
        <Field label={t('ao.ch.slip')}><Input value={v.slipNumber} onChange={(e) => setV({ ...v, slipNumber: e.target.value })} /></Field>
        <Field label={t('acc.f.reference')}><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
      </div>
      <p className="mt-3 rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800">{t('ao.ch.depositHint')}</p>
    </Dialog>
  );
}

interface Detail extends Cheque { voucher: { id: string; number: string } | null; notes: string | null; events: { id: string; fromStatus: string | null; toStatus: string; date: string; fee: string; note: string | null; user: string | null; createdAt: string; entry: { id: string; number: string; status: string } | null }[] }
function ChequeDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['acc', 'cheque', id], queryFn: () => api.get<Detail>(`/accounting/cheques/${id}`) });
  const c = q.data;
  return (
    <Dialog open onClose={onClose} size="lg" title={c ? `${t('ao.ch.number')} ${c.number} — ${c.bankName}` : '…'}>
      {!c ? <PageLoader /> : <>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <p>{t('ao.ch.ref')}: <b dir="ltr">{c.ref}</b></p><p>{t('acc.f.amount')}: <b><Money v={c.amount} /></b></p>
          <p>{c.direction === 'IN' ? t('ao.ch.drawer') : t('ao.ch.payee')}: <b>{c.counterparty}</b></p><p>{t('ao.ch.dueDate')}: <b>{c.dueDate}</b></p>
          <p>{t('acc.f.status')}: <Badge tone={TONE[c.status]} dot={false}>{t(`ao.ch.st.${c.status}`)}</Badge></p>
          {c.voucher && <p>{t('ao.ch.voucher')}: <Link className="text-primary-700" to={`/accounting/vouchers/${c.voucher.id}`}>{c.voucher.number}</Link></p>}
          {Number(c.fees) > 0 && <p>{t('ao.ch.bounceFee')}: <Money v={c.fees} /></p>}
        </div>
        <ol className="mt-4 space-y-2 border-s-2 border-primary-100 ps-4 text-sm">{c.events.map((e) => (
          <li key={e.id}>
            <p><b>{e.fromStatus ? `${t(`ao.ch.st.${e.fromStatus}`)} ← ` : ''}{t(`ao.ch.st.${e.toStatus}`)}</b> · {e.date} · {e.user}</p>
            {e.note && <p className="text-xs text-ink-muted">{e.note}</p>}
            {e.entry && <Link className="text-xs text-primary-700" to={`/accounting/journal/${e.entry.id}`}>{t('ao.v.entry', { n: e.entry.number })}</Link>}
          </li>
        ))}</ol>
      </>}
    </Dialog>
  );
}

interface Dep { id: string; number: string; date: string; treasury: string; slipNumber: string | null; total: string; cheques: { id: string; number: string; amount: string; status: string; drawer: string }[] }
function Deposits() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['acc', 'cheque-deposits', page], queryFn: () => api.get<Paged<Dep>>('/accounting/cheques-deposits', { page }) });
  return (
    <Card padded={false}>
      <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} columns={[
        { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
        { key: 'd', header: t('ao.date'), cell: (r) => r.date },
        { key: 'b', header: t('ao.ch.bankAccount'), cell: (r) => <>{r.treasury}{r.slipNumber && <span className="block text-xs text-ink-muted">{t('ao.ch.slip')}: {r.slipNumber}</span>}</> },
        { key: 'c', header: t('ao.ch.title'), cell: (r) => <ul className="text-xs">{r.cheques.map((c) => <li key={c.id}>{c.number} · {c.drawer} · <Money v={c.amount} /> · {t(`ao.ch.st.${c.status}`)}</li>)}</ul> },
        { key: 't', header: t('acc.f.total'), align: 'end', cell: (r) => <b><Money v={r.total} /></b> },
      ]} />
      {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={setPage} />}
    </Card>
  );
}

interface CCount { id: string; number: string; date: string; status: string; countedBy: string | null; approvedBy: string | null; lines: { number: string; bankName: string; amount: number; result: string; note: string | null }[]; extra: { number: string; amount: number }[]; notes: string | null }
function Counts() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['acc', 'cheque-counts', page], queryFn: () => api.get<Paged<CCount>>('/accounting/cheque-counts', { page }) });
  const approve = useApiMutation((id: string) => api.post(`/accounting/cheque-counts/${id}/approve`, {}), { invalidate: [['acc']] });
  return (
    <Card padded={false}>
      <CardHeader className="p-4" title={t('ao.ch.counts')} subtitle={t('ao.ch.countsHint')} actions={can('accounting.cheques.manage') && <Button icon={<ClipboardCheck className="h-4 w-4" />} onClick={() => setAdding(true)}>{t('ao.ch.newCount')}</Button>} />
      <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} columns={[
        { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
        { key: 'd', header: t('ao.date'), cell: (r) => r.date },
        { key: 'r', header: t('ao.ch.result'), cell: (r) => { const miss = r.lines.filter((l) => l.result === 'MISSING'); return <span className="text-xs">{t('ao.ch.found', { n: r.lines.length - miss.length })}{miss.length > 0 && <b className="block text-danger-700">{t('ao.ch.missing', { n: miss.length })}: {miss.map((m) => m.number).join('، ')}</b>}{r.extra.length > 0 && <b className="block text-warning-700">{t('ao.ch.extra', { n: r.extra.length })}</b>}</span>; } },
        { key: 'u', header: t('ao.cc.by'), cell: (r) => <span className="text-xs">{r.countedBy}{r.approvedBy && <span className="block">✓ {r.approvedBy}</span>}</span> },
        { key: 's', header: t('acc.f.status'), cell: (r) => <Badge tone={r.status === 'APPROVED' ? 'success' : 'warning'} dot={false}>{t(`ao.approval.${r.status}`)}</Badge> },
        { key: 'x', header: '', cell: (r) => r.status === 'PENDING' && can('accounting.cash.approve') && <Button size="sm" onClick={() => approve.mutate(r.id)}>{t('ao.approve')}</Button> },
      ]} />
      {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={setPage} />}
      {adding && <CountForm onClose={() => setAdding(false)} />}
    </Card>
  );
}

function CountForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const exp = useQuery({ queryKey: ['acc', 'cheque-expected'], queryFn: () => api.get<Cheque[]>('/accounting/cheque-counts/expected') });
  const [res, setRes] = useState<Record<string, 'FOUND' | 'MISSING'>>({});
  const [notes, setNotes] = useState('');
  const [extra, setExtra] = useState<{ number: string; bankName: string; amount: string }[]>([]);
  const all = exp.data ?? [];
  const save = useApiMutation(() => api.post('/accounting/cheque-counts', { date: today(), notes: notes || null, lines: all.map((c) => ({ chequeId: c.id, result: res[c.id] ?? 'FOUND', note: null })), extra: extra.filter((e) => e.number).map((e) => ({ number: e.number, bankName: e.bankName || null, amount: Number(e.amount || 0), note: null })) }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="lg" title={t('ao.ch.newCount')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      {exp.isLoading ? <PageLoader /> : <>
        <p className="mb-2 text-sm">{t('ao.ch.expected', { n: all.length, t: amt0(all.reduce((s, c) => s + Number(c.amount), 0)) })}</p>
        <table className="w-full text-sm"><tbody>{all.map((c) => (
          <tr key={c.id} className={clsx('border-b border-line/60', res[c.id] === 'MISSING' && 'bg-danger-50')}>
            <td className="p-1.5"><b dir="ltr">{c.number}</b> <span className="text-xs text-ink-muted">{c.bankName} · {c.drawer}</span></td>
            <td className="p-1.5"><Money v={c.amount} /></td><td className="p-1.5 text-xs">{c.dueDate}</td>
            <td className="p-1.5"><Select className="!h-8 w-28 text-xs" value={res[c.id] ?? 'FOUND'} onChange={(e) => setRes({ ...res, [c.id]: e.target.value as 'FOUND' })}><option value="FOUND">{t('ao.ch.isFound')}</option><option value="MISSING">{t('ao.ch.isMissing')}</option></Select></td>
          </tr>
        ))}</tbody></table>
        <p className="mt-3 text-sm font-semibold">{t('ao.ch.extraTitle')}</p>
        {extra.map((e, i) => <div key={i} className="mt-1 flex gap-2"><Input placeholder={t('ao.ch.number')} value={e.number} onChange={(x) => setExtra(extra.map((y, j) => j === i ? { ...y, number: x.target.value } : y))} /><Input placeholder={t('ao.ch.bank')} value={e.bankName} onChange={(x) => setExtra(extra.map((y, j) => j === i ? { ...y, bankName: x.target.value } : y))} /><Input type="number" placeholder={t('acc.f.amount')} value={e.amount} onChange={(x) => setExtra(extra.map((y, j) => j === i ? { ...y, amount: x.target.value } : y))} /></div>)}
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => setExtra([...extra, { number: '', bankName: '', amount: '' }])}>+ {t('ao.ch.addExtra')}</Button>
        <Field label={t('ao.notes')} className="mt-3"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </>}
    </Dialog>
  );
}
