import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Paperclip, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { useCatalog, useSuppliersLookup } from '@/lib/catalogs';
import { exportCsv } from '@/lib/export';
import { fmtDay, money, num, ymd } from '@/lib/format';
import { Badge, Button, Card, Checkbox, DataTable, DateRangePicker, Dialog, Field, IconButton, Input, PageHeader, Pagination, SearchInput, Select, StatCard, presetRange, useConfirm } from '@/components/ui';
import { usePaymentMethods } from '@/components/shared/PaymentDialog';
import { AttachmentsPanel } from '@/components/shared/Attachments';

interface Row { id: string; amount: number; expenseDate: string; description: string; reference: string | null; voidedAt: string | null; voidReason: string | null; categoryId: string; paymentMethodId: string | null; supplierId: string | null; category: { name: string }; paymentMethod: { name: string } | null; supplier: { id: string; name: string } | null; createdByName: string | null; _count: { attachments: number } }

export default function Expenses() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const cats = useCatalog('expense-categories');
  const list = usePagedList<Row, { from?: string; to?: string; categoryId?: string; includeVoided?: string }>('expenses', '/expenses', { sort: 'expenseDate', filters: presetRange('month') });
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const [files, setFiles] = useState<Row | null>(null);
  const voidIt = useApiMutation((v: { id: string; reason: string }) => api.post(`/expenses/${v.id}/void`, { reason: v.reason }), { invalidate: [['expenses']], success: t('common.done') });
  const sum = (list.data as unknown as { sum?: number })?.sum ?? 0;
  return (
    <div>
      <PageHeader
        title={t('expenses.title')}
        subtitle={t('expenses.subtitle')}
        actions={
          <>
            <Button variant="outline" onClick={() => list.data && exportCsv('expenses', [
              { header: t('expenses.date'), value: (r: Row) => fmtDay(r.expenseDate) }, { header: t('expenses.category'), value: (r) => r.category.name },
              { header: t('expenses.description'), value: (r) => r.description }, { header: t('expenses.amount'), value: (r) => num(r.amount) },
              { header: t('expenses.method'), value: (r) => r.paymentMethod?.name ?? '' }, { header: t('expenses.reference'), value: (r) => r.reference ?? '' },
            ], list.data.items)}>{t('common.exportCsv')}</Button>
            {can('expenses.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ expenseDate: ymd() })}>{t('expenses.new')}</Button>}
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3"><StatCard label={t('expenses.total')} value={money(sum)} tone="warning" /></div>
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-60" />
          <Select value={list.filters.categoryId ?? ''} onChange={(e) => list.setFilters({ categoryId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('expenses.category')}: {t('common.all')}</option>
            {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Checkbox label={t('expenses.includeVoided')} checked={list.filters.includeVoided === 'true'} onChange={(e) => list.setFilters({ includeVoided: e.target.checked ? 'true' : undefined })} />
          <DateRangePicker value={{ from: list.filters.from!, to: list.filters.to! }} onChange={(r) => list.setFilters(r)} />
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          sort={list.sort}
          onSort={list.setSort}
          rowClassName={(r) => (r.voidedAt ? 'opacity-50' : undefined)}
          onRowClick={(r) => !r.voidedAt && can('expenses.manage') && setEdit(r)}
          columns={[
            { key: 'expenseDate', header: t('expenses.date'), sortable: true, cell: (r) => fmtDay(r.expenseDate) },
            { key: 'c', header: t('expenses.category'), cell: (r) => <Badge dot={false}>{r.category.name}</Badge> },
            { key: 'd', header: t('expenses.description'), cell: (r) => <>{r.description}{r.voidedAt && <span className="block text-xs text-danger-700">{t('expenses.voided')}: {r.voidReason}</span>}</> },
            { key: 'amount', header: t('expenses.amount'), sortable: true, cell: (r) => <b className="tabular-nums">{money(r.amount)}</b> },
            { key: 'm', header: t('expenses.method'), hideOnMobile: true, cell: (r) => r.paymentMethod?.name ?? '—' },
            { key: 'u', header: t('expenses.createdBy'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.createdByName ?? ''}</span> },
            {
              key: 'x', header: '', cell: (r) => (
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <IconButton size="sm" label={t('expenses.attachment')} onClick={() => setFiles(r)}><Paperclip className="h-4 w-4" />{r._count.attachments > 0 && <span className="text-[10px]">{r._count.attachments}</span>}</IconButton>
                  {can('expenses.manage') && !r.voidedAt && <IconButton size="sm" label={t('expenses.void')} onClick={async () => { const reason = await confirm({ message: r.description, danger: true, reason: { label: t('expenses.voidReason'), required: true } }); if (reason) voidIt.mutate({ id: r.id, reason }); }}><Ban className="h-4 w-4 text-danger-600" /></IconButton>}
                </div>
              ),
            },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {edit && <ExpenseDialog row={edit} onClose={() => setEdit(null)} />}
      <Dialog open={!!files} onClose={() => setFiles(null)} title={t('expenses.attachment')} subtitle={files?.description}>{files && <AttachmentsPanel expenseId={files.id} />}</Dialog>
    </div>
  );
}

function ExpenseDialog({ row, onClose }: { row: Partial<Row>; onClose: () => void }) {
  const { t } = useTranslation();
  const cats = useCatalog('expense-categories');
  const methods = usePaymentMethods();
  const suppliers = useSuppliersLookup();
  const [v, setV] = useState({
    categoryId: row.categoryId ?? '', amount: row.amount != null ? String(row.amount) : '', expenseDate: row.expenseDate?.slice(0, 10) ?? ymd(), paymentMethodId: row.paymentMethodId ?? '',
    supplierId: row.supplierId ?? '', description: row.description ?? '', reference: row.reference ?? '',
  });
  const save = useApiMutation(() => {
    const body = { ...v, amount: Number(v.amount), paymentMethodId: v.paymentMethodId || null, supplierId: v.supplierId || null };
    return row.id ? api.put(`/expenses/${row.id}`, body) : api.post('/expenses', body);
  }, { invalidate: [['expenses']], onSuccess: onClose });
  const fe = save.fieldErrors;
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  return (
    <Dialog open onClose={onClose} title={row.id ? t('expenses.edit') : t('expenses.new')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('expenses.category')} required error={fe.categoryId}><Select {...f('categoryId')} placeholder={t('common.select')} invalid={!!fe.categoryId}>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={t('expenses.amount')} required error={fe.amount}><Input type="number" step="0.001" {...f('amount')} dir="ltr" invalid={!!fe.amount} /></Field>
        <Field label={t('expenses.date')} required error={fe.expenseDate}><Input type="date" {...f('expenseDate')} /></Field>
        <Field label={t('expenses.method')}><Select {...f('paymentMethodId')} placeholder={t('common.select')}>{methods.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label={t('expenses.description')} required error={fe.description} className="sm:col-span-2"><Input {...f('description')} invalid={!!fe.description} /></Field>
        <Field label={t('expenses.supplier')}><Select {...f('supplierId')} placeholder={t('common.none')}>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label={t('expenses.reference')}><Input {...f('reference')} /></Field>
      </div>
    </Dialog>
  );
}
