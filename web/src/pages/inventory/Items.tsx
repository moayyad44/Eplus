import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { useCatalog } from '@/lib/catalogs';
import { exportCsv } from '@/lib/export';
import { fmtDay, money, num, qty } from '@/lib/format';
import { Badge, Button, Card, DataTable, IconButton, PageHeader, Pagination, SearchInput, Segmented, Select, StatCard } from '@/components/ui';
import { ItemDialog, MovementDialog, type Item } from './shared';

export const expiryState = (d: string | null) => {
  if (!d) return null;
  const days = (new Date(d).getTime() - Date.now()) / 86_400_000;
  return days < 0 ? 'expired' : days < 60 ? 'soon' : null;
};

export default function Items() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const cats = useCatalog('inventory-categories');
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<Item | null>(null);
  const list = usePagedList<Item, { filter: string; categoryId?: string }>('inventory', '/inventory/items', { sort: 'name', order: 'asc', filters: { filter: 'all' } });
  const stockValue = (list.data as unknown as { stockValue?: number })?.stockValue;
  const filters = ['all', 'low', 'out', 'expiring', 'expired', 'inactive'];
  return (
    <div>
      <PageHeader
        title={t('inventory.title')}
        subtitle={t('inventory.subtitle')}
        actions={
          <>
            <Button variant="outline" onClick={async () => { const all = await api.get<Paged<Item>>('/inventory/items', { ...list.filters, pageSize: 200 }); exportCsv('inventory', [
              { header: t('inventory.sku'), value: (r: Item) => r.sku }, { header: t('inventory.name'), value: (r) => r.name }, { header: t('inventory.category'), value: (r) => r.category?.name ?? '' },
              { header: t('inventory.quantity'), value: (r) => num(r.quantity) }, { header: t('inventory.minQuantity'), value: (r) => num(r.minQuantity) }, { header: t('inventory.purchasePrice'), value: (r) => num(r.purchasePrice) },
              { header: t('inventory.expiryDate'), value: (r) => fmtDay(r.expiryDate) }, { header: t('inventory.batch'), value: (r) => r.batchNumber ?? '' }, { header: t('inventory.location'), value: (r) => r.location ?? '' },
            ], all.items); }}>{t('common.exportCsv')}</Button>
            {can('inventory.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t('inventory.newItem')}</Button>}
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3"><StatCard label={t('inventory.stockValue')} value={money(stockValue)} /></div>
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-64" />
          <Segmented items={filters.map((f) => ({ key: f, label: t(`inventory.filters.${f}`) }))} value={list.filters.filter} onChange={(f) => list.setFilters({ filter: f })} />
          <Select value={list.filters.categoryId ?? ''} onChange={(e) => list.setFilters({ categoryId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('inventory.category')}: {t('common.all')}</option>
            {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          sort={list.sort}
          onSort={list.setSort}
          onRowClick={(r) => nav(`/inventory/items/${r.id}`)}
          columns={[
            { key: 'sku', header: t('inventory.sku'), sortable: true, cell: (r) => <span className="font-mono text-xs">{r.sku}</span> },
            { key: 'name', header: t('inventory.name'), sortable: true, cell: (r) => <><b>{r.name}</b><span className="block text-xs text-ink-muted">{r.category?.name}</span></> },
            {
              key: 'quantity', header: t('inventory.quantity'), sortable: true, cell: (r) => (
                <span className="flex items-center gap-1.5"><b className={`tabular-nums ${num(r.quantity) <= num(r.minQuantity) ? 'text-danger-600' : ''}`}>{qty(r.quantity)}</b><span className="text-xs text-ink-muted">{r.unit?.symbol ?? r.unit?.name}</span>{num(r.quantity) <= num(r.minQuantity) && <Badge tone="danger" dot={false}>{t('inventory.low')}</Badge>}</span>
              ),
            },
            { key: 'min', header: t('inventory.minQuantity'), hideOnMobile: true, cell: (r) => qty(r.minQuantity) },
            { key: 'p', header: t('inventory.purchasePrice'), hideOnMobile: true, cell: (r) => money(r.purchasePrice) },
            { key: 'expiryDate', header: t('inventory.expiryDate'), sortable: true, cell: (r) => { const s = expiryState(r.expiryDate); return <span className="flex items-center gap-1">{fmtDay(r.expiryDate)}{s && <Badge tone={s === 'expired' ? 'danger' : 'warning'} dot={false}>{s === 'expired' ? t('inventory.expired') : t('inventory.expiringSoon')}</Badge>}</span>; } },
            { key: 'loc', header: t('inventory.location'), hideOnMobile: true, cell: (r) => r.location ?? '—' },
            { key: 'x', header: '', cell: (r) => can('inventory.transact') && <IconButton size="sm" label={t('inventory.newMovement')} onClick={(e) => { e.stopPropagation(); setMoving(r); }}><ArrowLeftRight className="h-4 w-4" /></IconButton> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {creating && <ItemDialog onClose={() => setCreating(false)} onSaved={(i) => nav(`/inventory/items/${i.id}`)} />}
      {moving && <MovementDialog item={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}
