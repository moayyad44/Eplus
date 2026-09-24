import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Archive, ArrowLeftRight, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime, fmtDay, money, num, qty } from '@/lib/format';
import { Button, Card, CardHeader, DataTable, ErrorState, PageHeader, PageLoader, StatCard, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { ItemDialog, MovementDialog, type Item } from './shared';

interface Txn { id: string; type: string; quantity: number; balanceAfter: number; unitCost: number | null; reason: string | null; reference: string | null; createdAt: string }

export default function ItemDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [edit, setEdit] = useState(false);
  const [move, setMove] = useState(false);
  const q = useQuery({ queryKey: ['inventory', 'item', id], queryFn: () => api.get<Item & { transactions: Txn[] }>(`/inventory/items/${id}`) });
  const archive = useApiMutation(() => api.del(`/inventory/items/${id}`), { invalidate: [['inventory']], onSuccess: () => nav('/inventory/items') });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const i = q.data;
  const low = num(i.quantity) <= num(i.minQuantity);
  return (
    <div>
      <PageHeader
        title={i.name}
        subtitle={<span dir="ltr">{i.sku}{i.barcode && ` · ${i.barcode}`}</span>}
        actions={
          <>
            {can('inventory.transact') && <Button icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setMove(true)}>{t('inventory.newMovement')}</Button>}
            {can('inventory.manage') && <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>{t('common.edit')}</Button>}
            {can('inventory.manage') && <Button variant="ghost" icon={<Archive className="h-4 w-4" />} disabled={num(i.quantity) > 0} title={t('inventory.archiveHint')} onClick={async () => (await confirm({ message: i.name, danger: true })) && archive.mutate(undefined)}>{t('common.archive')}</Button>}
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('inventory.quantity')} value={`${qty(i.quantity)} ${i.unit?.symbol ?? ''}`} tone={low ? 'danger' : 'success'} hint={`${t('inventory.minQuantity')}: ${qty(i.minQuantity)}`} />
        <StatCard label={t('inventory.purchasePrice')} value={money(i.purchasePrice)} hint={i.salePrice != null ? `${t('inventory.salePrice')}: ${money(i.salePrice)}` : undefined} />
        <StatCard label={t('inventory.stockValue')} value={money(num(i.quantity) * num(i.purchasePrice))} tone="violet" />
        <StatCard label={t('inventory.expiryDate')} value={fmtDay(i.expiryDate)} hint={i.batchNumber ? `${t('inventory.batch')}: ${i.batchNumber}` : undefined} tone="warning" />
      </div>
      <Card>
        <CardHeader title={t('inventory.lastMovements')} subtitle={[i.category?.name, i.supplier?.name, i.location].filter(Boolean).join(' · ')} />
        <DataTable
          rows={i.transactions}
          rowKey={(r) => r.id}
          dense
          columns={[
            { key: 'd', header: t('common.date'), cell: (r) => <span className="text-xs tabular-nums">{fmtDateTime(r.createdAt)}</span> },
            { key: 't', header: t('inventory.movementType'), cell: (r) => <StatusBadge enumName="InventoryTxnType" value={r.type} /> },
            { key: 'q', header: t('inventory.movementQty'), cell: (r) => <b className={`tabular-nums ${num(r.quantity) < 0 ? 'text-danger-600' : 'text-success-700'}`} dir="ltr">{num(r.quantity) > 0 ? '+' : ''}{qty(r.quantity)}</b> },
            { key: 'b', header: t('inventory.balanceAfter'), cell: (r) => <span className="tabular-nums">{qty(r.balanceAfter)}</span> },
            { key: 'r', header: t('inventory.reason'), cell: (r) => r.reason ?? '—' },
            { key: 'ref', header: t('inventory.reference'), hideOnMobile: true, cell: (r) => r.reference ?? '—' },
          ]}
        />
      </Card>
      {edit && <ItemDialog item={i} onClose={() => setEdit(false)} />}
      {move && <MovementDialog item={i} onClose={() => setMove(false)} />}
    </div>
  );
}
