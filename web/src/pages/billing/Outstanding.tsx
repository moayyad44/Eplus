import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Printer, Wallet } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDate, money, num } from '@/lib/format';
import { Badge, Button, Card, DataTable, IconButton, PageHeader, Pagination, SearchInput, Select, StatCard } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { PaymentDialog } from '@/components/shared/PaymentDialog';

interface Row { id: string; invoiceNumber: string; status: string; issuedAt: string; total: number; paidAmount: number; balance: number; ageDays: number; lastPayment: { paidAt: string; amount: number } | null; patient: { id: string; fullName: string; phone: string }; doctor: { fullName: string } | null }

export default function Outstanding() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const [paying, setPaying] = useState<Row | null>(null);
  const list = usePagedList<Row, { minAgeDays?: number }>('invoices-outstanding', '/billing/invoices/outstanding', { sort: 'issuedAt', order: 'asc' });
  const sums = (list.data as unknown as { sums?: { balance: number; total: number } })?.sums;
  const doExport = async () => {
    const all = await api.get<Paged<Row>>('/billing/invoices/outstanding', { pageSize: 200, ...list.filters });
    exportCsv('outstanding-invoices', [
      { header: t('common.patient'), value: (r) => r.patient.fullName }, { header: t('common.phone'), value: (r) => r.patient.phone },
      { header: t('billing.invoiceNumber'), value: (r) => r.invoiceNumber }, { header: t('common.date'), value: (r) => fmtDate(r.issuedAt) },
      { header: t('common.total'), value: (r) => num(r.total) }, { header: t('common.paid'), value: (r) => num(r.paidAmount) }, { header: t('common.balance'), value: (r) => num(r.balance) },
      { header: t('billing.debtAge'), value: (r) => r.ageDays }, { header: t('common.doctor'), value: (r) => r.doctor?.fullName ?? '' }, { header: t('billing.lastPayment'), value: (r) => fmtDate(r.lastPayment?.paidAt) },
    ], all.items);
  };
  return (
    <div>
      <PageHeader title={t('billing.outstanding')} subtitle={t('billing.outstandingSubtitle')} actions={<Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={doExport}>{t('common.exportCsv')}</Button>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <StatCard label={t('billing.totalOutstanding')} value={money(sums?.balance)} tone="danger" icon={<Wallet className="h-5 w-5" />} />
        <StatCard label={t('billing.invoiceCount')} value={list.data?.total ?? '—'} tone="warning" />
      </div>
      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-72" />
          <Select value={String(list.filters.minAgeDays ?? '')} onChange={(e) => list.setFilters({ minAgeDays: e.target.value ? Number(e.target.value) : undefined })} className="w-auto">
            <option value="">{t('billing.debtAge')}: {t('common.all')}</option>
            {[7, 30, 60, 90].map((d) => <option key={d} value={d}>{t('billing.minAge')} {t('billing.days', { count: d })}</option>)}
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          sort={list.sort}
          onSort={list.setSort}
          onRowClick={(r) => nav(`/billing/invoices/${r.id}`)}
          columns={[
            { key: 'p', header: t('common.patient'), cell: (r) => <><b>{r.patient.fullName}</b><span className="block text-xs text-ink-muted" dir="ltr">{r.patient.phone}</span></> },
            { key: 'n', header: t('billing.invoiceNumber'), cell: (r) => <span className="font-mono text-xs">{r.invoiceNumber}</span> },
            { key: 'issuedAt', header: t('common.date'), sortable: true, cell: (r) => fmtDate(r.issuedAt) },
            { key: 'total', header: t('common.total'), sortable: true, hideOnMobile: true, cell: (r) => money(r.total) },
            { key: 'pa', header: t('common.paid'), hideOnMobile: true, cell: (r) => money(r.paidAmount) },
            { key: 'balance', header: t('common.balance'), sortable: true, cell: (r) => <b className="tabular-nums text-danger-600">{money(r.balance)}</b> },
            { key: 'age', header: t('billing.debtAge'), cell: (r) => <Badge tone={r.ageDays > 60 ? 'danger' : r.ageDays > 30 ? 'warning' : 'neutral'} dot={false}>{t('billing.days', { count: r.ageDays })}</Badge> },
            { key: 'doc', header: t('common.doctor'), hideOnMobile: true, cell: (r) => r.doctor?.fullName ?? '—' },
            { key: 'lp', header: t('billing.lastPayment'), hideOnMobile: true, cell: (r) => (r.lastPayment ? fmtDate(r.lastPayment.paidAt) : '—') },
            { key: 's', header: '', cell: (r) => <StatusBadge enumName="InvoiceStatus" value={r.status} /> },
            {
              key: 'x', header: '', cell: (r) => (
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  {can('payments.create') && <Button size="sm" variant="success" onClick={() => setPaying(r)}>{t('billing.addPayment')}</Button>}
                  <IconButton size="sm" label={t('billing.printInvoice')} onClick={() => window.open(`/print/invoice/${r.id}`, '_blank')}><Printer className="h-4 w-4" /></IconButton>
                </div>
              ),
            },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {paying && <PaymentDialog invoiceId={paying.id} max={num(paying.balance)} onClose={() => { setPaying(null); list.query.refetch(); }} onDone={(pid) => window.open(`/print/receipt/${pid}`, '_blank')} />}
    </div>
  );
}
