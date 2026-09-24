import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { useCatalog } from '@/lib/catalogs';
import { fmtDateTime } from '@/lib/format';
import { Button, Card, DataTable, Dialog, Field, Input, PageHeader, Pagination, Select } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Row { id: string; countNumber: string; title: string | null; status: string; createdAt: string; approvedAt: string | null; _count: { items: number } }

export default function StockCounts() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const cats = useCatalog('inventory-categories');
  const list = usePagedList<Row>('stock-counts', '/inventory/stock-counts');
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ title: '', categoryId: '' });
  const create = useApiMutation(() => api.post<{ id: string }>('/inventory/stock-counts', { title: v.title || null, categoryId: v.categoryId || null }), { invalidate: [['stock-counts']], onSuccess: (r) => nav(`/inventory/stock-counts/${r.id}`) });
  return (
    <div>
      <PageHeader title={t('inventory.stockCounts')} subtitle={t('inventory.stockCountsSubtitle')} actions={can('stockcount.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('inventory.newCount')}</Button>} />
      <Card>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/inventory/stock-counts/${r.id}`)}
          columns={[
            { key: 'n', header: '#', cell: (r) => <span className="font-mono text-xs font-semibold">{r.countNumber}</span> },
            { key: 't', header: t('inventory.countTitle'), cell: (r) => r.title ?? '—' },
            { key: 'c', header: t('inventory.itemsCount'), cell: (r) => r._count.items },
            { key: 'd', header: t('common.createdAt'), cell: (r) => fmtDateTime(r.createdAt) },
            { key: 'a', header: t('enum.StockCountStatus.APPROVED'), cell: (r) => fmtDateTime(r.approvedAt) },
            { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="StockCountStatus" value={r.status} /> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm" title={t('inventory.newCount')} footer={<><Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button loading={create.isPending} onClick={() => create.mutate(undefined)}>{t('common.add')}</Button></>}>
        <div className="space-y-3">
          <Field label={t('inventory.countTitle')}><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
          <Field label={t('inventory.byCategory')}>
            <Select value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })}>
              <option value="">{t('inventory.allItems')}</option>
              {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
