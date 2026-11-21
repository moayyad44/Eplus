import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Button, Card, DataTable, PageHeader, Pagination, SearchInput, Tabs } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Row { id: string; orderNumber: string; status: string; priority: string; requestedAt: string; patient: { id: string; fullName: string; fileNumber: string; phone: string }; doctor: { fullName: string }; items: { id: string; testName: string; _count: { results: number } }[] }

export default function LabOrders() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const list = usePagedList<Row, { status?: string; mine?: string }>('lab', '/lab/orders', { filters: { status: 'PENDING' } });
  const tab = list.filters.mine ? 'mine' : list.filters.status ?? 'ALL';
  return (
    <div>
      <PageHeader title={t('lab.title')} subtitle={t('lab.subtitle')} actions={<Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => list.query.refetch()}>{t('common.refresh')}</Button>} />
      <Card padded={false}>
        <div className="px-4 pt-2">
          <Tabs
            value={tab}
            onChange={(k) => list.setFilters(k === 'mine' ? { mine: 'true', status: undefined } : { mine: undefined, status: k === 'ALL' ? undefined : k })}
            items={[
              { key: 'PENDING', label: t('lab.pending') },
              { key: 'COMPLETED', label: t('lab.completed') },
              { key: 'mine', label: t('lab.mine'), hidden: !can('lab.order') },
              { key: 'CANCELLED', label: t('enum.LabOrderStatus.CANCELLED') },
              { key: 'ALL', label: t('common.all') },
            ]}
          />
        </div>
        <div className="p-4">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="mb-4 w-full sm:w-80" />
          <DataTable
            rows={list.data?.items}
            loading={list.query.isFetching}
            error={list.query.error}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/lab/${r.id}`)}
            rowClassName={(r) => (r.priority === 'EMERGENCY' ? 'bg-danger-50/40' : undefined)}
            columns={[
              { key: 'n', header: t('lab.orderNumber'), cell: (r) => <span className="font-mono text-xs font-semibold">{r.orderNumber}</span> },
              { key: 'p', header: t('common.patient'), cell: (r) => <><b>{r.patient.fullName}</b><span className="block text-xs text-ink-muted">#{r.patient.fileNumber}</span></> },
              { key: 't', header: t('lab.tests'), cell: (r) => <span className="text-xs">{r.items.map((i) => i.testName).join('، ')}</span> },
              { key: 'doc', header: t('lab.requestedBy'), hideOnMobile: true, cell: (r) => r.doctor.fullName },
              { key: 'd', header: t('lab.requestedAt'), hideOnMobile: true, cell: (r) => <span className="text-xs tabular-nums">{fmtDateTime(r.requestedAt)}</span> },
              { key: 'pr', header: t('reception.priority'), hideOnMobile: true, cell: (r) => r.priority !== 'NORMAL' && <StatusBadge enumName="Priority" value={r.priority} dot={false} /> },
              { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="LabOrderStatus" value={r.status} /> },
            ]}
          />
          {list.data && <Pagination {...list.data} onPage={list.setPage} />}
        </div>
      </Card>
    </div>
  );
}
