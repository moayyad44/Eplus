import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Printer, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime, money, num, qty } from '@/lib/format';
import { Button, Card, ErrorState, Input, PageHeader, PageLoader, SearchInput, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Detail {
  id: string; countNumber: string; title: string | null; status: string; createdAt: string; approvedAt: string | null;
  items: { id: string; systemQuantity: number; countedQuantity: number | null; difference: number | null; notes: string | null; item: { id: string; name: string; sku: string; location: string | null; purchasePrice: number; unit: { symbol: string | null; name: string } | null } }[];
}

export default function StockCountDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['stock-counts', id], queryFn: () => api.get<Detail>(`/inventory/stock-counts/${id}`) });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  useEffect(() => { if (q.data) setCounts(Object.fromEntries(q.data.items.map((i) => [i.id, i.countedQuantity == null ? '' : String(num(i.countedQuantity))]))); }, [q.data]);
  const save = useApiMutation(() => api.put(`/inventory/stock-counts/${id}/items`, { items: Object.entries(counts).map(([rid, v]) => ({ id: rid, countedQuantity: v === '' ? null : Number(v) })) }), { invalidate: [['stock-counts', id]] });
  const approve = useApiMutation(async () => { await api.put(`/inventory/stock-counts/${id}/items`, { items: Object.entries(counts).map(([rid, v]) => ({ id: rid, countedQuantity: v === '' ? null : Number(v) })) }); return api.post<{ adjusted: number }>(`/inventory/stock-counts/${id}/approve`); }, {
    invalidate: [['stock-counts'], ['inventory']], success: false, onSuccess: (r) => toast.success(t('inventory.approved', { count: r.adjusted })),
  });
  const cancel = useApiMutation(() => api.post(`/inventory/stock-counts/${id}/cancel`), { invalidate: [['stock-counts']] });
  const rows = useMemo(() => (q.data?.items ?? []).filter((i) => !search || i.item.name.includes(search) || i.item.sku.toLowerCase().includes(search.toLowerCase())), [q.data, search]);
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const sc = q.data;
  const editable = sc.status === 'IN_PROGRESS' && can('stockcount.manage');
  const done = Object.values(counts).filter((v) => v !== '').length;
  const totalDiffValue = sc.items.reduce((a, i) => { const c = counts[i.id]; return c === '' || c == null ? a : a + (Number(c) - num(i.systemQuantity)) * num(i.item.purchasePrice); }, 0);
  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-2">{sc.countNumber} <StatusBadge enumName="StockCountStatus" value={sc.status} /></span>}
        subtitle={`${sc.title ?? ''} · ${fmtDateTime(sc.createdAt)}${sc.approvedAt ? ` · ${t('enum.StockCountStatus.APPROVED')}: ${fmtDateTime(sc.approvedAt)}` : ''}`}
        actions={
          <>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
            {editable && <Button variant="outline" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('inventory.saveCounts')}</Button>}
            {editable && can('stockcount.approve') && <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} loading={approve.isPending} onClick={async () => (await confirm({ message: t('inventory.approveConfirm') })) && approve.mutate(undefined)}>{t('inventory.approve')}</Button>}
            {editable && <Button variant="ghost" onClick={async () => (await confirm({ message: t('inventory.cancelCount'), danger: true })) && cancel.mutate(undefined)}>{t('inventory.cancelCount')}</Button>}
          </>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-4 print:hidden">
          <SearchInput value={search} onChange={setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-64" delay={100} />
          <span className="text-sm text-ink-muted">{t('inventory.progress')}: <b>{done}/{sc.items.length}</b></span>
          <span className="text-sm text-ink-muted">{t('inventory.diffValue')}: <b className={totalDiffValue < 0 ? 'text-danger-600' : 'text-success-700'}>{money(totalDiffValue)}</b></span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2 text-start">{t('inventory.sku')}</th><th className="p-2 text-start">{t('inventory.name')}</th><th className="p-2 text-start">{t('inventory.location')}</th><th className="p-2 text-start">{t('inventory.systemQty')}</th><th className="w-36 p-2 text-start">{t('inventory.countedQty')}</th><th className="p-2 text-start">{t('inventory.difference')}</th></tr></thead>
            <tbody>
              {rows.map((i) => {
                const c = counts[i.id];
                const diff = c === '' || c == null ? null : Number(c) - num(i.systemQuantity);
                return (
                  <tr key={i.id} className="border-b border-line">
                    <td className="p-2 font-mono text-xs">{i.item.sku}</td>
                    <td className="p-2 font-semibold">{i.item.name}</td>
                    <td className="p-2 text-xs">{i.item.location ?? '—'}</td>
                    <td className="p-2 tabular-nums">{qty(i.systemQuantity)} <span className="text-xs text-ink-muted">{i.item.unit?.symbol}</span></td>
                    <td className="p-2">{editable ? <Input type="number" min={0} step="any" value={c ?? ''} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })} className="!h-9" dir="ltr" /> : <span className="tabular-nums">{c === '' ? '—' : c}</span>}</td>
                    <td className={`p-2 font-bold tabular-nums ${diff == null ? '' : diff < 0 ? 'text-danger-600' : diff > 0 ? 'text-success-700' : 'text-ink-muted'}`} dir="ltr">{diff == null ? '—' : `${diff > 0 ? '+' : ''}${qty(diff)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
