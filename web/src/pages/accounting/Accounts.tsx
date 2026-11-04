import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ChevronDown, ChevronLeft, FileSpreadsheet, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { TYPES, amt0, useAccounts, type AccountRow } from '@/lib/accounting';
import { Badge, Button, Card, Checkbox, Dialog, Field, IconButton, Input, PageHeader, PageLoader, Select, Textarea, useConfirm, ErrorState } from '@/components/ui';

export default function Accounts() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const q = useAccounts();
  const [search, setSearch] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ row?: AccountRow; parent?: AccountRow } | null>(null);
  const manage = can('accounting.accounts.manage');
  const update = useApiMutation((v: { id: string; body: object }) => api.put(`/accounting/accounts/${v.id}`, v.body), { invalidate: [['acc']] });
  const remove = useApiMutation((id: string) => api.del(`/accounting/accounts/${id}`), { invalidate: [['acc']] });
  const rows = q.data ?? [];
  const byParent = useMemo(() => { const m = new Map<string | null, AccountRow[]>(); for (const r of rows) m.set(r.parentId, [...(m.get(r.parentId) ?? []), r]); return m; }, [rows]);
  const visible = useMemo(() => {
    if (search.trim()) { const s = search.trim().toLowerCase(); return rows.filter((r) => r.code.includes(s) || r.name.toLowerCase().includes(s)); }
    const out: AccountRow[] = [];
    const walk = (pid: string | null) => { for (const r of byParent.get(pid) ?? []) { out.push(r); if (!closed.has(r.id)) walk(r.id); } };
    walk(null);
    return out;
  }, [rows, byParent, closed, search]);
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div>
      <PageHeader
        title={t('acc.accounts.title')}
        subtitle={t('acc.accounts.subtitle')}
        actions={<>
          {can('accounting.export') && <Button variant="outline" onClick={() => exportCsv('chart-of-accounts', [
            { header: t('acc.f.code'), value: (r: AccountRow) => r.code }, { header: t('acc.f.name'), value: (r) => r.name }, { header: t('acc.f.type'), value: (r) => t(`acc.type.${r.type}`) },
            { header: t('acc.f.nature'), value: (r) => t(`acc.nature.${r.nature}`) }, { header: t('acc.f.parent'), value: (r) => rows.find((x) => x.id === r.parentId)?.code ?? '' },
            { header: t('acc.f.balance'), value: (r) => r.closing.toFixed(3) }, { header: t('acc.f.status'), value: (r) => (r.isActive ? '' : t('acc.accounts.inactive')) },
          ], rows)}>{t('common.exportCsv')}</Button>}
          {manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>{t('acc.accounts.add')}</Button>}
        </>}
      />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('acc.accounts.search')} className="w-full sm:w-72" />
          <Button size="sm" variant="ghost" onClick={() => setClosed(new Set())}>{t('acc.accounts.expandAll')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setClosed(new Set(rows.filter((r) => r.isGroup && r.level > 0).map((r) => r.id)))}>{t('acc.accounts.collapseAll')}</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b border-line text-xs text-ink-muted">
              <th className="p-2 text-start">{t('acc.f.code')}</th><th className="p-2 text-start">{t('acc.f.name')}</th><th className="p-2 text-start">{t('acc.f.nature')}</th>
              <th className="p-2 text-end">{t('acc.f.balance')}</th><th className="w-40" />
            </tr></thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className={clsx('border-b border-line/70 hover:bg-surface-subtle', r.isGroup && 'bg-primary-50/40 font-semibold', !r.isActive && 'opacity-60')}>
                  <td className="p-2 font-mono text-xs" dir="ltr">{r.code}</td>
                  <td className="p-2">
                    <span className="flex items-center gap-1" style={{ paddingInlineStart: `${(search ? 0 : r.level) * 18}px` }}>
                      {r.isGroup && !search ? <button type="button" onClick={() => toggle(r.id)} className="rounded p-0.5 text-ink-muted hover:bg-white">{closed.has(r.id) ? <ChevronLeft className="h-4 w-4 ltr:rotate-180" /> : <ChevronDown className="h-4 w-4" />}</button> : <span className="w-5" />}
                      {r.name}
                      {r.systemKey && <span title={t('acc.accounts.systemHint')}><Lock className="h-3.5 w-3.5 text-ink-muted" /></span>}
                      {!r.isActive && <Badge dot={false}>{t('acc.accounts.inactive')}</Badge>}
                    </span>
                  </td>
                  <td className="p-2 text-xs text-ink-muted">{t(`acc.nature.${r.nature}`)}</td>
                  <td className={clsx('p-2 text-end tabular-nums', r.closing < 0 && 'text-danger-600')} dir="ltr">{amt0(r.closing)}</td>
                  <td className="p-2">
                    <span className="flex justify-end gap-0.5">
                      <IconButton size="sm" label={t('acc.accounts.statement')} onClick={() => nav(`/accounting/statement?accountId=${r.id}`)}><FileSpreadsheet className="h-4 w-4" /></IconButton>
                      {manage && r.isGroup && <IconButton size="sm" label={t('acc.accounts.addChild')} onClick={() => setEditing({ parent: r })}><Plus className="h-4 w-4" /></IconButton>}
                      {manage && <IconButton size="sm" label={t('common.edit')} onClick={() => setEditing({ row: r })}><Pencil className="h-4 w-4" /></IconButton>}
                      {manage && !r.systemKey && (r.isActive
                        ? <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: r.id, body: { isActive: false } })}>{t('acc.accounts.stop')}</Button>
                        : <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: r.id, body: { isActive: true } })}>{t('acc.accounts.activate')}</Button>)}
                      {manage && !r.systemKey && !r.lines && !byParent.get(r.id)?.length && (
                        <IconButton size="sm" label={t('common.delete')} onClick={async () => (await confirm({ message: t('acc.accounts.deleteConfirm', { name: r.name }), danger: true })) && remove.mutate(r.id)}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editing && <AccountDialog {...editing} rows={rows} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountDialog({ row, parent, rows, onClose }: { row?: AccountRow; parent?: AccountRow; rows: AccountRow[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({
    code: row?.code ?? (parent ? suggestCode(parent, rows) : ''), name: row?.name ?? '', parentId: row?.parentId ?? parent?.id ?? '', type: row?.type ?? parent?.type ?? 'EXPENSE',
    nature: row?.nature ?? '', isGroup: row?.isGroup ?? false, description: '',
  });
  const p = rows.find((r) => r.id === v.parentId);
  const save = useApiMutation(() => {
    const body = { code: v.code, name: v.name, parentId: v.parentId || null, ...(!p && { type: v.type }), ...(v.nature && { nature: v.nature }), isGroup: v.isGroup, description: v.description || null };
    return row ? api.put(`/accounting/accounts/${row.id}`, body) : api.post('/accounting/accounts', body);
  }, { invalidate: [['acc']], onSuccess: onClose });
  const fe = save.fieldErrors;
  return (
    <Dialog open onClose={onClose} title={row ? t('acc.accounts.edit') : t('acc.accounts.add')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {row?.systemKey && <p className="rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800 sm:col-span-2">{t('acc.accounts.systemHint')}</p>}
        <Field label={t('acc.f.code')} required error={fe.code}><Input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} dir="ltr" invalid={!!fe.code} /></Field>
        <Field label={t('acc.f.name')} required error={fe.name}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} invalid={!!fe.name} /></Field>
        <Field label={t('acc.f.parent')} className="sm:col-span-2">
          <Select value={v.parentId} onChange={(e) => setV({ ...v, parentId: e.target.value })}>
            <option value="">{t('acc.f.none')}</option>
            {rows.filter((r) => r.isGroup && r.id !== row?.id && (!row || r.type === row.type)).map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name}</option>)}
          </Select>
        </Field>
        <Field label={t('acc.f.type')}>
          <Select value={p?.type ?? v.type} disabled={!!p || !!row} onChange={(e) => setV({ ...v, type: e.target.value })}>{TYPES.map((x) => <option key={x} value={x}>{t(`acc.type.${x}`)}</option>)}</Select>
        </Field>
        <Field label={t('acc.f.nature')}>
          <Select value={v.nature} onChange={(e) => setV({ ...v, nature: e.target.value })}>
            <option value="">{t('acc.f.natureAuto')}</option>
            <option value="DEBIT">{t('acc.nature.DEBIT')}</option><option value="CREDIT">{t('acc.nature.CREDIT')}</option>
          </Select>
        </Field>
        <Checkbox className="sm:col-span-2" label={t('acc.f.isGroup')} checked={v.isGroup} onChange={(e) => setV({ ...v, isGroup: e.target.checked })} />
        {!row && <Field label={t('acc.f.description')} className="sm:col-span-2"><Textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>}
      </div>
    </Dialog>
  );
}

/** Next free code under a parent: parent code + 2 digits. */
function suggestCode(parent: AccountRow, rows: AccountRow[]) {
  const kids = rows.filter((r) => r.parentId === parent.id).map((r) => r.code).filter((c) => c.startsWith(parent.code) && /^\d+$/.test(c));
  for (let i = 1; i < 100; i++) { const c = `${parent.code}${String(i).padStart(2, '0')}`; if (!kids.includes(c) && !rows.some((r) => r.code === c)) return c; }
  return '';
}
