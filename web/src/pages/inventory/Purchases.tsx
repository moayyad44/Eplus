import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { fmtDate, money } from '@/lib/format';
import { Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Row { id: string; poNumber: string; status: string; orderDate: string; total: number; supplier: { id: string; name: string }; _count: { items: number } }

export default function Purchases() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const list = usePagedList<Row, { status?: string }>('purchases', '/purchases');
  return (
    <div>
      <PageHeader title={t('suppliers.purchasesTitle')} subtitle={t('suppliers.purchasesSubtitle')} actions={can('suppliers.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav('/purchases/new')}>{t('suppliers.newPO')}</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-72" />
          <Select value={list.filters.status ?? ''} onChange={(e) => list.setFilters({ status: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.status')}: {t('common.all')}</option>
            {['DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED'].map((s) => <option key={s} value={s}>{t(`enum.PurchaseOrderStatus.${s}`)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/purchases/${r.id}`)}
          columns={[
            { key: 'n', header: t('suppliers.poNumber'), cell: (r) => <span className="font-mono text-xs font-semibold">{r.poNumber}</span> },
            { key: 's', header: t('common.supplier'), cell: (r) => <b>{r.supplier.name}</b> },
            { key: 'd', header: t('suppliers.orderDate'), cell: (r) => fmtDate(r.orderDate) },
            { key: 'c', header: t('inventory.itemsCount'), hideOnMobile: true, cell: (r) => r._count.items },
            { key: 't', header: t('common.total'), cell: (r) => <b>{money(r.total)}</b> },
            { key: 'st', header: t('common.status'), cell: (r) => <StatusBadge enumName="PurchaseOrderStatus" value={r.status} /> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
