import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDateTime, num, qty } from '@/lib/format';
import { Button, Card, DataTable, DateRangePicker, PageHeader, Pagination, SearchInput, Select, presetRange } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Row { id: string; type: string; quantity: number; balanceAfter: number; reason: string | null; reference: string | null; createdAt: string; userName: string | null; item: { id: string; name: string; sku: string; unit: { symbol: string | null; name: string } | null } }
const TYPES = ['PURCHASE', 'RECEIPT', 'ISSUE', 'CONSUMPTION', 'RETURN', 'ADJUSTMENT', 'STOCK_COUNT', 'SALE', 'SALE_REVERSAL'];

export default function Transactions() {
  const { t } = useTranslation();
  const list = usePagedList<Row, { type?: string; from?: string; to?: string }>('inventory-txns', '/inventory/transactions', { pageSize: 30, filters: presetRange('month') });
  return (
    <div>
      <PageHeader
        title={t('inventory.movements')}
        subtitle={t('inventory.movementsSubtitle')}
        actions={<Button variant="outline" onClick={() => list.data && exportCsv('inventory-movements', [
          { header: t('common.date'), value: (r: Row) => fmtDateTime(r.createdAt) }, { header: t('inventory.name'), value: (r) => r.item.name },
          { header: t('inventory.movementType'), value: (r) => t(`enum.InventoryTxnType.${r.type}`) }, { header: t('inventory.movementQty'), value: (r) => num(r.quantity) },
          { header: t('inventory.balanceAfter'), value: (r) => num(r.balanceAfter) }, { header: t('inventory.reason'), value: (r) => r.reason ?? '' }, { header: t('common.user'), value: (r) => r.userName ?? '' },
        ], list.data.items)}>{t('common.exportCsv')}</Button>}
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-60" />
          <Select value={list.filters.type ?? ''} onChange={(e) => list.setFilters({ type: e.target.value || undefined })} className="w-auto">
            <option value="">{t('inventory.movementType')}: {t('common.all')}</option>
            {TYPES.map((x) => <option key={x} value={x}>{t(`enum.InventoryTxnType.${x}`)}</option>)}
          </Select>
          <DateRangePicker value={{ from: list.filters.from!, to: list.filters.to! }} onChange={(r) => list.setFilters(r)} />
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          dense
          columns={[
            { key: 'd', header: t('common.date'), cell: (r) => <span className="text-xs tabular-nums">{fmtDateTime(r.createdAt)}</span> },
            { key: 'i', header: t('inventory.name'), cell: (r) => <Link to={`/inventory/items/${r.item.id}`} className="font-semibold hover:text-primary-700">{r.item.name}</Link> },
            { key: 't', header: t('inventory.movementType'), cell: (r) => <StatusBadge enumName="InventoryTxnType" value={r.type} /> },
            { key: 'q', header: t('inventory.movementQty'), cell: (r) => <b className={`tabular-nums ${num(r.quantity) < 0 ? 'text-danger-600' : 'text-success-700'}`} dir="ltr">{num(r.quantity) > 0 ? '+' : ''}{qty(r.quantity)}</b> },
            { key: 'b', header: t('inventory.balanceAfter'), cell: (r) => qty(r.balanceAfter) },
            { key: 'r', header: t('inventory.reason'), hideOnMobile: true, cell: (r) => r.reason ?? '—' },
            { key: 'ref', header: t('inventory.reference'), hideOnMobile: true, cell: (r) => r.reference ?? '—' },
            { key: 'u', header: t('common.user'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.userName ?? ''}</span> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
