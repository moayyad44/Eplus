import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, IconButton, Input, SearchInput, Select, Textarea, useConfirm, type Column } from '@/components/ui';

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'checkbox' | 'color' | 'time' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
  required?: boolean;
  dir?: 'ltr';
  /** Convert form string → API value and back. */
  toApi?: (v: string | boolean) => unknown;
  fromApi?: (v: unknown) => string | boolean;
  lockOnEdit?: boolean;
  wide?: boolean;
}

type Row = Record<string, unknown> & { isActive?: boolean };

/** Generic settings list editor over /settings/<path>: list, search, add, edit, (de)activate. */
export function CatalogEditor({ path, idKey = 'id', fields, columns, title, searchable }: { path: string; idKey?: string; fields: FieldDef[]; columns: Column<Row>[]; title?: ReactNode; searchable?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const editable = can('settings.manage');
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['catalog', path, 'all', q], queryFn: () => api.get<Row[]>(`/settings/${path}`, { all: 'true', q: q || undefined, limit: 500 }) });
  const [edit, setEdit] = useState<Row | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const open = (row: Row | null) => {
    setEdit(row ?? {});
    setForm(Object.fromEntries(fields.map((f) => {
      const raw = row?.[f.key];
      return [f.key, f.fromApi ? f.fromApi(raw) : f.type === 'checkbox' ? Boolean(raw ?? (f.key === 'isActive' ? true : false)) : raw == null ? '' : String(raw)];
    })));
  };
  const isNew = edit && edit[idKey] === undefined;
  const save = useApiMutation(() => {
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      const v = form[f.key];
      if (f.lockOnEdit && !isNew) continue;
      body[f.key] = f.toApi ? f.toApi(v) : f.type === 'number' ? (v === '' ? undefined : Number(v)) : f.type === 'checkbox' ? Boolean(v) : v === '' ? null : v;
    }
    return isNew ? api.post(`/settings/${path}`, body) : api.put(`/settings/${path}/${encodeURIComponent(String(edit![idKey]))}`, body);
  }, { invalidate: [['catalog']], onSuccess: () => setEdit(null) });
  const remove = useApiMutation((row: Row) => api.del<{ deleted: boolean }>(`/settings/${path}/${encodeURIComponent(String(row[idKey]))}`), {
    invalidate: [['catalog']],
    success: false,
    onSuccess: (r) => (r.deleted ? toast.success(t('settings.deleted')) : toast.info(t('settings.deactivatedInstead'), { duration: 7000 })),
  });
  const askRemove = async (row: Row) => {
    if (await confirm({ message: t('settings.deleteConfirm', { name: String(row.name ?? row.code ?? '') }), danger: true, confirmLabel: t('common.delete') })) remove.mutate(row);
  };
  const rows = list.data?.filter((r) => showInactive || r.isActive !== false);
  const toggle = useApiMutation((row: Row) => api.put(`/settings/${path}/${encodeURIComponent(String(row[idKey]))}`, { isActive: !row.isActive }), { invalidate: [['catalog']], success: false });

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {title && <h3 className="text-base font-bold">{title}</h3>}
        {searchable && <SearchInput value={q} onChange={setQ} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-64" />}
        <Checkbox label={t('common.showInactive')} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        {editable && <Button className="ms-auto" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => open(null)}>{t('settings.add')}</Button>}
      </div>
      <DataTable
        rows={rows}
        loading={list.isFetching}
        error={list.error}
        rowKey={(r) => String(r[idKey])}
        dense
        rowClassName={(r) => (r.isActive === false ? 'opacity-50' : undefined)}
        columns={[
          ...columns,
          { key: '_active', header: t('common.status'), cell: (r) => (editable ? <button title={t('settings.statusHint')} onClick={() => toggle.mutate(r)}><Badge tone={r.isActive === false ? 'neutral' : 'success'}>{r.isActive === false ? t('common.inactive') : t('common.active')}</Badge></button> : <Badge tone={r.isActive === false ? 'neutral' : 'success'}>{r.isActive === false ? t('common.inactive') : t('common.active')}</Badge>) },
          ...(editable ? [{ key: '_e', header: '', cell: (r: Row) => (
            <div className="flex gap-0.5">
              <IconButton size="sm" label={t('common.edit')} onClick={() => open(r)}><Pencil className="h-4 w-4" /></IconButton>
              <IconButton size="sm" label={t('common.delete')} onClick={() => askRemove(r)}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>
            </div>
          ) }] : []),
        ]}
      />
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={isNew ? t('settings.add') : t('common.edit')} footer={<><Button variant="outline" onClick={() => setEdit(null)}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => {
            const v = form[f.key];
            const set = (x: string | boolean) => setForm({ ...form, [f.key]: x });
            const disabled = f.lockOnEdit && !isNew;
            if (f.type === 'checkbox') return <Checkbox key={f.key} label={f.label} checked={Boolean(v)} onChange={(e) => set(e.target.checked)} className="sm:col-span-2" />;
            return (
              <Field key={f.key} label={f.label} required={f.required} error={save.fieldErrors[f.key]} className={f.wide || f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                {f.type === 'select' ? (
                  <Select value={String(v ?? '')} onChange={(e) => set(e.target.value)} disabled={disabled} placeholder={f.required ? undefined : t('common.none')}>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                ) : f.type === 'textarea' ? (
                  <Textarea rows={4} value={String(v ?? '')} onChange={(e) => set(e.target.value)} dir={f.dir} />
                ) : (
                  <Input type={f.type === 'number' ? 'number' : f.type === 'color' ? 'color' : f.type === 'time' ? 'time' : 'text'} step={f.type === 'number' ? 'any' : undefined} value={String(v ?? '')} onChange={(e) => set(e.target.value)} dir={f.dir} disabled={disabled} className={f.type === 'color' ? '!p-1' : ''} />
                )}
              </Field>
            );
          })}
        </div>
      </Dialog>
    </Card>
  );
}
