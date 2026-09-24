import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, FilePlus2 } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDate, money, num } from '@/lib/format';
import { Button, Card, DataTable, DateRangePicker, PageHeader, Pagination, SearchInput, Select, presetRange } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { useDoctors } from '@/components/shared/VisitQueueForm';

interface Row { id: string; invoiceNumber: string | null; status: string; createdAt: string; issuedAt: string | null; total: number; paidAmount: number; balance: number; patient: { id: string; fullName: string; phone: string; fileNumber: string }; doctor: { fullName: string } | null; template: { name: string } | null }

export default function Invoices() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const doctors = useDoctors();
  const list = usePagedList<Row, { status?: string; doctorId?: string; from?: string; to?: string }>('invoices', '/billing/invoices', { sort: 'createdAt', filters: presetRange('month') });
  const sums = (list.data as unknown as { sums?: { total: number; paidAmount: number; balance: number } })?.sums;
  const doExport = async () => {
    const all = await api.get<Paged<Row>>('/billing/invoices', { ...list.filters, q: list.q, pageSize: 200 });
    exportCsv('invoices', [
      { header: t('billing.invoiceNumber'), value: (r) => r.invoiceNumber ?? '' }, { header: t('common.date'), value: (r) => fmtDate(r.issuedAt ?? r.createdAt) },
      { header: t('common.patient'), value: (r) => r.patient.fullName }, { header: t('common.doctor'), value: (r) => r.doctor?.fullName ?? '' },
      { header: t('common.total'), value: (r) => num(r.total) }, { header: t('common.paid'), value: (r) => num(r.paidAmount) }, { header: t('common.balance'), value: (r) => num(r.balance) },
      { header: t('common.status'), value: (r) => t(`enum.InvoiceStatus.${r.status}`) },
    ], all.items);
  };
  return (
    <div>
      <PageHeader
        title={t('billing.invoices')}
        subtitle={t('billing.invoicesSubtitle')}
        actions={
          <>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={doExport}>{t('common.exportCsv')}</Button>
            {can('invoices.create') && <Button icon={<FilePlus2 className="h-4 w-4" />} onClick={() => nav('/billing/invoices/new')}>{t('billing.newInvoice')}</Button>}
          </>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-64" />
          <Select value={list.filters.status ?? ''} onChange={(e) => list.setFilters({ status: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.status')}: {t('common.all')}</option>
            {['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED'].map((s) => <option key={s} value={s}>{t(`enum.InvoiceStatus.${s}`)}</option>)}
          </Select>
          <Select value={list.filters.doctorId ?? ''} onChange={(e) => list.setFilters({ doctorId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.doctor')}: {t('common.all')}</option>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
          <DateRangePicker value={{ from: list.filters.from!, to: list.filters.to! }} onChange={(r) => list.setFilters(r)} />
        </div>
        {sums && (
          <div className="mb-4 grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-xl bg-surface-subtle p-2"><p className="text-xs text-ink-muted">{t('common.total')}</p><b className="tabular-nums">{money(sums.total)}</b></div>
            <div className="rounded-xl bg-success-50 p-2"><p className="text-xs text-ink-muted">{t('common.paid')}</p><b className="tabular-nums text-success-700">{money(sums.paidAmount)}</b></div>
            <div className="rounded-xl bg-danger-50 p-2"><p className="text-xs text-ink-muted">{t('common.balance')}</p><b className="tabular-nums text-danger-700">{money(sums.balance)}</b></div>
          </div>
        )}
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/billing/invoices/${r.id}`)}
          sort={list.sort}
          onSort={list.setSort}
          columns={[
            { key: 'invoiceNumber', header: t('billing.invoiceNumber'), sortable: true, cell: (r) => <span className="font-mono text-xs font-semibold">{r.invoiceNumber ?? t('enum.InvoiceStatus.DRAFT')}</span> },
            { key: 'createdAt', header: t('common.date'), sortable: true, cell: (r) => fmtDate(r.issuedAt ?? r.createdAt) },
            { key: 'p', header: t('common.patient'), cell: (r) => <b>{r.patient.fullName}</b> },
            { key: 'doc', header: t('common.doctor'), hideOnMobile: true, cell: (r) => r.doctor?.fullName ?? '—' },
            { key: 'total', header: t('common.total'), sortable: true, cell: (r) => <span className="tabular-nums">{money(r.total)}</span> },
            { key: 'balance', header: t('common.balance'), sortable: true, cell: (r) => <b className={`tabular-nums ${num(r.balance) > 0 ? 'text-danger-600' : ''}`}>{money(r.balance)}</b> },
            { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="InvoiceStatus" value={r.status} /> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
