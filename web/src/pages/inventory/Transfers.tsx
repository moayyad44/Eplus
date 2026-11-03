import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Truck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Button, Card, DataTable, DateRangePicker, PageHeader, Pagination, SearchInput, presetRange } from '@/components/ui';
import { WarehouseSelect } from './shared';

interface Row { id: string; transferNumber: string; createdAt: string; notes: string | null; createdBy: string | null; fromWarehouse: { name: string }; toWarehouse: { name: string }; _count: { items: number } }

export default function Transfers() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const list = usePagedList<Row, { warehouseId?: string; from?: string; to?: string }>('transfers', '/inventory/transfers', { filters: presetRange('month') });
  return (
    <div>
      <PageHeader title={t('inventory.tr.title')} subtitle={t('inventory.tr.subtitle')} actions={can('inventory.transfer') && <Button icon={<Truck className="h-4 w-4" />} onClick={() => nav('/inventory/transfers/new')}>{t('inventory.tr.new')}</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-60" />
          <WarehouseSelect value={list.filters.warehouseId ?? ''} onChange={(id) => list.setFilters({ warehouseId: id || undefined })} allLabel={t('inventory.allWarehouses')} className="w-auto" />
          <DateRangePicker value={{ from: list.filters.from!, to: list.filters.to! }} onChange={(r) => list.setFilters(r)} />
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/inventory/transfers/${r.id}`)}
          columns={[
            { key: 'n', header: t('inventory.tr.number'), cell: (r) => <span className="font-mono text-xs font-semibold" dir="ltr">{r.transferNumber}</span> },
            { key: 'd', header: t('common.date'), cell: (r) => <span className="text-xs tabular-nums">{fmtDateTime(r.createdAt)}</span> },
            { key: 'w', header: `${t('inventory.tr.from')} ← ${t('inventory.tr.to')}`, cell: (r) => <span className="flex items-center gap-1.5 font-semibold">{r.fromWarehouse.name}<ArrowLeft className="h-3.5 w-3.5 text-ink-muted ltr:rotate-180" />{r.toWarehouse.name}</span> },
            { key: 'i', header: t('inventory.itemsCount'), cell: (r) => r._count.items },
            { key: 'b', header: t('inventory.tr.by'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.createdBy ?? ''}</span> },
            { key: 'o', header: t('inventory.tr.notes'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.notes ?? ''}</span> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
