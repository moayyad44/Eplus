import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { money, num } from '@/lib/format';
import { Button, Card, DataTable, Dialog, Field, Input, PageHeader, Pagination, SearchInput, Textarea } from '@/components/ui';

export interface Supplier { id: string; name: string; phone: string | null; email: string | null; address: string | null; taxNumber: string | null; contactPerson: string | null; notes: string | null; purchases?: number; paid?: number; balance?: number }

export function SupplierDialog({ supplier, onClose }: { supplier?: Supplier; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ name: supplier?.name ?? '', phone: supplier?.phone ?? '', email: supplier?.email ?? '', address: supplier?.address ?? '', taxNumber: supplier?.taxNumber ?? '', contactPerson: supplier?.contactPerson ?? '', notes: supplier?.notes ?? '' });
  const save = useApiMutation(() => (supplier ? api.put(`/suppliers/${supplier.id}`, v) : api.post('/suppliers', v)), { invalidate: [['suppliers']], onSuccess: onClose });
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  return (
    <Dialog open onClose={onClose} title={supplier ? t('suppliers.edit') : t('suppliers.new')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('suppliers.name')} required error={save.fieldErrors.name} className="sm:col-span-2"><Input {...f('name')} /></Field>
        <Field label={t('common.phone')}><Input {...f('phone')} dir="ltr" /></Field>
        <Field label={t('common.email')} error={save.fieldErrors.email}><Input {...f('email')} dir="ltr" /></Field>
        <Field label={t('suppliers.contactPerson')}><Input {...f('contactPerson')} /></Field>
        <Field label={t('suppliers.taxNumber')}><Input {...f('taxNumber')} dir="ltr" /></Field>
        <Field label={t('common.address')} className="sm:col-span-2"><Input {...f('address')} /></Field>
        <Field label={t('common.notes')} className="sm:col-span-2"><Textarea rows={2} {...f('notes')} /></Field>
      </div>
    </Dialog>
  );
}

export default function Suppliers() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const list = usePagedList<Supplier>('suppliers', '/suppliers');
  return (
    <div>
      <PageHeader title={t('suppliers.title')} subtitle={t('suppliers.subtitle')} actions={can('suppliers.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('suppliers.new')}</Button>} />
      <Card>
        <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="mb-4 w-full sm:w-72" />
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/suppliers/${r.id}`)}
          columns={[
            { key: 'n', header: t('suppliers.name'), cell: (r) => <b>{r.name}</b> },
            { key: 'p', header: t('common.phone'), cell: (r) => <span dir="ltr">{r.phone ?? '—'}</span> },
            { key: 'c', header: t('suppliers.contactPerson'), hideOnMobile: true, cell: (r) => r.contactPerson ?? '—' },
            { key: 'pu', header: t('suppliers.purchases'), hideOnMobile: true, cell: (r) => money(r.purchases) },
            { key: 'pa', header: t('suppliers.paid'), hideOnMobile: true, cell: (r) => money(r.paid) },
            { key: 'b', header: t('suppliers.balance'), cell: (r) => <b className={num(r.balance) > 0 ? 'text-danger-600' : ''}>{money(r.balance)}</b> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {open && <SupplierDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
