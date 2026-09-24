import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { useCatalog, useSuppliersLookup } from '@/lib/catalogs';
import { num } from '@/lib/format';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';

export interface Item {
  id: string; name: string; sku: string; barcode: string | null; categoryId: string | null; unitId: string | null; supplierId: string | null; quantity: number; minQuantity: number;
  purchasePrice: number; salePrice: number | null; expiryDate: string | null; batchNumber: string | null; location: string | null; notes: string | null; isActive: boolean;
  category: { id: string; name: string } | null; unit: { id: string; name: string; symbol: string | null } | null; supplier: { id: string; name: string } | null;
}

export function ItemDialog({ item, onClose, onSaved }: { item?: Item; onClose: () => void; onSaved?: (i: Item) => void }) {
  const { t } = useTranslation();
  const cats = useCatalog('inventory-categories');
  const units = useCatalog('units');
  const suppliers = useSuppliersLookup();
  const [v, setV] = useState({
    name: item?.name ?? '', sku: item?.sku ?? '', barcode: item?.barcode ?? '', categoryId: item?.categoryId ?? '', unitId: item?.unitId ?? '', supplierId: item?.supplierId ?? '',
    minQuantity: String(item?.minQuantity ?? 0), purchasePrice: String(item?.purchasePrice ?? 0), salePrice: item?.salePrice != null ? String(item.salePrice) : '',
    expiryDate: item?.expiryDate?.slice(0, 10) ?? '', batchNumber: item?.batchNumber ?? '', location: item?.location ?? '', notes: item?.notes ?? '', openingQuantity: '0',
  });
  const save = useApiMutation(() => {
    const body = { ...v, categoryId: v.categoryId || null, unitId: v.unitId || null, supplierId: v.supplierId || null, expiryDate: v.expiryDate || null, ...(item ? { openingQuantity: undefined } : {}) };
    return item ? api.put<Item>(`/inventory/items/${item.id}`, body) : api.post<Item>('/inventory/items', body);
  }, { invalidate: [['inventory']], onSuccess: (i) => { onSaved?.(i); onClose(); } });
  const fe = save.fieldErrors;
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  return (
    <Dialog open onClose={onClose} size="lg" title={item ? t('inventory.editItem') : t('inventory.newItem')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('inventory.name')} required error={fe.name} className="sm:col-span-2"><Input {...f('name')} invalid={!!fe.name} /></Field>
        <Field label={t('inventory.sku')} required error={fe.sku}><Input {...f('sku')} dir="ltr" invalid={!!fe.sku} /></Field>
        <Field label={t('inventory.barcode')}><Input {...f('barcode')} dir="ltr" /></Field>
        <Field label={t('inventory.category')}><Select {...f('categoryId')} placeholder={t('common.select')}>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={t('inventory.unit')}><Select {...f('unitId')} placeholder={t('common.select')}>{units.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        {!item && <Field label={t('inventory.openingQuantity')} error={fe.openingQuantity}><Input type="number" min={0} {...f('openingQuantity')} dir="ltr" /></Field>}
        {item && <Field label={t('inventory.quantity')} hint={t('inventory.qtyLocked')}><Input value={num(item.quantity)} disabled dir="ltr" /></Field>}
        <Field label={t('inventory.minQuantity')}><Input type="number" min={0} {...f('minQuantity')} dir="ltr" /></Field>
        <Field label={t('inventory.purchasePrice')}><Input type="number" step="0.001" min={0} {...f('purchasePrice')} dir="ltr" /></Field>
        <Field label={t('inventory.salePrice')}><Input type="number" step="0.001" min={0} {...f('salePrice')} dir="ltr" /></Field>
        <Field label={t('inventory.supplier')}><Select {...f('supplierId')} placeholder={t('common.none')}>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label={t('inventory.expiryDate')}><Input type="date" {...f('expiryDate')} /></Field>
        <Field label={t('inventory.batch')}><Input {...f('batchNumber')} dir="ltr" /></Field>
        <Field label={t('inventory.location')} className="sm:col-span-2"><Input {...f('location')} /></Field>
        <Field label={t('common.notes')} className="sm:col-span-3"><Textarea rows={2} {...f('notes')} /></Field>
      </div>
    </Dialog>
  );
}

const TYPES = ['PURCHASE', 'RECEIPT', 'ISSUE', 'CONSUMPTION', 'RETURN', 'ADJUSTMENT'] as const;

export function MovementDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ type: 'CONSUMPTION' as (typeof TYPES)[number], quantity: '', unitCost: '', reason: '', reference: '', batchNumber: '', expiryDate: '' });
  const stockIn = ['PURCHASE', 'RECEIPT', 'RETURN'].includes(v.type);
  const save = useApiMutation(() => api.post('/inventory/transactions', { ...v, itemId: item.id, quantity: Number(v.quantity), unitCost: v.unitCost || null, expiryDate: v.expiryDate || null }), {
    invalidate: [['inventory']], onSuccess: onClose,
  });
  const fe = save.fieldErrors;
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value as never }) });
  return (
    <Dialog open onClose={onClose} title={t('inventory.newMovement')} subtitle={`${item.name} — ${t('inventory.quantity')}: ${num(item.quantity)}`} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field group label={t('inventory.movementType')} className="sm:col-span-2">
          <div className="grid grid-cols-3 gap-2">
            {TYPES.map((x) => (
              <button key={x} type="button" onClick={() => setV({ ...v, type: x })} className={`h-10 rounded-xl border text-sm font-semibold ${v.type === x ? 'border-primary-500 bg-primary-50 text-primary-800' : 'border-line-strong hover:bg-surface-subtle'}`}>{t(`enum.InventoryTxnType.${x}`)}</button>
            ))}
          </div>
        </Field>
        <Field label={t('inventory.movementQty')} required error={fe.quantity} hint={v.type === 'ADJUSTMENT' ? t('inventory.adjustHint') : undefined}><Input type="number" step="any" {...f('quantity')} dir="ltr" invalid={!!fe.quantity} /></Field>
        {stockIn && <Field label={t('inventory.unitCost')}><Input type="number" step="0.001" {...f('unitCost')} dir="ltr" /></Field>}
        <Field label={t('inventory.reason')} required error={fe.reason} className="sm:col-span-2"><Input {...f('reason')} invalid={!!fe.reason} /></Field>
        <Field label={t('inventory.reference')}><Input {...f('reference')} /></Field>
        {stockIn && <><Field label={t('inventory.batch')}><Input {...f('batchNumber')} dir="ltr" /></Field><Field label={t('inventory.expiryDate')}><Input type="date" {...f('expiryDate')} /></Field></>}
      </div>
    </Dialog>
  );
}
