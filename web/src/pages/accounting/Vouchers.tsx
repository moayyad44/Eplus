import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Ban, FileMinus, FilePlus, Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { amt0, monthStart, today } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, DataTable, ErrorState, Field, IconButton, Input, PageHeader, PageLoader, Pagination, SearchInput, Select, Textarea, useConfirm } from '@/components/ui';
import { AccountSelect, Money, ReportActions, TreasurySelect, exportXlsx, fetchAll } from './shared';

const METHODS = ['CASH', 'TRANSFER', 'CLIQ', 'CHEQUE', 'VISA', 'OTHER'] as const;
interface V { id: string; number: string; kind: 'RECEIPT' | 'PAYMENT'; date: string; method: string; treasuryId: string | null; amount: string; counterAccountId: string; partyName: string; purpose: string; reference: string | null; notes: string | null; status: string; createdBy: string | null; version: number }

export default function Vouchers() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useAuth();
  const [f, setF] = useState({ kind: '', method: '', status: '', q: '', from: monthStart(), to: today(), page: 1 });
  const q = useQuery({ queryKey: ['acc', 'vouchers', f], queryFn: () => api.get<Paged<V> & { totalAmount: string }>('/accounting/vouchers', f) });
  const excel = async () => {
    const all = { items: await fetchAll<V>('/accounting/vouchers', f) };
    await exportXlsx(t('ao.v.title'), [{ header: t('ao.number'), key: 'number' }, { header: t('ao.date'), key: 'date' }, { header: t('ao.v.kind'), key: 'k' }, { header: t('ao.method'), key: 'm' }, { header: t('ao.v.party'), key: 'partyName' }, { header: t('ao.v.purpose'), key: 'purpose' }, { header: t('acc.f.amount'), key: 'a', money: true }, { header: t('acc.f.status'), key: 's' }],
      all.items.map((v) => ({ ...v, k: t(`ao.v.kinds.${v.kind}`), m: t(`ao.methods.${v.method}`), a: Number(v.amount), s: v.status === 'CANCELLED' ? t('ao.cancelled') : '' })), ['a']);
  };
  return (
    <div>
      <PageHeader title={t('ao.v.title')} subtitle={t('ao.v.subtitle')} actions={<ReportActions onExcel={excel} extra={can('accounting.vouchers.create') && <>
        <Button variant="success" icon={<FilePlus className="h-4 w-4" />} onClick={() => nav('/accounting/vouchers/new?kind=RECEIPT')}>{t('ao.v.newReceipt')}</Button>
        <Button variant="danger" icon={<FileMinus className="h-4 w-4" />} onClick={() => nav('/accounting/vouchers/new?kind=PAYMENT')}>{t('ao.v.newPayment')}</Button>
      </>} />} />
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-2 p-4 print:hidden">
          <SearchInput value={f.q} onChange={(x) => setF({ ...f, q: x, page: 1 })} placeholder={t('ao.v.search')} className="w-56" />
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, page: 1 })} className="!h-10 w-32"><option value="">{t('ao.v.allKinds')}</option><option value="RECEIPT">{t('ao.v.kinds.RECEIPT')}</option><option value="PAYMENT">{t('ao.v.kinds.PAYMENT')}</option></Select>
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value, page: 1 })} className="!h-10 w-32"><option value="">{t('ao.allMethods')}</option>{METHODS.map((m) => <option key={m} value={m}>{t(`ao.methods.${m}`)}</option>)}</Select>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} className="!h-10 w-32"><option value="">{t('acc.f.all')}</option><option value="ACTIVE">{t('ao.active')}</option><option value="CANCELLED">{t('ao.cancelled')}</option></Select>
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} className="w-40" />
          <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} className="w-40" />
          {q.data && <Badge tone="primary" dot={false} className="ms-auto">{t('acc.f.total')}: {amt0(q.data.totalAmount)}</Badge>}
        </div>
        <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} onRowClick={(r) => nav(`/accounting/vouchers/${r.id}`)} rowClassName={(r) => clsx(r.status === 'CANCELLED' && 'opacity-50 line-through')} columns={[
          { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
          { key: 'd', header: t('ao.date'), cell: (r) => r.date },
          { key: 'k', header: t('ao.v.kind'), cell: (r) => <Badge tone={r.kind === 'RECEIPT' ? 'success' : 'danger'} dot={false}>{t(`ao.v.kinds.${r.kind}`)}</Badge> },
          { key: 'm', header: t('ao.method'), hideOnMobile: true, cell: (r) => t(`ao.methods.${r.method}`) },
          { key: 'p', header: t('ao.v.party'), cell: (r) => <><b>{r.partyName}</b><span className="block text-xs text-ink-muted">{r.purpose}</span></> },
          { key: 'a', header: t('acc.f.amount'), align: 'end', cell: (r) => <Money v={r.amount} /> },
          { key: 'u', header: t('acc.f.createdBy'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.createdBy}</span> },
        ]} />
        {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
    </div>
  );
}

interface Detail extends V {
  treasury: { name: string; kind: string } | null; counterAccount: { code: string; name: string }; entry: { id: string; number: string; status: string } | null; amountWords: string;
  cheques: { number: string; bankName: string; dueDate: string; status: string; id: string; amount: string }[]; createdBy: string | null; updatedBy: string | null; cancelledBy: string | null; cancelReason: string | null; createdAt: string;
  revisions: { id: string; version: number; action: string; createdAt: string; user: string | null; reason: string | null; changes: { field: string; from: unknown; to: unknown }[] | null }[];
  clinic: { name: string; nameEn: string | null; address: string | null; phone: string | null; hasLogo: boolean };
}

interface Cq { number: string; bankName: string; drawer: string; accountNumber: string; issueDate: string; dueDate: string; amount: string }
const blankCq = (): Cq => ({ number: '', bankName: '', drawer: '', accountNumber: '', issueDate: '', dueDate: today(), amount: '' });
const BANKS = ['البنك العربي', 'بنك الإسكان', 'البنك الأهلي الأردني', 'بنك القاهرة عمان', 'البنك الإسلامي الأردني', 'البنك العربي الإسلامي الدولي', 'بنك الاتحاد', 'البنك التجاري الأردني', 'بنك الأردن', 'بنك الأردن الكويت', 'البنك الاستثماري', 'بنك الاستثمار العربي الأردني', 'بنك صفوة الإسلامي', 'كابيتال بنك', 'بنك ABC', 'سوسيتيه جنرال'];

export function VoucherForm() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { id } = useParams();
  const [sp] = useSearchParams();
  const existing = useQuery({ queryKey: ['acc', 'voucher', id], queryFn: () => api.get<Detail>(`/accounting/vouchers/${id}`), enabled: !!id });
  const settings = useQuery({ queryKey: ['acc', 'settings'], queryFn: () => api.get<{ requireReason: boolean }>('/accounting/settings') });
  const [v, setV] = useState({ kind: (sp.get('kind') as 'RECEIPT' | 'PAYMENT') || 'RECEIPT', date: today(), method: 'CASH', treasuryId: '', amount: '', counterAccountId: '', partyName: '', purpose: '', reference: '', notes: '', reason: '' });
  const [cqs, setCqs] = useState<Cq[]>([blankCq()]);
  useEffect(() => { const d = existing.data; if (d) setV({ kind: d.kind, date: d.date, method: d.method, treasuryId: d.treasuryId ?? '', amount: String(Number(d.amount)), counterAccountId: d.counterAccountId, partyName: d.partyName, purpose: d.purpose, reference: d.reference ?? '', notes: d.notes ?? '', reason: '' }); }, [existing.data]);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const isCheque = v.method === 'CHEQUE', receipt = v.kind === 'RECEIPT';
  const newCheques = isCheque && !id;
  const chequeSum = Math.round(cqs.reduce((t, c) => t + (Number(c.amount) || 0), 0) * 1000) / 1000;
  const setCq = (i: number, p: Partial<Cq>) => setCqs(cqs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const save = useApiMutation(() => {
    const body = {
      ...v, amount: newCheques ? chequeSum : Number(v.amount), treasuryId: v.treasuryId || null, reference: v.reference || null, notes: v.notes || null, reason: v.reason || null,
      ...(newCheques && { cheques: cqs.filter((c) => c.number || c.amount).map((c) => ({ ...c, amount: Number(c.amount), drawer: c.drawer || null, accountNumber: c.accountNumber || null, issueDate: c.issueDate || null })) }),
    };
    return id ? api.put<{ id: string }>(`/accounting/vouchers/${id}`, body) : api.post<{ id: string }>('/accounting/vouchers', body);
  }, { invalidate: [['acc']], onSuccess: (r) => nav(`/accounting/vouchers/${r.id}`, { replace: true }) });
  if (id && existing.isLoading) return <PageLoader />;
  if (existing.error) return <ErrorState error={existing.error} />;
  const treasuryKind = v.method === 'CASH' ? 'CASH' : ['TRANSFER', 'CLIQ', 'CHEQUE'].includes(v.method) ? 'BANK' : undefined;
  const needsTreasury = !(v.method === 'VISA' || (isCheque && receipt));
  return (
    <div>
      <PageHeader title={id ? t('ao.v.edit', { n: existing.data?.number }) : receipt ? t('ao.v.newReceipt') : t('ao.v.newPayment')} back={<Link to="/accounting/vouchers" className="text-sm text-primary-700">{t('ao.v.title')}</Link>} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('ao.date')} required><Input type="date" value={v.date} onChange={set('date')} /></Field>
          <Field label={t('ao.method')} required><Select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value, treasuryId: '' })}>{METHODS.filter((m) => receipt || m !== 'VISA').map((m) => <option key={m} value={m}>{t(`ao.methods.${m}`)}</option>)}</Select></Field>
          <Field label={t('acc.f.amount')} required hint={newCheques ? t('ao.v.chequeSumHint') : undefined}><Input type="number" step="0.001" min="0" dir="ltr" value={newCheques ? String(chequeSum) : v.amount} onChange={set('amount')} disabled={newCheques} /></Field>
          {needsTreasury && <Field label={receipt ? t('ao.v.into') : t('ao.v.from')} required><TreasurySelect kind={treasuryKind} value={v.treasuryId} onChange={(x) => setV({ ...v, treasuryId: x })} /></Field>}
          {v.method === 'VISA' && <p className="self-end rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800">{t('ao.v.visaHint')}</p>}
          {isCheque && receipt && <p className="self-end rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800">{t('ao.v.chequeInHint')}</p>}
          <Field label={receipt ? t('ao.v.creditAccount') : t('ao.v.debitAccount')} required><AccountSelect value={v.counterAccountId} onChange={(x) => setV({ ...v, counterAccountId: x })} /></Field>
          <Field label={receipt ? t('ao.v.payer') : t('ao.v.payee')} required><Input value={v.partyName} onChange={set('partyName')} /></Field>
          <Field label={t('ao.v.purpose')} required className="lg:col-span-2"><Input value={v.purpose} onChange={set('purpose')} /></Field>
          <Field label={t('acc.f.reference')}><Input value={v.reference} onChange={set('reference')} /></Field>
          <Field label={t('ao.notes')} className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field>
        </div>
        {newCheques && (
          <div className="mt-4 rounded-xl border border-line p-3">
            <p className="mb-2 font-semibold">{t('ao.v.chequesTitle', { n: cqs.length })}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead><tr className="text-xs text-ink-muted">
                  <th className="w-8 p-1">#</th><th className="p-1 text-start">{t('ao.ch.number')} *</th><th className="p-1 text-start">{t('ao.ch.bank')} *</th><th className="p-1 text-start">{t('ao.ch.dueDate')} *</th>
                  <th className="p-1 text-start">{t('acc.f.amount')} *</th>{receipt && <th className="p-1 text-start">{t('ao.ch.drawer')}</th>}<th className="p-1 text-start">{t('ao.ch.accountNumber')}</th><th className="w-10" />
                </tr></thead>
                <tbody>{cqs.map((c, i) => (
                  <tr key={i} className="border-t border-line/70">
                    <td className="p-1 text-center text-xs text-ink-muted">{i + 1}</td>
                    <td className="p-1"><Input className="!h-9" dir="ltr" value={c.number} onChange={(e) => setCq(i, { number: e.target.value })} /></td>
                    <td className="p-1"><Input className="!h-9" value={c.bankName} list="cheque-banks" onChange={(e) => setCq(i, { bankName: e.target.value })} /></td>
                    <td className="p-1"><Input className="!h-9" type="date" value={c.dueDate} onChange={(e) => setCq(i, { dueDate: e.target.value })} /></td>
                    <td className="p-1"><Input className="!h-9" type="number" step="0.001" min="0" dir="ltr" value={c.amount} onChange={(e) => setCq(i, { amount: e.target.value })} /></td>
                    {receipt && <td className="p-1"><Input className="!h-9" value={c.drawer} placeholder={v.partyName} onChange={(e) => setCq(i, { drawer: e.target.value })} /></td>}
                    <td className="p-1"><Input className="!h-9" dir="ltr" value={c.accountNumber} onChange={(e) => setCq(i, { accountNumber: e.target.value })} /></td>
                    <td className="p-1">{cqs.length > 1 && <IconButton size="sm" label={t('common.remove')} onClick={() => setCqs(cqs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr className="border-t border-line font-bold">
                  <td /><td className="p-1" colSpan={3}><Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => { const last = cqs[cqs.length - 1]; setCqs([...cqs, { ...blankCq(), bankName: last?.bankName ?? '', drawer: last?.drawer ?? '', accountNumber: last?.accountNumber ?? '', number: /^\d+$/.test(last?.number ?? '') ? String(Number(last.number) + 1).padStart(last.number.length, '0') : '' }]); }}>{t('ao.v.addCheque')}</Button></td>
                  <td className="p-1 tabular-nums" dir="ltr"><Money v={chequeSum} /></td><td colSpan={3} />
                </tr></tfoot>
              </table>
            </div>
            <datalist id="cheque-banks">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
          </div>
        )}
        {isCheque && id && existing.data?.cheques.length ? <p className="mt-3 rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800">{t('ao.v.chequesEditHint', { n: existing.data.cheques.length })}</p> : null}
        {id && <Field label={settings.data?.requireReason ? t('acc.journal.reason') : t('acc.journal.reasonOptional')} className="mt-3"><Input value={v.reason} onChange={set('reason')} /></Field>}
        <div className="mt-4 flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="outline" onClick={() => nav(-1)}>{t('common.cancel')}</Button>
          <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('ao.v.save')}</Button>
        </div>
      </Card>
    </div>
  );
}

export function VoucherView() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['acc', 'voucher', id], queryFn: () => api.get<Detail>(`/accounting/vouchers/${id}`) });
  const cancel = useApiMutation((reason: string) => api.post(`/accounting/vouchers/${id}/cancel`, { reason }), { invalidate: [['acc']] });
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} />;
  const v = q.data!, receipt = v.kind === 'RECEIPT', active = v.status === 'ACTIVE';
  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={`${t(`ao.v.kinds.${v.kind}`)} ${v.number}`} back={<Link to="/accounting/vouchers" className="text-sm text-primary-700">{t('ao.v.title')}</Link>} actions={<>
          <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
          {active && can('accounting.vouchers.edit') && <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => nav(`/accounting/vouchers/${v.id}/edit`)}>{t('common.edit')}</Button>}
          {active && can('accounting.vouchers.cancel') && <Button variant="danger" icon={<Ban className="h-4 w-4" />} onClick={async () => { const r = await confirm({ message: t('ao.v.cancelConfirm', { n: v.number }), danger: true, reason: { label: t('ao.reason'), required: false } }); if (r !== false) cancel.mutate(r || ''); }}>{t('ao.cancel')}</Button>}
        </>} />
      </div>
      <div className="mx-auto max-w-3xl rounded-2xl border border-line bg-white p-8 print:border-0 print:p-0">
        <div className="flex items-start justify-between gap-4 border-b-2 border-primary-700 pb-4">
          <div>
            <p className="text-xl font-extrabold text-primary-800">{v.clinic.name}</p>
            {v.clinic.nameEn && <p className="text-sm text-ink-muted" dir="ltr">{v.clinic.nameEn}</p>}
            <p className="text-xs text-ink-muted">{[v.clinic.address, v.clinic.phone].filter(Boolean).join(' · ')}</p>
          </div>
          {v.clinic.hasLogo && <img src="/api/public/logo" alt="" className="h-16 w-auto" />}
        </div>
        <div className="my-5 flex items-center justify-between">
          <p className={clsx('rounded-xl px-4 py-1.5 text-lg font-extrabold', receipt ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700')}>{t(`ao.v.kinds.${v.kind}`)}</p>
          <div className="text-end text-sm"><p>{t('ao.number')}: <b dir="ltr">{v.number}</b></p><p>{t('ao.date')}: <b>{v.date}</b></p></div>
        </div>
        {!active && <p className="mb-4 rounded-xl bg-danger-50 px-3 py-2 text-center font-bold text-danger-700">{t('ao.v.cancelledStamp')} {v.cancelReason && `— ${v.cancelReason}`}</p>}
        <dl className="space-y-3 text-sm">
          <Row k={receipt ? t('ao.v.receivedFrom') : t('ao.v.paidTo')} v={v.partyName} />
          <Row k={t('ao.v.sum')} v={<span className="text-lg font-extrabold"><Money v={v.amount} /> JOD</span>} />
          <Row k={t('ao.v.words')} v={v.amountWords} />
          <Row k={t('ao.v.for')} v={v.purpose} />
          <Row k={t('ao.method')} v={<>{t(`ao.methods.${v.method}`)}{v.treasury && ` — ${v.treasury.name}`}{v.cheques.length > 0 && ` (${t('ao.v.chequeCount', { n: v.cheques.length })})`}</>} />
          {v.cheques.length > 0 && (
            <div className="border-b border-dotted border-line pb-2">
              <table className="w-full text-xs">
                <thead><tr className="text-ink-muted"><th className="p-1 text-start">#</th><th className="p-1 text-start">{t('ao.ch.number')}</th><th className="p-1 text-start">{t('ao.ch.bank')}</th><th className="p-1 text-start">{t('ao.ch.dueDate')}</th><th className="p-1 text-end">{t('acc.f.amount')}</th></tr></thead>
                <tbody>{v.cheques.map((c, i) => <tr key={c.id} className="border-t border-line/60"><td className="p-1">{i + 1}</td><td className="p-1" dir="ltr">{c.number}</td><td className="p-1">{c.bankName}</td><td className="p-1">{c.dueDate.slice(0, 10)}</td><td className="p-1 text-end"><Money v={c.amount} /></td></tr>)}</tbody>
              </table>
            </div>
          )}
          <Row k={t('ao.v.account')} v={`${v.counterAccount.code} ${v.counterAccount.name}`} />
          {v.reference && <Row k={t('acc.f.reference')} v={v.reference} />}
          {v.notes && <Row k={t('ao.notes')} v={v.notes} />}
        </dl>
        <div className="mt-12 grid grid-cols-3 gap-6 text-center text-sm">
          {[receipt ? t('ao.v.sigPayer') : t('ao.v.sigReceiver'), t('ao.v.sigCashier'), t('ao.v.sigManager')].map((s) => <div key={s}><div className="mb-1 h-12 border-b border-dashed border-line-strong" />{s}</div>)}
        </div>
        <p className="mt-6 text-[11px] text-ink-muted">{t('ao.v.printedBy', { u: v.createdBy ?? '—' })} · {v.entry ? t('ao.v.entry', { n: v.entry.number }) : ''}</p>
      </div>
      <div className="mx-auto mt-4 max-w-3xl space-y-4 print:hidden">
        {v.entry && <Card><p className="text-sm">{t('ao.v.entryLine')} <Link className="font-semibold text-primary-700" to={`/accounting/journal/${v.entry.id}`}>{v.entry.number}</Link> — {t(`acc.status.${v.entry.status}`)}</p></Card>}
        <Card>
          <CardHeader title={t('acc.journal.history')} />
          <ul className="space-y-2 text-sm">{v.revisions.map((r) => (
            <li key={r.id} className="rounded-xl border border-line px-3 py-2">
              <p><b>{t(`ao.revAct.${r.action}`, { defaultValue: r.action })}</b> · {new Date(r.createdAt).toLocaleString('en-GB')} · {r.user}</p>
              {r.reason && <p className="text-xs text-ink-muted">{t('ao.reason')}: {r.reason}</p>}
              {r.changes?.map((c) => <p key={c.field} className="text-xs">{t(`ao.vf.${c.field}`, { defaultValue: c.field })}: <span className="text-danger-700 line-through">{String(c.from ?? '—')}</span> ← <span className="text-success-700">{String(c.to ?? '—')}</span></p>)}
            </li>
          ))}</ul>
        </Card>
      </div>
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex gap-3 border-b border-dotted border-line pb-2"><dt className="w-40 shrink-0 text-ink-muted">{k}</dt><dd className="font-semibold">{v}</dd></div>;
