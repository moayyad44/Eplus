import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { usePagedList } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import type { UserLite } from '@/lib/types';
import { Badge, Card, DataTable, Dialog, PageHeader, Pagination, SearchInput, Select } from '@/components/ui';

interface Log { id: string; userName: string | null; action: string; entityType: string; entityId: string | null; summary: string | null; before: unknown; after: unknown; ip: string | null; userAgent: string | null; createdAt: string }

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function AuditLogs() {
  const { t } = useTranslation();
  const list = usePagedList<Log, { userId?: string; entityType?: string; from?: string; to?: string }>('audit', '/audit-logs', { pageSize: 30 });
  const facets = useQuery({ queryKey: ['audit-facets'], queryFn: () => api.get<{ entityTypes: string[]; actions: string[] }>('/audit-logs/facets') });
  const users = useQuery({ queryKey: ['users', 'lookup'], queryFn: () => api.get<UserLite[]>('/users/lookup') });
  const [sel, setSel] = useState<Log | null>(null);
  const keys = sel ? [...new Set([...Object.keys((sel.before as object) ?? {}), ...Object.keys((sel.after as object) ?? {})])] : [];
  return (
    <div>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-72" />
          <Select value={list.filters.userId ?? ''} onChange={(e) => list.setFilters({ userId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('audit.allUsers')}</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
          <Select value={list.filters.entityType ?? ''} onChange={(e) => list.setFilters({ entityType: e.target.value || undefined })} className="w-auto">
            <option value="">{t('audit.allEntities')}</option>
            {facets.data?.entityTypes.map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
          <span className="ms-auto flex items-center gap-1 text-xs text-ink-muted"><Lock className="h-3.5 w-3.5" />{t('audit.immutable')}</span>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={setSel}
          dense
          columns={[
            { key: 'createdAt', header: t('common.date'), cell: (r) => <span className="whitespace-nowrap text-xs tabular-nums">{fmtDateTime(r.createdAt)}</span> },
            { key: 'user', header: t('common.user'), cell: (r) => r.userName ?? '—' },
            { key: 'action', header: t('audit.action'), cell: (r) => <Badge tone={r.action.includes('cancel') || r.action.includes('void') || r.action.includes('delete') || r.action.includes('failed') ? 'danger' : 'info'} dot={false}><span dir="ltr">{r.action}</span></Badge> },
            { key: 'entity', header: t('audit.entity'), cell: (r) => <span className="text-xs" dir="ltr">{r.entityType}</span>, hideOnMobile: true },
            { key: 'summary', header: t('audit.summary'), cell: (r) => <span className="line-clamp-1 text-xs text-ink-soft">{r.summary ?? '—'}</span> },
            { key: 'ip', header: t('audit.ip'), cell: (r) => <span className="text-xs text-ink-muted" dir="ltr">{r.ip ?? '—'}</span>, hideOnMobile: true },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      <Dialog open={!!sel} onClose={() => setSel(null)} size="lg" title={sel?.action ?? ''} subtitle={sel ? `${sel.userName ?? ''} · ${fmtDateTime(sel.createdAt)}` : ''}>
        {sel && (
          <div className="space-y-4 text-sm">
            {sel.summary && <p className="rounded-xl bg-surface-subtle p-3">{sel.summary}</p>}
            {keys.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-ink-muted"><th className="p-2 text-start">{t('audit.field')}</th><th className="p-2 text-start">{t('audit.before')}</th><th className="p-2 text-start">{t('audit.after')}</th></tr></thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k} className="border-t border-line align-top">
                        <td className="p-2 font-semibold" dir="ltr">{k}</td>
                        <td className="max-w-xs break-words p-2 text-danger-700">{show((sel.before as Record<string, unknown>)?.[k])}</td>
                        <td className="max-w-xs break-words p-2 text-success-700">{show((sel.after as Record<string, unknown>)?.[k])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-ink-muted" dir="ltr">{sel.entityType} {sel.entityId} · {sel.ip} · {sel.userAgent}</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
