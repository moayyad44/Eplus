import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDateTime, money, num } from '@/lib/format';
import { Badge, Button, Card, Checkbox, DataTable, DateRangePicker, IconButton, PageHeader, Pagination, SearchInput, Select, presetRange } from '@/components/ui';
import { usePaymentMethods } from '@/components/shared/PaymentDialog';

interface Row { id: string; receiptNumber: string; type: string; amount: number; reference: string | null; paidAt: string; voidedAt: string | null; method: { name: string }; patient: { id: string; fullName: string }; invoice: { id: string; invoiceNumber: string } }

export default function Payments() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const methods = usePaymentMethods();
  const list = usePagedList<Row, { from?: string; to?: string; methodId?: string; type?: string; mine?: string }>('payments', '/billing/payments', { pageSize: 30, filters: presetRange('today') });
  return (
    <div>
      <PageHeader
        title={t('billing.paymentsTitle')}
        subtitle={t('billing.paymentsSubtitle')}
        actions={<Button variant="outline" onClick={() => list.data && exportCsv('payments', [
          { header: t('billing.receiptNumber'), value: (r: Row) => r.receiptNumber }, { header: t('common.date'), value: (r) => fmtDateTime(r.paidAt) },
          { header: t('common.patient'), value: (r) => r.patient.fullName }, { header: t('billing.invoiceNumber'), value: (r) => r.invoice.invoiceNumber },
          { header: t('common.type'), value: (r) => t(`enum.PaymentType.${r.type}`) }, { header: t('common.amount'), value: (r) => num(r.amount) }, { header: t('billing.method'), value: (r) => r.method.name },
          { header: t('billing.reference'), value: (r) => r.reference ?? '' },
        ], list.data.items)}>{t('common.exportCsv')}</Button>}
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-60" />
          <Select value={list.filters.methodId ?? ''} onChange={(e) => list.setFilters({ methodId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('billing.method')}: {t('common.all')}</option>
            {methods.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Select value={list.filters.type ?? ''} onChange={(e) => list.setFilters({ type: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.type')}: {t('common.all')}</option>
            <option value="PAYMENT">{t('enum.PaymentType.PAYMENT')}</option>
            <option value="REFUND">{t('enum.PaymentType.REFUND')}</option>
          </Select>
          {can('cashier.view') && <Checkbox label={t('billing.mine')} checked={list.filters.mine === 'true'} onChange={(e) => list.setFilters({ mine: e.target.checked ? 'true' : undefined })} />}
          <DateRangePicker value={{ from: list.filters.from!, to: list.filters.to! }} onChange={(r) => list.setFilters(r)} />
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/billing/invoices/${r.invoice.id}`)}
          rowClassName={(r) => (r.voidedAt ? 'opacity-50 line-through' : undefined)}
          columns={[
            { key: 'n', header: t('billing.receiptNumber'), cell: (r) => <span className="font-mono text-xs">{r.receiptNumber}</span> },
            { key: 'd', header: t('common.date'), cell: (r) => <span className="text-xs tabular-nums">{fmtDateTime(r.paidAt)}</span> },
            { key: 'p', header: t('common.patient'), cell: (r) => <b>{r.patient.fullName}</b> },
            { key: 'i', header: t('billing.invoiceNumber'), hideOnMobile: true, cell: (r) => <span className="font-mono text-xs">{r.invoice.invoiceNumber}</span> },
            { key: 't', header: t('common.type'), cell: (r) => <Badge tone={r.type === 'REFUND' ? 'violet' : 'success'} dot={false}>{t(`enum.PaymentType.${r.type}`)}</Badge> },
            { key: 'a', header: t('common.amount'), cell: (r) => <b className="tabular-nums">{money(r.amount)}</b> },
            { key: 'm', header: t('billing.method'), cell: (r) => r.method.name },
            { key: 'ref', header: t('billing.reference'), hideOnMobile: true, cell: (r) => <span dir="ltr" className="text-xs">{r.reference ?? '—'}</span> },
            { key: 'x', header: '', cell: (r) => <IconButton size="sm" label={t('billing.printReceipt')} onClick={(e) => { e.stopPropagation(); window.open(`/print/receipt/${r.id}`, '_blank'); }}><Printer className="h-4 w-4" /></IconButton> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
