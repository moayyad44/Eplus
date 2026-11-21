import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime, qty } from '@/lib/format';
import { Button, Card, DataTable, ErrorState, PageHeader, PageLoader } from '@/components/ui';

export interface TransferDoc {
  id: string; transferNumber: string; createdAt: string; notes: string | null; createdBy: string | null;
  fromWarehouse: { id: string; name: string; code: string }; toWarehouse: { id: string; name: string; code: string };
  items: { id: string; quantity: number; item: { id: string; name: string; sku: string; unit: { name: string; symbol: string | null } | null } }[];
}

export default function TransferDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['transfers', id], queryFn: () => api.get<TransferDoc>(`/inventory/transfers/${id}`) });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <div>
      <PageHeader
        title={<span dir="ltr">{d.transferNumber}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-1.5">{d.fromWarehouse.name}<ArrowLeft className="h-3.5 w-3.5 ltr:rotate-180" />{d.toWarehouse.name} · {fmtDateTime(d.createdAt)}{d.createdBy ? ` · ${d.createdBy}` : ''}</span>}
        actions={<Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/print/transfer/${d.id}`, '_blank')}>{t('inventory.tr.print')}</Button>}
      />
      <Card>
        {d.notes && <p className="mb-3 rounded-xl bg-surface-subtle px-3 py-2 text-sm">{d.notes}</p>}
        <DataTable
          rows={d.items}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/inventory/items/${r.item.id}`)}
          columns={[
            { key: 'n', header: t('suppliers.item'), cell: (r) => <><b>{r.item.name}</b> <span className="font-mono text-xs text-ink-muted">{r.item.sku}</span></> },
            { key: 'q', header: t('inventory.tr.qty'), cell: (r) => <b className="tabular-nums">{qty(r.quantity)} <span className="text-xs font-normal text-ink-muted">{r.item.unit?.symbol ?? r.item.unit?.name ?? ''}</span></b> },
          ]}
        />
      </Card>
    </div>
  );
}
