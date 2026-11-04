import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { CheckCircle2, Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { JTYPES, STATUS_TONE, amt, amt0, today, useAccounts } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, ErrorState, Field, IconButton, Input, PageHeader, PageLoader, Select, useConfirm } from '@/components/ui';

interface Line { accountId: string; debit: string; credit: string; description: string; partyName: string }
interface Entry {
  id: string; number: string; date: string; type: string; status: string; description: string; reference: string | null; sourceType: string | null; sourceId: string | null; version: number;
  createdById: string | null; createdBy: string | null; updatedBy: string | null; postedBy: string | null; deletedBy: string | null; createdAt: string; updatedAt: string; postedAt: string | null; deletedAt: string | null; totalDebit: string;
  lines: { id: string; accountId: string; debit: string; credit: string; description: string | null; partyName: string | null; account: { code: string; name: string } }[];
  revisions: { id: string; version: number; action: string; createdAt: string; user: string | null; reason: string | null; changes: { field: string; from: unknown; to: unknown }[] | null }[];
}
const blank = (): Line => ({ accountId: '', debit: '', credit: '', description: '', partyName: '' });

export default function JournalEntryPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const [sp] = useSearchParams();
  const editMode = isNew || sp.get('edit') === '1';
  const q = useQuery({ queryKey: ['acc', 'entry', id], queryFn: () => api.get<Entry>(`/accounting/journal/${id}`), enabled: !isNew });
  if (!isNew && q.isLoading) return <PageLoader />;
  if (!isNew && (q.error || !q.data)) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return editMode ? <Editor entry={isNew ? undefined : q.data} copyFrom={sp.get('copy')} /> : <View entry={q.data!} />;
}

function Editor({ entry, copyFrom }: { entry?: Entry; copyFrom: string | null }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const accounts = useAccounts();
  const settings = useQuery({ queryKey: ['acc', 'settings'], queryFn: () => api.get<{ requireApproval: boolean; requireReason: boolean }>('/accounting/settings') });
  const copy = useQuery({ queryKey: ['acc', 'entry', copyFrom], queryFn: () => api.get<Entry>(`/accounting/journal/${copyFrom}`), enabled: !!copyFrom });
  const [head, setHead] = useState({ date: entry?.date ?? today(), type: entry?.type ?? 'GENERAL', description: entry?.description ?? '', reference: entry?.reference ?? '' });
  const [lines, setLines] = useState<Line[]>(entry ? entry.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit) ? String(Number(l.debit)) : '', credit: Number(l.credit) ? String(Number(l.credit)) : '', description: l.description ?? '', partyName: l.partyName ?? '' })) : [blank(), blank()]);
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (copy.data) { setHead({ date: today(), type: copy.data.type, description: copy.data.description, reference: '' }); setLines(copy.data.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit) ? String(Number(l.debit)) : '', credit: Number(l.credit) ? String(Number(l.credit)) : '', description: l.description ?? '', partyName: l.partyName ?? '' }))); }
  }, [copy.data]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const debit = useMemo(() => lines.reduce((s, l) => s + (Number(l.debit) || 0), 0), [lines]);
  const credit = useMemo(() => lines.reduce((s, l) => s + (Number(l.credit) || 0), 0), [lines]);
  const diff = Math.round((debit - credit) * 1000) / 1000;
  const posts = !settings.data?.requireApproval || can('accounting.journal.approve');
  const save = useApiMutation(() => {
    const body = { ...head, reference: head.reference || null, ...(entry && { reason: reason || null }), lines: lines.filter((l) => l.accountId || l.debit || l.credit).map((l) => ({ accountId: l.accountId, debit: l.debit || 0, credit: l.credit || 0, description: l.description || null, partyName: l.partyName || null })) };
    return entry ? api.put<{ id: string; number: string; status: string }>(`/accounting/journal/${entry.id}`, body) : api.post<{ id: string; number: string; status: string }>('/accounting/journal', body);
  }, {
    invalidate: [['acc'], ['acc-journal']], success: false,
    onSuccess: (r) => {
      setDirty(false);
      toast.success(entry ? t('acc.journal.updated') : r.status === 'POSTED' ? t('acc.journal.saved', { n: r.number }) : t('acc.journal.savedDraft', { n: r.number }));
      nav(`/accounting/journal/${r.id}`, { replace: true });
    },
  });
  const set = (i: number, p: Partial<Line>) => { setDirty(true); setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l))); };
  const leafs = (accounts.data ?? []).filter((a) => !a.isGroup && (a.isActive || lines.some((l) => l.accountId === a.id)));
  return (
    <div>
      <PageHeader title={entry ? `${t('acc.journal.edit')} ${entry.number}` : t('acc.journal.new')} subtitle={entry?.status === 'POSTED' ? t('acc.journal.postedHint') : t('acc.journal.subtitle')} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('acc.f.date')} required error={save.fieldErrors.date}><Input type="date" value={head.date} onChange={(e) => { setDirty(true); setHead({ ...head, date: e.target.value }); }} /></Field>
          <Field label={t('acc.f.jtype')}><Select value={head.type} onChange={(e) => { setDirty(true); setHead({ ...head, type: e.target.value }); }}>{JTYPES.map((x) => <option key={x} value={x}>{t(`acc.jtype.${x}`)}</option>)}</Select></Field>
          <Field label={t('acc.f.statement')} required error={save.fieldErrors.description} className="lg:col-span-1"><Input value={head.description} onChange={(e) => { setDirty(true); setHead({ ...head, description: e.target.value }); }} /></Field>
          <Field label={t('acc.f.reference')}><Input value={head.reference} onChange={(e) => { setDirty(true); setHead({ ...head, reference: e.target.value }); }} /></Field>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="border-b border-line text-xs text-ink-muted">
              <th className="w-8 p-2">#</th><th className="p-2 text-start">{t('acc.f.account')}</th><th className="w-32 p-2 text-start">{t('acc.f.debit')}</th><th className="w-32 p-2 text-start">{t('acc.f.credit')}</th>
              <th className="p-2 text-start">{t('acc.f.lineNote')}</th><th className="w-40 p-2 text-start">{t('acc.f.party')}</th><th className="w-10" />
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-line/70">
                  <td className="p-2 text-center text-xs text-ink-muted">{i + 1}</td>
                  <td className="p-1.5"><Select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} className="!h-9">
                    <option value="">{t('acc.journal.pickAccount')}</option>
                    {['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].map((ty) => <optgroup key={ty} label={t(`acc.type.${ty}`)}>{leafs.filter((a) => a.type === ty).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</optgroup>)}
                  </Select></td>
                  <td className="p-1.5"><Input type="number" min={0} step="0.001" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, ...(e.target.value && { credit: '' }) })} className="!h-9" dir="ltr" /></td>
                  <td className="p-1.5"><Input type="number" min={0} step="0.001" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, ...(e.target.value && { debit: '' }) })} className="!h-9" dir="ltr" /></td>
                  <td className="p-1.5"><Input value={l.description} onChange={(e) => set(i, { description: e.target.value })} className="!h-9" /></td>
                  <td className="p-1.5"><Input value={l.partyName} onChange={(e) => set(i, { partyName: e.target.value })} className="!h-9" /></td>
                  <td className="p-1.5">{lines.length > 2 && <IconButton size="sm" label={t('acc.journal.removeLine')} onClick={() => { setDirty(true); setLines(lines.filter((_, j) => j !== i)); }}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="font-bold">
              <td /><td className="p-2"><Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => { setDirty(true); setLines([...lines, blank()]); }}>{t('acc.journal.addLine')}</Button></td>
              <td className="p-2 tabular-nums" dir="ltr">{amt0(debit)}</td><td className="p-2 tabular-nums" dir="ltr">{amt0(credit)}</td>
              <td colSpan={3} className="p-2">{diff === 0 && debit > 0 ? <span className="text-success-700">✓ {t('acc.journal.balanced')}</span> : <span className="text-danger-600">{t('acc.journal.unbalanced', { d: amt0(Math.abs(diff)) })}</span>}</td>
            </tr></tfoot>
          </table>
        </div>
        {save.fieldErrors.lines && <p className="mt-2 text-xs text-danger-600">{save.fieldErrors.lines}</p>}
        {entry && <Field label={settings.data?.requireReason ? t('acc.journal.reason') : t('acc.journal.reasonOptional')} required={settings.data?.requireReason} className="mt-4 max-w-xl"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => (!dirty || window.confirm(t('acc.journal.unsaved'))) && nav(entry ? `/accounting/journal/${entry.id}` : '/accounting/journal')}>{t('common.cancel')}</Button>
          <Button loading={save.isPending} disabled={diff !== 0 || debit <= 0 || !head.description.trim() || (!!entry && !!settings.data?.requireReason && !reason.trim())} onClick={() => save.mutate(undefined)}>{entry ? t('common.saveChanges') : posts ? t('acc.journal.save') : t('acc.journal.saveDraft')}</Button>
        </div>
      </Card>
    </div>
  );
}

function View({ entry: e }: { entry: Entry }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const approve = useApiMutation(() => api.post(`/accounting/journal/${e.id}/approve`), { invalidate: [['acc'], ['acc-journal']], success: t('acc.journal.approved') });
  const del = useApiMutation(() => api.del(`/accounting/journal/${e.id}`), { invalidate: [['acc'], ['acc-journal']], success: t('acc.journal.deleted') });
  const auto = !!e.sourceType;
  const canEdit = e.status !== 'DELETED' && !auto && (e.status === 'POSTED' ? can('accounting.journal.edit_posted') : can('accounting.journal.approve') || (can('accounting.journal.create') && e.createdById === me?.user.id));
  const sumD = e.lines.reduce((s, l) => s + Number(l.debit), 0), sumC = e.lines.reduce((s, l) => s + Number(l.credit), 0);
  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-2"><span dir="ltr">{e.number}</span><Badge tone={STATUS_TONE[e.status]} dot={false}>{t(`acc.status.${e.status}`)}</Badge>{auto && <Badge tone="info" dot={false}>{t('acc.source.auto')}</Badge>}</span>}
        subtitle={`${e.date} · ${t(`acc.jtype.${e.type}`)}`}
        actions={<>
          {e.status === 'DRAFT' && can('accounting.journal.approve') && <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} loading={approve.isPending} onClick={() => approve.mutate(undefined)}>{t('acc.journal.approve')}</Button>}
          {canEdit && <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => nav(`/accounting/journal/${e.id}?edit=1`)}>{t('common.edit')}</Button>}
          {can('accounting.journal.create') && !auto && <Button variant="ghost" icon={<Copy className="h-4 w-4" />} onClick={() => nav(`/accounting/journal/new?copy=${e.id}`)}>{t('acc.journal.copy')}</Button>}
          {e.status !== 'DELETED' && !auto && can('accounting.journal.delete') && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={async () => (await confirm({ message: t('acc.journal.deleteConfirm', { n: e.number }), danger: true })) && del.mutate(undefined)}>{t('acc.journal.delete')}</Button>}
        </>}
      />
      {auto && <p className="mb-3 rounded-xl bg-primary-50 px-3 py-2 text-sm text-primary-800">{t('acc.journal.autoHint')}</p>}
      <Card className="mb-4">
        <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-ink-muted">{t('acc.f.statement')}</dt><dd className="font-semibold">{e.description}</dd></div>
          <div><dt className="text-xs text-ink-muted">{t('acc.f.reference')}</dt><dd>{e.reference ?? '—'}</dd></div>
          <div><dt className="text-xs text-ink-muted">{t('acc.f.createdBy')}</dt><dd>{e.createdBy ?? '—'} · <span className="text-xs">{fmtDateTime(e.createdAt)}</span></dd></div>
          <div><dt className="text-xs text-ink-muted">{t('acc.f.postedBy')}</dt><dd>{e.postedBy ?? '—'}{e.postedAt && <span className="text-xs"> · {fmtDateTime(e.postedAt)}</span>}</dd></div>
        </dl>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2 text-start">{t('acc.f.account')}</th><th className="p-2 text-start">{t('acc.f.lineNote')}</th><th className="p-2 text-end">{t('acc.f.debit')}</th><th className="p-2 text-end">{t('acc.f.credit')}</th></tr></thead>
            <tbody>{e.lines.map((l) => (
              <tr key={l.id} className="border-b border-line/70">
                <td className="p-2"><button type="button" className="hover:text-primary-700" onClick={() => nav(`/accounting/statement?accountId=${l.accountId}`)}><span className="font-mono text-xs" dir="ltr">{l.account.code}</span> {l.account.name}</button></td>
                <td className="p-2 text-xs">{l.description}{l.partyName && <span className="block text-ink-muted">{l.partyName}</span>}</td>
                <td className="p-2 text-end tabular-nums" dir="ltr">{amt(l.debit)}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt(l.credit)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr className="font-bold"><td colSpan={2} className="p-2 text-end">{t('acc.f.total')}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt0(sumD)}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt0(sumC)}</td></tr></tfoot>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader title={t('acc.journal.history')} />
        <ol className="space-y-2">
          {e.revisions.map((r) => (
            <li key={r.id} className="rounded-xl border border-line px-3 py-2 text-sm">
              <p className="flex flex-wrap items-center gap-2"><b>{t(`acc.journal.act.${r.action}`)}</b><span className="text-xs text-ink-muted">{t('acc.journal.v', { v: r.version })} · {r.user ?? t('acc.journal.system')} · {fmtDateTime(r.createdAt)}</span></p>
              {r.reason && <p className="mt-0.5 text-xs"><b>{t('acc.journal.reason')}:</b> {r.reason}</p>}
              {r.changes?.map((c) => (
                <div key={c.field} className={clsx('mt-1 text-xs', c.field === 'lines' && 'space-y-1')}>
                  <span className="font-semibold">{t(`acc.journal.field.${c.field}`)}:</span>{' '}
                  {c.field === 'lines' ? <LinesDiff from={c.from as LineSnap[]} to={c.to as LineSnap[]} /> : <><span className="text-danger-600 line-through">{String(c.from ?? '—')}</span> ← <span className="text-success-700">{String(c.to ?? '—')}</span></>}
                </div>
              ))}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

type LineSnap = { account: string; debit: number; credit: number };
function LinesDiff({ from, to }: { from: LineSnap[]; to: LineSnap[] }) {
  const { t } = useTranslation();
  const show = (ls: LineSnap[]) => ls.map((l, i) => <span key={i} className="block">{l.account}: {l.debit ? `${t('acc.f.debit')} ${amt0(l.debit)}` : `${t('acc.f.credit')} ${amt0(l.credit)}`}</span>);
  return <span className="grid gap-2 sm:grid-cols-2"><span className="rounded-lg bg-danger-50 p-2"><b>{t('acc.journal.before')}</b>{show(from)}</span><span className="rounded-lg bg-success-50 p-2"><b>{t('acc.journal.after')}</b>{show(to)}</span></span>;
}
