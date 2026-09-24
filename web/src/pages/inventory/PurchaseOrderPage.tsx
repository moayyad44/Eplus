import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PackageCheck, Plus, Printer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { useSuppliersLookup } from '@/lib/catalogs';
import { fmtDate, money, num, qty } from '@/lib/format';
import { Button, Card, ErrorState, Field, IconButton, Input, PageHeader, PageLoader, Select, Textarea, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { Autocomplete } from '@/components/shared/Autocomplete';

interface Line { itemId: string; name: string; quantity: string; unitCost: string; batchNumber: string; expiryDate: string }
interface PO { id: string; updatedAt: string; poNumber: string; status: string; orderDate: string; receivedAt: string | null; total: number; notes: string | null; supplier: { id: string; name: string; phone: string | null }; items: { itemId: string; quantity: number; unitCost: number; lineTotal: number; batchNumber: string | null; expiryDate: string | null; item: { name: string; sku: string } }[] }

export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const [params] = useSearchParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const suppliers = useSuppliersLookup();
  const q = useQuery({ queryKey: ['purchases', id], queryFn: () => api.get<PO>(`/purchases/${id}`), enabled: !isNew });
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const initKey = q.data ? `${q.data.id}:${q.data.updatedAt}` : '';
  useEffect(() => {
    if (q.data) {
      setSupplierId(q.data.supplier.id);
      setNotes(q.data.notes ?? '');
      setLines(q.data.items.map((i) => ({ itemId: i.itemId, name: i.item.name, quantity: String(num(i.quantity)), unitCost: String(num(i.unitCost)), batchNumber: i.batchNumber ?? '', expiryDate: i.expiryDate?.slice(0, 10) ?? '' })));
    }
  }, [initKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = can('suppliers.manage') && (isNew || ['DRAFT', 'ORDERED'].includes(q.data?.status ?? ''));
  const save = useApiMutation(() => {
    const body = { supplierId, notes: notes || null, items: lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unitCost: Number(l.unitCost), batchNumber: l.batchNumber || null, expiryDate: l.expiryDate || null })) };
    return isNew ? api.post<{ id: string }>('/purchases', body) : api.put<{ id: string }>(`/purchases/${id}`, body);
  }, { invalidate: [['purchases'], ['suppliers']], onSuccess: (r) => isNew && nav(`/purchases/${r.id}`, { replace: true }) });
  const status = useApiMutation((s: string) => api.post(`/purchases/${id}/status`, { status: s }), { invalidate: [['purchases'], ['suppliers'], ['inventory']], success: false, onSuccess: (_r, s) => toast.success(s === 'RECEIVED' ? t('suppliers.received') : t('common.done')) });

  if (!isNew && q.isLoading) return <PageLoader />;
  if (!isNew && (q.error || !q.data)) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const total = lines.reduce((a, l) => a + num(l.quantity) * num(l.unitCost), 0);
  const setLine = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));

  return (
    <div>
      <PageHeader
        title={isNew ? t('suppliers.newPO') : <span className="flex items-center gap-2">{q.data!.poNumber} <StatusBadge enumName="PurchaseOrderStatus" value={q.data!.status} /></span>}
        subtitle={!isNew ? `${q.data!.supplier.name} · ${fmtDate(q.data!.orderDate)}` : undefined}
        actions={!isNew && (
          <>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
            {can('suppliers.manage') && q.data!.status === 'DRAFT' && <Button variant="secondary" onClick={() => status.mutate('ORDERED')}>{t('suppliers.markOrdered')}</Button>}
            {can('suppliers.manage') && ['DRAFT', 'ORDERED'].includes(q.data!.status) && (
              <>
                <Button variant="success" icon={<PackageCheck className="h-4 w-4" />} onClick={async () => (await confirm({ message: t('suppliers.receiveConfirm') })) && status.mutate('RECEIVED')}>{t('suppliers.receive')}</Button>
                <Button variant="ghost" onClick={async () => (await confirm({ message: t('suppliers.cancelPO'), danger: true })) && status.mutate('CANCELLED')}>{t('suppliers.cancelPO')}</Button>
              </>
            )}
          </>
        )}
      />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label={t('common.supplier')} required error={save.fieldErrors.supplierId}>
            <Select value={supplierId} disabled={!editable} onChange={(e) => setSupplierId(e.target.value)} placeholder={t('common.select')}>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </Field>
          {editable && (
            <Field label={t('suppliers.addLine')}>
              <Autocomplete<{ id: string; name: string; sku: string; purchasePrice: number }>
                value={search}
                onChange={setSearch}
                onPick={(it) => { setSearch(''); if (!lines.some((l) => l.itemId === it.id)) setLines([...lines, { itemId: it.id, name: it.name, quantity: '1', unitCost: String(num(it.purchasePrice)), batchNumber: '', expiryDate: '' }]); }}
                fetcher={(s) => api.get<Paged<{ id: string; name: string; sku: string; purchasePrice: number }>>('/inventory/items', { q: s, pageSize: 10 }).then((r) => r.items)}
                queryKey="po-items"
                placeholder={t('common.searchPlaceholder')}
                render={(it) => <span><b>{it.name}</b> <span className="font-mono text-xs text-ink-muted">{it.sku}</span></span>}
              />
            </Field>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2 text-start">{t('suppliers.item')}</th><th className="w-24 p-2 text-start">{t('suppliers.qty')}</th><th className="w-28 p-2 text-start">{t('suppliers.cost')}</th><th className="w-32 p-2 text-start">{t('inventory.batch')}</th><th className="w-40 p-2 text-start">{t('inventory.expiryDate')}</th><th className="p-2 text-end">{t('suppliers.lineTotal')}</th><th className="w-10" /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.itemId} className="border-b border-line">
                  <td className="p-2 font-semibold">{l.name}</td>
                  <td className="p-2">{editable ? <Input type="number" min={0} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className="!h-9" dir="ltr" /> : qty(l.quantity)}</td>
                  <td className="p-2">{editable ? <Input type="number" step="0.001" min={0} value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} className="!h-9" dir="ltr" /> : money(l.unitCost)}</td>
                  <td className="p-2">{editable ? <Input value={l.batchNumber} onChange={(e) => setLine(i, { batchNumber: e.target.value })} className="!h-9" dir="ltr" /> : l.batchNumber || '—'}</td>
                  <td className="p-2">{editable ? <Input type="date" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} className="!h-9" /> : l.expiryDate || '—'}</td>
                  <td className="p-2 text-end font-bold tabular-nums">{money(num(l.quantity) * num(l.unitCost))}</td>
                  <td className="p-2">{editable && <IconButton size="sm" label={t('common.remove')} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={5} className="p-2 text-end font-bold">{t('common.total')}</td><td className="p-2 text-end text-lg font-bold tabular-nums text-primary-700">{money(total)}</td><td /></tr></tfoot>
          </table>
        </div>
        {save.fieldErrors.items && <p className="mt-2 text-xs text-danger-600">{save.fieldErrors.items}</p>}
        <Field label={t('common.notes')} className="mt-4"><Textarea rows={2} value={notes} disabled={!editable} onChange={(e) => setNotes(e.target.value)} /></Field>
        {editable && <div className="mt-4 flex justify-end"><Button icon={<Plus className="h-4 w-4" />} loading={save.isPending} disabled={!supplierId || !lines.length} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></div>}
      </Card>
    </div>
  );
}
