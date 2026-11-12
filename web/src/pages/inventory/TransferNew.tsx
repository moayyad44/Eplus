import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Trash2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Paged } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { useWarehouses } from '@/lib/catalogs';
import { num, qty } from '@/lib/format';
import { Button, Card, Field, IconButton, Input, PageHeader, Textarea, useConfirm } from '@/components/ui';
import { Autocomplete } from '@/components/shared/Autocomplete';
import { WarehouseSelect, useDefaultWarehouseId, type Item } from './shared';

interface Line { itemId: string; name: string; sku: string; unit: string; available: number; quantity: string }

export default function TransferNew() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const warehouses = useWarehouses();
  const defaultWh = useDefaultWarehouseId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const fromId = from || defaultWh;
  const name = (id: string) => warehouses.data?.find((w) => w.id === id)?.name ?? '';

  // Opened from an item page: start with that item.
  const preset = params.get('itemId');
  useEffect(() => {
    if (!preset || !fromId) return;
    api.get<Item>(`/inventory/items/${preset}`).then((it) => setLines((ls) => ls.some((l) => l.itemId === it.id) ? ls : [{ itemId: it.id, name: it.name, sku: it.sku, unit: it.unit?.symbol ?? it.unit?.name ?? '', available: num(it.stocks?.find((s) => s.warehouseId === fromId)?.quantity ?? 0), quantity: '' }])).catch(() => undefined);
  }, [preset, fromId]);

  const changeFrom = (id: string) => { setFrom(id); setLines([]); if (id === to) setTo(''); };
  const over = lines.some((l) => Number(l.quantity) > l.available);
  const ready = !!fromId && !!to && lines.length > 0 && lines.every((l) => Number(l.quantity) > 0) && !over;
  const save = useApiMutation(
    () => api.post<{ id: string; transferNumber: string }>('/inventory/transfers', { fromWarehouseId: fromId, toWarehouseId: to, notes: notes || null, items: lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) })) }),
    { invalidate: [['inventory'], ['transfers'], ['inventory-txns']], success: false, onSuccess: (r) => { toast.success(t('inventory.tr.done', { number: r.transferNumber })); nav(`/inventory/transfers/${r.id}`, { replace: true }); } },
  );
  const submit = async () => {
    if (await confirm({ message: t('inventory.tr.confirm', { n: lines.length, from: name(fromId), to: name(to) }), confirmLabel: t('inventory.tr.save') })) save.mutate(undefined);
  };
  return (
    <div>
      <PageHeader title={t('inventory.tr.new')} subtitle={t('inventory.tr.allOrNothing')} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('inventory.tr.from')} required><WarehouseSelect value={fromId} onChange={changeFrom} /></Field>
          <Field label={t('inventory.tr.to')} required error={save.fieldErrors.toWarehouseId}><WarehouseSelect value={to} onChange={setTo} exclude={fromId} allLabel={t('common.select')} /></Field>
          <Field label={t('inventory.tr.addItem')} className="sm:col-span-2">
            <Autocomplete<Item>
              value={search}
              onChange={setSearch}
              onPick={(it) => { setSearch(''); if (!lines.some((l) => l.itemId === it.id)) setLines([...lines, { itemId: it.id, name: it.name, sku: it.sku, unit: it.unit?.symbol ?? it.unit?.name ?? '', available: num(it.warehouseQuantity ?? 0), quantity: '' }]); }}
              fetcher={(s) => api.get<Paged<Item>>('/inventory/items', { q: s, pageSize: 10, warehouseId: fromId }).then((r) => r.items)}
              queryKey={`tr-items-${fromId}`}
              placeholder={t('inventory.tr.searchItem')}
              render={(it) => <span className="flex w-full justify-between gap-2"><span><b>{it.name}</b> <span className="font-mono text-xs text-ink-muted">{it.sku}</span></span><span className="tabular-nums text-xs">{qty(it.warehouseQuantity ?? 0)}</span></span>}
            />
          </Field>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2 text-start">{t('suppliers.item')}</th><th className="w-36 p-2 text-start">{t('inventory.inWarehouse')}</th><th className="w-40 p-2 text-start">{t('inventory.tr.qty')}</th><th className="w-10" /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const bad = Number(l.quantity) > l.available;
                return (
                  <tr key={l.itemId} className="border-b border-line">
                    <td className="p-2"><b>{l.name}</b> <span className="font-mono text-xs text-ink-muted">{l.sku}</span></td>
                    <td className="p-2 tabular-nums">{qty(l.available)} <span className="text-xs text-ink-muted">{l.unit}</span></td>
                    <td className="p-2">
                      <Input type="number" min={0} step="any" value={l.quantity} invalid={bad} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} className="!h-9" dir="ltr" />
                      {bad && <span className="text-xs text-danger-600">{t('inventory.tr.more')}</span>}
                    </td>
                    <td className="p-2"><IconButton size="sm" label={t('common.remove')} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton></td>
                  </tr>
                );
              })}
              {!lines.length && <tr><td colSpan={4} className="p-6 text-center text-sm text-ink-muted">{t('inventory.tr.none')}</td></tr>}
            </tbody>
          </table>
        </div>
        {save.fieldErrors.items && <p className="mt-2 text-xs text-danger-600">{save.fieldErrors.items}</p>}
        <Field label={t('inventory.tr.notes')} className="mt-4"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end"><Button icon={<Truck className="h-4 w-4" />} loading={save.isPending} disabled={!ready} onClick={submit}>{t('inventory.tr.save')}</Button></div>
      </Card>
    </div>
  );
}
