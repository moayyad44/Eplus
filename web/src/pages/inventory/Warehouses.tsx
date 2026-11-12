import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Star, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { useWarehouses, type Warehouse } from '@/lib/catalogs';
import { money } from '@/lib/format';
import { Badge, Button, Card, DataTable, Dialog, Field, IconButton, Input, PageHeader, Textarea, useConfirm } from '@/components/ui';

export default function Warehouses() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const list = useWarehouses();
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const update = useApiMutation((v: { id: string; body: object }) => api.put(`/inventory/warehouses/${v.id}`, v.body), { invalidate: [['inventory']] });
  const manage = can('inventory.manage');
  return (
    <div>
      <PageHeader
        title={t('inventory.wh.title')}
        subtitle={t('inventory.wh.subtitle')}
        actions={<>
          {can('inventory.transfer') && <Button variant="outline" icon={<Truck className="h-4 w-4" />} onClick={() => nav('/inventory/transfers/new')}>{t('inventory.tr.new')}</Button>}
          {manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>{t('inventory.wh.new')}</Button>}
        </>}
      />
      <Card>
        <p className="mb-3 text-xs text-ink-muted">{t('inventory.wh.defaultHint')}</p>
        <DataTable
          rows={list.data}
          loading={list.isFetching}
          error={list.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/inventory/items?warehouseId=${r.id}`)}
          columns={[
            { key: 'n', header: t('settings.fields.name'), cell: (r) => (
              <span className="flex flex-wrap items-center gap-1.5"><b>{r.name}</b>
                {r.isDefault && <Badge tone="primary" dot={false}>{t('inventory.wh.default')}</Badge>}
                {r.isSaleWarehouse && <Badge tone="info" dot={false}>{t('inventory.wh.sale')}</Badge>}
                {!r.isActive && <Badge dot={false}>{t('inventory.wh.inactive')}</Badge>}
              </span>
            ) },
            { key: 'c', header: t('inventory.wh.code'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.code}</span> },
            { key: 'l', header: t('inventory.wh.location'), hideOnMobile: true, cell: (r) => r.location ?? '—' },
            { key: 'i', header: t('inventory.wh.items'), cell: (r) => <b className="tabular-nums">{r.items}</b> },
            { key: 'v', header: t('inventory.wh.value'), cell: (r) => money(r.value) },
            { key: 'x', header: '', cell: (r) => manage && (
              <span className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                {!r.isDefault && r.isActive && <IconButton size="sm" label={t('inventory.wh.makeDefault')} onClick={() => update.mutate({ id: r.id, body: { isDefault: true } })}><Star className="h-4 w-4" /></IconButton>}
                <IconButton size="sm" label={t('common.edit')} onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></IconButton>
                {!r.isDefault && (r.isActive
                  ? <Button size="sm" variant="ghost" onClick={async () => (await confirm({ message: t('inventory.wh.stopConfirm', { name: r.name }), danger: true })) && update.mutate({ id: r.id, body: { isActive: false } })}>{t('inventory.wh.stop')}</Button>
                  : <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: r.id, body: { isActive: true } })}>{t('inventory.wh.activate')}</Button>)}
              </span>
            ) },
          ]}
        />
      </Card>
      {editing && <WarehouseDialog warehouse={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function WarehouseDialog({ warehouse, onClose }: { warehouse?: Warehouse; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ name: warehouse?.name ?? '', code: warehouse?.code ?? '', location: warehouse?.location ?? '', notes: warehouse?.notes ?? '' });
  const save = useApiMutation(() => {
    const body = { ...v, location: v.location || null, notes: v.notes || null };
    return warehouse ? api.put(`/inventory/warehouses/${warehouse.id}`, body) : api.post('/inventory/warehouses', body);
  }, { invalidate: [['inventory']], onSuccess: onClose });
  const fe = save.fieldErrors;
  return (
    <Dialog open onClose={onClose} size="sm" title={warehouse ? t('inventory.wh.edit') : t('inventory.wh.new')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        <Field label={t('settings.fields.name')} required error={fe.name}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} invalid={!!fe.name} /></Field>
        <Field label={t('inventory.wh.code')} required error={fe.code} hint={t('inventory.wh.codeHint')}><Input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} dir="ltr" invalid={!!fe.code} /></Field>
        <Field label={t('inventory.wh.location')}><Input value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
        <Field label={t('common.notes')}><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
