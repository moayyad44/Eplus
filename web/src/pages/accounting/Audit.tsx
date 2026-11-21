import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type Paged } from '@/lib/api';
import { Card, DataTable, Input, PageHeader, Pagination, SearchInput } from '@/components/ui';

interface Log { id: string; createdAt: string; userName: string | null; action: string; entityType: string; summary: string | null; ip: string | null }

/** Accounting part of the audit log: who did what, when, on which document. */
export default function Audit() {
  const { t } = useTranslation();
  const [f, setF] = useState({ q: '', from: '', to: '', page: 1 });
  const q = useQuery({ queryKey: ['acc', 'audit', f], queryFn: () => api.get<Paged<Log>>('/accounting/audit', f) });
  return (
    <div>
      <PageHeader title={t('ao.audit.title')} subtitle={t('ao.audit.subtitle')} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 p-4">
          <SearchInput value={f.q} onChange={(x) => setF({ ...f, q: x, page: 1 })} placeholder={t('common.searchPlaceholder')} className="w-64" />
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} className="w-40" />
          <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} className="w-40" />
        </div>
        <DataTable rows={q.data?.items} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} columns={[
          { key: 'd', header: t('ao.date'), cell: (r) => <span className="text-xs" dir="ltr">{new Date(r.createdAt).toLocaleString('en-GB')}</span> },
          { key: 'u', header: t('ao.audit.user'), cell: (r) => r.userName },
          { key: 'a', header: t('ao.audit.action'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.action}</span> },
          { key: 's', header: t('ao.audit.summary'), cell: (r) => <span className="text-sm">{r.summary}</span> },
        ]} />
        {q.data && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} pageSize={q.data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
    </div>
  );
}
