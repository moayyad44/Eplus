import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { money, num } from '@/lib/format';
import type { Service } from '@/lib/types';
import type { InvoiceTemplate } from '@/lib/billing';
import { Badge, Button, Card, CardHeader, Checkbox, Dialog, Field, IconButton, Input, PageHeader, PageLoader, Select, Tabs, Textarea } from '@/components/ui';
import { usePermissionCatalog, useRoles } from '../staff/Users';
import { CatalogEditor, type FieldDef } from './CatalogEditor';

type Tab = 'clinic' | 'financial' | 'paymentMethods' | 'templates' | 'services' | 'medical' | 'visitTypes' | 'labTests' | 'diagnoses' | 'drugs' | 'inventory' | 'expenses' | 'shifts' | 'roles';
type SettingsData = Record<string, Record<string, unknown>>;

export default function Settings() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('clinic');
  const keys: Tab[] = ['clinic', 'financial', 'paymentMethods', 'templates', 'services', 'medical', 'visitTypes', 'labTests', 'diagnoses', 'drugs', 'inventory', 'expenses', 'shifts', 'roles'];
  return (
    <div>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <Tabs items={keys.map((k) => ({ key: k, label: t(`settings.tabs.${k}`) }))} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'clinic' && <ClinicTab />}
      {tab === 'financial' && <KeyValueForm settingKey="financial" fields={[['currency', 'text'], ['currencySymbol', 'text'], ['decimals', 'number'], ['defaultTaxRate', 'number'], ['invoicePrefix', 'text'], ['receiptPrefix', 'text'], ['invoiceDueDays', 'number'], ['invoiceFooter', 'textarea'], ['thermalReceipt', 'checkbox']]} ns="financial" />}
      {tab === 'paymentMethods' && <PaymentMethods />}
      {tab === 'templates' && <Templates />}
      {tab === 'services' && <Services />}
      {tab === 'medical' && (
        <div className="space-y-4">
          <KeyValueForm settingKey="medical" fields={[['defaultAppointmentMinutes', 'number'], ['prescriptionFooter', 'textarea']]} ns="medicalS" />
          <KeyValueForm settingKey="attendance" fields={[['graceMinutes', 'number']]} ns="attendanceS" />
        </div>
      )}
      {tab === 'visitTypes' && <VisitTypes />}
      {tab === 'labTests' && <LabTests />}
      {tab === 'diagnoses' && <Diagnoses />}
      {tab === 'drugs' && <Drugs />}
      {tab === 'inventory' && (
        <div className="space-y-4">
          <KeyValueForm settingKey="inventory" fields={[['expiryAlertDays', 'number'], ['defaultMinQuantity', 'number']]} ns="inventoryS" />
          <div className="grid gap-4 lg:grid-cols-2">
            <CatalogEditor path="inventory-categories" title={t('inventory.category')} fields={[{ key: 'name', label: t('settings.fields.name'), required: true }]} columns={[{ key: 'n', header: t('settings.fields.name'), cell: (r) => <b>{String(r.name)}</b> }]} />
            <CatalogEditor path="units" title={t('inventory.unit')} fields={[{ key: 'name', label: t('settings.fields.name'), required: true }, { key: 'symbol', label: t('settings.fields.symbol') }]} columns={[{ key: 'n', header: t('settings.fields.name'), cell: (r) => <b>{String(r.name)}</b> }, { key: 's', header: t('settings.fields.symbol'), cell: (r) => String(r.symbol ?? '') }]} />
          </div>
        </div>
      )}
      {tab === 'expenses' && <CatalogEditor path="expense-categories" fields={[{ key: 'name', label: t('settings.fields.name'), required: true }]} columns={[{ key: 'n', header: t('settings.fields.name'), cell: (r) => <b>{String(r.name)}</b> }]} />}
      {tab === 'shifts' && <Shifts />}
      {tab === 'roles' && <Roles />}
    </div>
  );
}

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsData>('/settings') });
}

function KeyValueForm({ settingKey, fields, ns }: { settingKey: string; fields: [string, 'text' | 'number' | 'textarea' | 'checkbox'][]; ns: string }) {
  const { t } = useTranslation();
  const { can, refresh } = useAuth();
  const s = useSettings();
  const [v, setV] = useState<Record<string, unknown>>({});
  useEffect(() => { if (s.data) setV(s.data[settingKey] ?? {}); }, [s.data, settingKey]);
  const save = useApiMutation(() => api.put(`/settings/${settingKey}`, Object.fromEntries(fields.map(([k, type]) => [k, type === 'number' ? Number(v[k]) : v[k]]))), { invalidate: [['settings']], onSuccess: () => refresh() });
  if (!s.data) return <PageLoader />;
  const editable = can('settings.manage');
  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([k, type]) => type === 'checkbox' ? (
          <Checkbox key={k} className="sm:col-span-2 lg:col-span-3" label={t(`settings.${ns}.${k}`)} checked={Boolean(v[k])} disabled={!editable} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />
        ) : (
          <Field key={k} label={t(`settings.${ns}.${k}`)} error={save.fieldErrors[k]} className={type === 'textarea' ? 'sm:col-span-2 lg:col-span-3' : ''}>
            {type === 'textarea' ? <Textarea rows={2} value={String(v[k] ?? '')} disabled={!editable} onChange={(e) => setV({ ...v, [k]: e.target.value })} /> : <Input type={type} value={String(v[k] ?? '')} disabled={!editable} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}
          </Field>
        ))}
      </div>
      {editable ? <div className="mt-4 flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.saveChanges')}</Button></div> : <p className="mt-3 text-xs text-ink-muted">{t('settings.noEditPermission')}</p>}
    </Card>
  );
}

function ClinicTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [stamp, setStamp] = useState(Date.now());
  const pub = useQuery({ queryKey: ['public-clinic'], queryFn: () => api.get<{ hasLogo: boolean }>('/public/clinic') });
  const upload = async (f: File) => {
    const fd = new FormData();
    fd.append('file', f);
    try {
      await api.upload('/settings/logo', fd);
      toast.success(t('common.saved'));
      setStamp(Date.now());
      qc.invalidateQueries({ queryKey: ['public-clinic'] });
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('settings.clinic.logo')} />
        <div className="flex items-center gap-4">
          {pub.data?.hasLogo ? <img src={`/api/public/logo?${stamp}`} alt="" className="h-16 w-auto rounded-lg bg-surface-subtle" /> : <span className="grid h-16 w-16 place-items-center rounded-lg bg-surface-sunken text-xs text-ink-muted">—</span>}
          {can('settings.manage') && (
            <>
              <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => input.current?.click()}>{t('settings.clinic.uploadLogo')}</Button>
            </>
          )}
        </div>
      </Card>
      <KeyValueForm settingKey="clinic" ns="clinic" fields={[['name', 'text'], ['nameEn', 'text'], ['phone', 'text'], ['email', 'text'], ['website', 'text'], ['taxNumber', 'text'], ['address', 'textarea'], ['workingHours', 'textarea'], ['reportFooter', 'textarea']]} />
    </div>
  );
}

function PaymentMethods() {
  const { t } = useTranslation();
  const f: FieldDef[] = [
    { key: 'code', label: t('settings.fields.code'), required: true, dir: 'ltr', lockOnEdit: true },
    { key: 'name', label: t('settings.fields.name'), required: true },
    { key: 'sortOrder', label: t('settings.fields.order'), type: 'number' },
    { key: 'requiresReference', label: t('settings.fields.requiresReference'), type: 'checkbox' },
  ];
  return <CatalogEditor path="payment-methods" fields={f} columns={[
    { key: 'c', header: t('settings.fields.code'), cell: (r) => <span className="font-mono text-xs">{String(r.code)}</span> },
    { key: 'n', header: t('settings.fields.name'), cell: (r) => <b>{String(r.name)}</b> },
    { key: 'r', header: t('settings.fields.requiresReference'), cell: (r) => (r.requiresReference ? t('common.yes') : t('common.no')) },
  ]} />;
}

const CATS = ['EXAMINATION', 'CONSULTATION', 'PROCEDURE', 'LAB', 'NURSING', 'MEDICATION', 'OTHER'];

function Services() {
  const { t } = useTranslation();
  const items = useQuery({ queryKey: ['inventory', 'lookup-all'], queryFn: () => api.get<Paged<{ id: string; name: string }>>('/inventory/items', { pageSize: 200 }).then((r) => r.items) });
  const f: FieldDef[] = [
    { key: 'code', label: t('settings.fields.code'), required: true, dir: 'ltr' },
    { key: 'name', label: t('settings.fields.name'), required: true },
    { key: 'category', label: t('settings.fields.category'), type: 'select', required: true, options: CATS.map((c) => ({ value: c, label: t(`enum.ServiceCategory.${c}`) })) },
    { key: 'price', label: t('settings.fields.price'), type: 'number', required: true },
    { key: 'taxRate', label: t('settings.fields.taxRate'), type: 'number' },
    { key: 'inventoryItemId', label: t('settings.fields.inventoryItem'), type: 'select', options: (items.data ?? []).map((i) => ({ value: i.id, label: i.name })) },
    { key: 'allowPriceEdit', label: t('settings.fields.allowPriceEdit'), type: 'checkbox' },
  ];
  return <CatalogEditor path="services" searchable fields={f} columns={[
    { key: 'c', header: t('settings.fields.code'), cell: (r) => <span className="font-mono text-xs">{String(r.code)}</span> },
    { key: 'n', header: t('settings.fields.name'), cell: (r) => <b>{String(r.name)}</b> },
    { key: 'cat', header: t('settings.fields.category'), cell: (r) => <Badge dot={false}>{t(`enum.ServiceCategory.${r.category}`)}</Badge> },
    { key: 'p', header: t('settings.fields.price'), cell: (r) => <b className="tabular-nums">{money(r.price)}</b> },
    { key: 'inv', header: t('settings.fields.inventoryItem'), hideOnMobile: true, cell: (r) => (r.inventoryItem as { name: string } | null)?.name ?? '—' },
  ]} />;
}

function VisitTypes() {
  const { t } = useTranslation();
  return <CatalogEditor path="visit-types" fields={[
    { key: 'name', label: t('settings.fields.name'), required: true }, { key: 'durationMin', label: t('settings.fields.duration'), type: 'number' },
    { key: 'color', label: t('settings.fields.color'), type: 'color' }, { key: 'sortOrder', label: t('settings.fields.order'), type: 'number' },
  ]} columns={[
    { key: 'n', header: t('settings.fields.name'), cell: (r) => <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: String(r.color ?? '#9dd6f4') }} /><b>{String(r.name)}</b></span> },
    { key: 'd', header: t('settings.fields.duration'), cell: (r) => String(r.durationMin) },
  ]} />;
}

function LabTests() {
  const { t } = useTranslation();
  const services = useQuery({ queryKey: ['catalog', 'services'], queryFn: () => api.get<Service[]>('/settings/services') });
  type P = { name: string; unit?: string; referenceRange?: string };
  const f: FieldDef[] = [
    { key: 'code', label: t('settings.fields.code'), required: true, dir: 'ltr' }, { key: 'name', label: t('settings.fields.name'), required: true },
    { key: 'category', label: t('settings.fields.category') }, { key: 'sampleType', label: t('settings.fields.sampleType') },
    { key: 'unit', label: t('settings.fields.unit'), dir: 'ltr' }, { key: 'referenceRange', label: t('settings.fields.referenceRange'), dir: 'ltr' },
    { key: 'serviceId', label: t('settings.fields.service'), type: 'select', wide: true, options: (services.data ?? []).filter((s) => s.category === 'LAB').map((s) => ({ value: s.id, label: `${s.name} — ${money(s.price)}` })) },
    {
      key: 'parameters', label: t('settings.fields.parameters'), type: 'textarea', dir: 'ltr',
      fromApi: (v) => ((v as P[] | null) ?? []).map((p) => [p.name, p.unit ?? '', p.referenceRange ?? ''].join(' | ')).join('\n'),
      toApi: (v) => { const rows = String(v).split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0]); return rows.length ? rows.map(([name, unit, referenceRange]) => ({ name, unit: unit || undefined, referenceRange: referenceRange || undefined })) : null; },
    },
  ];
  return <CatalogEditor path="lab-tests" searchable fields={f} columns={[
    { key: 'c', header: t('settings.fields.code'), cell: (r) => <span className="font-mono text-xs">{String(r.code)}</span> },
    { key: 'n', header: t('settings.fields.name'), cell: (r) => <b>{String(r.name)}</b> },
    { key: 's', header: t('settings.fields.sampleType'), cell: (r) => String(r.sampleType ?? '—') },
    { key: 'p', header: t('settings.fields.service'), cell: (r) => { const s = r.service as { name: string; price: number } | null; return s ? `${money(s.price)}` : '—'; } },
    { key: 'pp', header: t('settings.fields.parameters'), hideOnMobile: true, cell: (r) => ((r.parameters as P[] | null)?.length ?? 0) || '—' },
  ]} />;
}

function Diagnoses() {
  const { t } = useTranslation();
  return <CatalogEditor path="diagnosis-codes" idKey="code" searchable fields={[
    { key: 'code', label: 'ICD-10', required: true, dir: 'ltr', lockOnEdit: true }, { key: 'name', label: t('settings.fields.name'), required: true, dir: 'ltr' }, { key: 'nameAr', label: t('settings.fields.nameAr') },
  ]} columns={[
    { key: 'c', header: 'ICD-10', cell: (r) => <b className="font-mono" dir="ltr">{String(r.code)}</b> },
    { key: 'n', header: t('settings.fields.name'), cell: (r) => <span dir="ltr">{String(r.name)}</span> },
    { key: 'a', header: t('settings.fields.nameAr'), cell: (r) => String(r.nameAr ?? '') },
  ]} />;
}

function Drugs() {
  const { t } = useTranslation();
  const keys = ['name', 'genericName', 'form', 'strength', 'defaultDose', 'defaultFrequency', 'defaultRoute'];
  return <CatalogEditor path="drugs" searchable fields={keys.map((k) => ({ key: k, label: t(`settings.fields.${k}`), required: k === 'name', dir: ['name', 'genericName', 'strength'].includes(k) ? 'ltr' as const : undefined }))} columns={[
    { key: 'n', header: t('settings.fields.name'), cell: (r) => <b dir="ltr">{String(r.name)}</b> },
    { key: 'g', header: t('settings.fields.genericName'), cell: (r) => <span dir="ltr">{String(r.genericName ?? '')}</span> },
    { key: 'd', header: t('settings.fields.defaultDose'), hideOnMobile: true, cell: (r) => String(r.defaultDose ?? '') },
    { key: 'f', header: t('settings.fields.defaultFrequency'), hideOnMobile: true, cell: (r) => String(r.defaultFrequency ?? '') },
  ]} />;
}

function Shifts() {
  const { t } = useTranslation();
  return <CatalogEditor path="shifts" fields={[
    { key: 'name', label: t('settings.fields.name'), required: true },
    { key: 'type', label: t('settings.fields.type'), type: 'select', required: true, options: ['MORNING', 'EVENING', 'NIGHT', 'CUSTOM'].map((x) => ({ value: x, label: t(`enum.ShiftType.${x}`) })) },
    { key: 'startTime', label: t('settings.fields.startTime'), type: 'time', required: true }, { key: 'endTime', label: t('settings.fields.endTime'), type: 'time', required: true },
    { key: 'color', label: t('settings.fields.color'), type: 'color' },
  ]} columns={[
    { key: 'n', header: t('settings.fields.name'), cell: (r) => <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: String(r.color ?? '#9dd6f4') }} /><b>{String(r.name)}</b></span> },
    { key: 't', header: t('settings.fields.type'), cell: (r) => t(`enum.ShiftType.${r.type}`) },
    { key: 'h', header: t('common.time'), cell: (r) => <span dir="ltr">{String(r.startTime)} – {String(r.endTime)}</span> },
  ]} />;
}

function Templates() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['catalog', 'invoice-templates', 'all'], queryFn: () => api.get<InvoiceTemplate[]>('/settings/invoice-templates', { all: 'true' }) });
  const services = useQuery({ queryKey: ['catalog', 'services'], queryFn: () => api.get<Service[]>('/settings/services') });
  const [edit, setEdit] = useState<{ id?: string; name: string; description: string; isDefault: boolean; isActive: boolean; items: { serviceId: string; quantity: number; isMandatory: boolean }[] } | null>(null);
  const save = useApiMutation(() => (edit!.id ? api.put(`/settings/invoice-templates/${edit!.id}`, edit) : api.post('/settings/invoice-templates', edit)), { invalidate: [['catalog']], onSuccess: () => setEdit(null) });
  const editable = can('settings.manage');
  return (
    <div className="space-y-4">
      <p className="rounded-2xl bg-primary-50 px-4 py-3 text-sm text-primary-800">{t('settings.templates.hint')}</p>
      {editable && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', description: '', isDefault: false, isActive: true, items: [] })}>{t('settings.templates.new')}</Button>}
      <div className="grid gap-4 lg:grid-cols-2">
        {list.data?.map((tpl) => (
          <Card key={tpl.id} className={tpl.isActive ? '' : 'opacity-50'}>
            <CardHeader
              title={<span className="flex items-center gap-2">{tpl.name}{tpl.isDefault && <Badge tone="primary">{t('settings.templates.isDefault')}</Badge>}</span>}
              subtitle={tpl.description}
              actions={editable && <Button size="sm" variant="outline" onClick={() => setEdit({ id: tpl.id, name: tpl.name, description: tpl.description ?? '', isDefault: tpl.isDefault, isActive: tpl.isActive, items: tpl.items.map((i) => ({ serviceId: i.serviceId, quantity: num(i.quantity), isMandatory: i.isMandatory })) })}>{t('common.edit')}</Button>}
            />
            {tpl.items.length ? (
              <ul className="space-y-1 text-sm">{tpl.items.map((i) => <li key={i.id} className="flex justify-between"><span>{i.service.name} × {num(i.quantity)} {i.isMandatory && <Badge tone="primary" dot={false}>{t('settings.templates.mandatory')}</Badge>}</span><span className="tabular-nums">{money(i.service.price)}</span></li>)}</ul>
            ) : <p className="text-sm text-ink-muted">—</p>}
          </Card>
        ))}
      </div>
      {edit && (
        <Dialog open onClose={() => setEdit(null)} size="lg" title={edit.id ? t('common.edit') : t('settings.templates.new')} footer={<><Button variant="outline" onClick={() => setEdit(null)}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
          <div className="space-y-3">
            <Field label={t('settings.templates.name')} required error={save.fieldErrors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={t('common.description')}><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <div className="flex gap-6">
              <Checkbox label={t('settings.templates.isDefault')} checked={edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} />
              <Checkbox label={t('common.active')} checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} />
            </div>
            <p className="text-sm font-bold">{t('settings.templates.items')}</p>
            {edit.items.map((it, i) => (
              <div key={i} className="grid grid-cols-[1fr_90px_auto_auto] items-center gap-2">
                <Select value={it.serviceId} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, serviceId: e.target.value } : x)) })} placeholder={t('common.select')}>
                  {services.data?.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price)}</option>)}
                </Select>
                <Input type="number" min={1} value={it.quantity} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)) })} />
                <Checkbox label={t('settings.templates.mandatory')} checked={it.isMandatory} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, isMandatory: e.target.checked } : x)) })} />
                <IconButton label={t('common.remove')} onClick={() => setEdit({ ...edit, items: edit.items.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>
              </div>
            ))}
            <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ ...edit, items: [...edit.items, { serviceId: '', quantity: 1, isMandatory: true }] })}>{t('settings.templates.addItem')}</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Roles() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const [edit, setEdit] = useState<{ id?: string; key: string; name: string; description: string; permissions: string[]; isSystem?: boolean } | null>(null);
  const save = useApiMutation(() => (edit!.id ? api.put(`/roles/${edit!.id}`, edit) : api.post('/roles', edit)), { invalidate: [['roles'], ['me']], onSuccess: () => setEdit(null) });
  const del = useApiMutation((id: string) => api.del(`/roles/${id}`), { invalidate: [['roles']], success: t('common.done') });
  const editable = can('roles.manage');
  const modules = [...new Set(catalog.data?.map((p) => p.module))];
  return (
    <div className="space-y-4">
      {editable && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ key: '', name: '', description: '', permissions: [] })}>{t('settings.roles.new')}</Button>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {roles.data?.map((r) => (
          <Card key={r.id}>
            <CardHeader
              title={<span className="flex items-center gap-2">{r.name}{(r as { isSystem?: boolean }).isSystem && <Badge tone="info" dot={false}>{t('settings.roles.system')}</Badge>}</span>}
              subtitle={`${t('settings.roles.permissionsCount', { count: r.permissions.length })} · ${(r as { userCount?: number }).userCount ?? 0} ${t('settings.roles.users')}`}
              actions={editable && (
                <>
                  <Button size="sm" variant="outline" onClick={() => setEdit({ ...r, description: (r as { description?: string }).description ?? '', isSystem: (r as { isSystem?: boolean }).isSystem })}>{t('common.edit')}</Button>
                  {!(r as { isSystem?: boolean }).isSystem && <IconButton size="sm" label={t('common.delete')} onClick={() => del.mutate(r.id)}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}
                </>
              )}
            />
          </Card>
        ))}
      </div>
      {edit && (
        <Dialog open onClose={() => setEdit(null)} size="xl" title={edit.id ? `${t('common.edit')}: ${edit.name}` : t('settings.roles.new')} footer={<><Button variant="outline" onClick={() => setEdit(null)}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            {!edit.id && <Field label={t('settings.roles.key')} required error={save.fieldErrors.key}><Input value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} dir="ltr" /></Field>}
            <Field label={t('settings.roles.name')} required error={save.fieldErrors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={t('settings.roles.description')}><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {modules.map((m) => {
              const perms = catalog.data!.filter((p) => p.module === m);
              const all = perms.every((p) => edit.permissions.includes(p.key));
              return (
                <div key={m} className="rounded-2xl border border-line p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <b className="text-sm">{t(`settings.modules.${m}`)}</b>
                    <Checkbox label={t('settings.roles.selectAll')} checked={all} onChange={(e) => setEdit({ ...edit, permissions: e.target.checked ? [...new Set([...edit.permissions, ...perms.map((p) => p.key)])] : edit.permissions.filter((k) => !perms.some((p) => p.key === k)) })} />
                  </div>
                  <div className="space-y-1.5">
                    {perms.map((p) => <Checkbox key={p.key} className="w-full" label={<span className="text-xs">{p.description}</span>} checked={edit.permissions.includes(p.key)} onChange={(e) => setEdit({ ...edit, permissions: e.target.checked ? [...edit.permissions, p.key] : edit.permissions.filter((k) => k !== p.key) })} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </Dialog>
      )}
    </div>
  );
}
