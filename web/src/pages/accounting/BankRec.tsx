import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Plus, Trash2, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { amt0, today } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, DataTable, Field, Input, PageHeader, PageLoader, useConfirm } from '@/components/ui';
import { AccountSelect, Money, TreasurySelect } from './shared';

interface Line { id: string; date: string; number: string; description: string; reference: string | null; amount: number }
interface Book { treasury: { name: string }; book: number; lines: Line[]; lastApproved: { number: string; statementDate: string; statementBalance: number } | null }
interface Rec { id: string; number: string; treasury: string; statementDate: string; statementBalance: string; status: string; summary: { difference: number; book: number }; notes: string | null }

export default function BankRec() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['acc', 'bank-recs'], queryFn: () => api.get<Rec[]>('/accounting/bank-recs') });
  const [treasuryId, setTreasuryId] = useState('');
  const [date, setDate] = useState(today());
  const [statement, setStatement] = useState('');
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [adj, setAdj] = useState<{ date: string; description: string; amount: string; accountId: string }[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const book = useQuery({ queryKey: ['acc', 'bank-book', treasuryId, date], queryFn: () => api.get<Book>('/accounting/bank-recs/book', { treasuryId, date }), enabled: !!treasuryId });
  const match = useApiMutation(() => { const fd = new FormData(); fd.append('file', file!); fd.append('treasuryId', treasuryId); fd.append('date', date); return api.upload<{ rows: { line: number; date: string; description: string; amount: number | null; lineId: string | null; status: string }[]; totals: { matched: number; notInBooks: number } }>('/accounting/bank-recs/match', fd); },
    { success: false, onSuccess: (r) => setCleared(new Set(r.rows.map((x) => x.lineId).filter(Boolean) as string[])) });
  const lines = book.data?.lines ?? [];
  const calc = useMemo(() => {
    const out = lines.filter((l) => !cleared.has(l.id));
    const dit = out.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0), op = out.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);
    const a = adj.reduce((s, x) => s + Number(x.amount || 0), 0);
    const expected = (book.data?.book ?? 0) + a - dit + op;
    return { dit, op, a, expected, diff: Math.round((Number(statement || 0) - expected) * 1000) / 1000 };
  }, [lines, cleared, adj, statement, book.data]);
  const save = useApiMutation(() => api.post<{ id: string }>('/accounting/bank-recs', { treasuryId, statementDate: date, statementBalance: Number(statement), clearedLineIds: [...cleared], adjustments: adj.filter((a) => Number(a.amount)).map((a) => ({ ...a, amount: Number(a.amount) })), notes: null }), { invalidate: [['acc']], onSuccess: () => { setCleared(new Set()); setAdj([]); setStatement(''); } });
  const act = useApiMutation((v: { id: string; a: 'approve' | 'cancel'; reason?: string }) => api.post(`/accounting/bank-recs/${v.id}/${v.a}`, { reason: v.reason ?? null }), { invalidate: [['acc']] });
  return (
    <div>
      <PageHeader title={t('ao.br.title')} subtitle={t('ao.br.subtitle')} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('ao.ch.bankAccount')}><TreasurySelect kind="BANK" value={treasuryId} onChange={(x) => { setTreasuryId(x); setCleared(new Set()); }} /></Field>
          <Field label={t('ao.br.statementDate')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t('ao.br.statementBalance')}><Input type="number" step="0.001" dir="ltr" value={statement} onChange={(e) => setStatement(e.target.value)} /></Field>
          {treasuryId && <><Field label={t('ao.br.file')}><Input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <Button variant="outline" icon={<Upload className="h-4 w-4" />} disabled={!file} loading={match.isPending} onClick={() => match.mutate(undefined)}>{t('ao.br.autoMatch')}</Button></>}
        </div>
        {book.data?.lastApproved && <p className="mt-2 text-xs text-ink-muted">{t('ao.br.last', { n: book.data.lastApproved.number, d: book.data.lastApproved.statementDate, b: amt0(book.data.lastApproved.statementBalance) })}</p>}
        {match.data && <p className="mt-2 text-sm">{t('ao.br.matched', { m: match.data.totals.matched, n: match.data.totals.notInBooks })}</p>}
        {match.data && match.data.totals.notInBooks > 0 && <ul className="mt-1 text-xs text-warning-700">{match.data.rows.filter((r) => !r.lineId).map((r) => <li key={r.line}>{r.date} · {r.description} · {amt0(r.amount)} — {t('ao.br.notInBooks')}</li>)}</ul>}
      </Card>
      {treasuryId && (book.isLoading ? <PageLoader /> : book.data && <>
        <Card padded={false} className="mb-4">
          <CardHeader className="p-4" title={t('ao.br.bookLines')} subtitle={t('ao.br.bookHint')} actions={<Button size="sm" variant="ghost" onClick={() => setCleared(cleared.size === lines.length ? new Set() : new Set(lines.map((l) => l.id)))}>{t('ao.br.toggleAll')}</Button>} />
          <DataTable rows={lines} rowKey={(l) => l.id} rowClassName={(l) => clsx(cleared.has(l.id) && 'bg-success-50/60')} onRowClick={(l) => { const s = new Set(cleared); s.has(l.id) ? s.delete(l.id) : s.add(l.id); setCleared(s); }} columns={[
            { key: 'c', header: '', cell: (l) => <input type="checkbox" readOnly checked={cleared.has(l.id)} /> },
            { key: 'd', header: t('ao.date'), cell: (l) => l.date },
            { key: 'n', header: t('acc.f.number'), cell: (l) => <span className="font-mono text-xs" dir="ltr">{l.number}</span> },
            { key: 's', header: t('acc.f.statement'), cell: (l) => <span className="text-xs">{l.description}{l.reference && ` · ${l.reference}`}</span> },
            { key: 'i', header: t('ao.br.in'), align: 'end', cell: (l) => l.amount > 0 ? <Money v={l.amount} /> : '' },
            { key: 'o', header: t('ao.br.out'), align: 'end', cell: (l) => l.amount < 0 ? <Money v={-l.amount} /> : '' },
          ]} />
        </Card>
        <Card className="mb-4">
          <CardHeader title={t('ao.br.adjustments')} subtitle={t('ao.br.adjHint')} actions={<Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setAdj([...adj, { date, description: '', amount: '', accountId: '' }])}>{t('ao.br.addAdj')}</Button>} />
          {adj.map((a, i) => (
            <div key={i} className="mb-2 grid gap-2 sm:grid-cols-[9rem_1fr_9rem_1fr_auto]">
              <Input type="date" value={a.date} onChange={(e) => setAdj(adj.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} />
              <Input placeholder={t('acc.f.statement')} value={a.description} onChange={(e) => setAdj(adj.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
              <Input type="number" step="0.001" dir="ltr" placeholder="±" value={a.amount} onChange={(e) => setAdj(adj.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
              <AccountSelect value={a.accountId} onChange={(x) => setAdj(adj.map((y, j) => j === i ? { ...y, accountId: x } : y))} />
              <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => setAdj(adj.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div className="mt-3 grid gap-2 border-t border-line pt-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <p>{t('ao.br.book')}: <Money v={book.data.book} /></p>
            <p>{t('ao.br.adjTotal')}: <Money v={calc.a} /></p>
            <p>{t('ao.br.dit')}: <Money v={-calc.dit} /></p>
            <p>{t('ao.br.op')}: <Money v={calc.op} /></p>
            <p className="font-bold">{t('ao.br.expected')}: <Money v={calc.expected} /></p>
            <p><Badge tone={calc.diff ? 'danger' : 'success'} dot={false}>{t('acc.f.difference')}: {amt0(calc.diff)}</Badge></p>
          </div>
          <div className="mt-3 flex justify-end"><Button disabled={statement === ''} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('ao.br.save')}</Button></div>
        </Card>
      </>)}
      <Card padded={false}>
        <CardHeader className="p-4" title={t('ao.br.history')} />
        <DataTable rows={list.data} loading={list.isLoading} error={list.error} rowKey={(r) => r.id} columns={[
          { key: 'n', header: t('ao.number'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.number}</span> },
          { key: 't', header: t('ao.ch.bankAccount'), cell: (r) => r.treasury },
          { key: 'd', header: t('ao.br.statementDate'), cell: (r) => r.statementDate },
          { key: 'b', header: t('ao.br.statementBalance'), align: 'end', cell: (r) => <Money v={r.statementBalance} /> },
          { key: 'x', header: t('acc.f.difference'), align: 'end', cell: (r) => <Money v={r.summary?.difference} /> },
          { key: 's', header: t('acc.f.status'), cell: (r) => <Badge tone={r.status === 'APPROVED' ? 'success' : r.status === 'PENDING' ? 'warning' : 'neutral'} dot={false}>{t(`ao.br.st.${r.status}`)}</Badge> },
          { key: 'a', header: '', cell: (r) => r.status !== 'REJECTED' && <div className="flex gap-1">
            {r.status === 'PENDING' && <Button size="sm" variant="success" onClick={() => act.mutate({ id: r.id, a: 'approve' })}>{t('ao.approve')}</Button>}
            <Button size="sm" variant="ghost" onClick={async () => { const reason = await confirm({ message: t('ao.cancelConfirm', { n: r.number }), danger: true, reason: { label: t('ao.reason'), required: false } }); if (reason !== false) act.mutate({ id: r.id, a: 'cancel', reason: reason || undefined }); }}>{t('ao.cancel')}</Button>
          </div> },
        ]} />
      </Card>
    </div>
  );
}
