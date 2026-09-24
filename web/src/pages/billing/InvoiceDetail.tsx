import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, Pencil, Printer, Receipt, RotateCcw, Send, Wallet } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money, num, qty } from '@/lib/format';
import type { Invoice } from '@/lib/billing';
import { Badge, Button, Card, CardHeader, DataTable, ErrorState, PageHeader, PageLoader, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { PaymentDialog } from '@/components/shared/PaymentDialog';

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const confirm = useConfirm();
  const [payMode, setPayMode] = useState<'PAYMENT' | 'REFUND' | null>(null);
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/billing/invoices/${id}`) });
  const issue = useApiMutation(() => api.post(`/billing/invoices/${id}/issue`), { invalidate: [['invoice', id], ['invoices']] });
  const cancel = useApiMutation((reason: string) => api.post(`/billing/invoices/${id}/cancel`, { reason }), { invalidate: [['invoice', id], ['invoices']], success: t('common.done') });
  const voidPay = useApiMutation((v: { id: string; reason: string }) => api.post(`/billing/payments/${v.id}/void`, { reason: v.reason }), { invalidate: [['invoice', id], ['invoices']], success: t('common.done') });

  useEffect(() => {
    if (params.get('pay') && q.data && num(q.data.balance) > 0 && can('payments.create')) {
      setPayMode('PAYMENT');
      params.delete('pay');
      setParams(params, { replace: true });
    }
  }, [params, q.data, can, setParams]);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const inv = q.data;
  const open = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status);
  const netPaid = num(inv.paidAmount) - num(inv.refundedAmount);

  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{inv.invoiceNumber ?? t('enum.InvoiceStatus.DRAFT')} <StatusBadge enumName="InvoiceStatus" value={inv.status} /></span>}
        subtitle={<>{inv.template?.name} · {t('billing.issuedAt')}: {fmtDateTime(inv.issuedAt ?? inv.createdAt)}{inv.dueDate && ` · ${t('billing.dueDate')}: ${fmtDate(inv.dueDate)}`}</>}
        actions={
          <>
            {inv.status === 'DRAFT' && can('invoices.update') && <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => nav(`/billing/invoices/${inv.id}/edit`)}>{t('common.edit')}</Button>}
            {inv.status === 'DRAFT' && can('invoices.create') && <Button icon={<Send className="h-4 w-4" />} loading={issue.isPending} onClick={() => issue.mutate(undefined)}>{t('billing.issue')}</Button>}
            {open && can('payments.create') && <Button variant="success" icon={<Wallet className="h-4 w-4" />} onClick={() => setPayMode('PAYMENT')}>{t('billing.addPayment')}</Button>}
            {inv.status !== 'DRAFT' && (
              <>
                <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/print/invoice/${inv.id}`, '_blank')}>{t('billing.printInvoice')}</Button>
                <Button variant="ghost" size="sm" onClick={() => window.open(`/print/invoice/${inv.id}?thermal=1`, '_blank')}>{t('billing.thermal')}</Button>
              </>
            )}
            {netPaid > 0 && can('payments.refund') && inv.status !== 'CANCELLED' && <Button variant="outline" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setPayMode('REFUND')}>{t('billing.refund')}</Button>}
            {inv.status !== 'CANCELLED' && can('invoices.cancel') && (
              <Button
                variant="danger"
                icon={<Ban className="h-4 w-4" />}
                disabled={netPaid > 0}
                title={netPaid > 0 ? t('billing.cancelHasPayments') : undefined}
                onClick={async () => { const r = await confirm({ message: t('billing.cancelInvoice'), danger: true, reason: { label: t('billing.cancelReason'), required: true } }); if (r) cancel.mutate(r); }}
              >
                {t('billing.cancelInvoice')}
              </Button>
            )}
          </>
        }
      />
      {inv.status === 'CANCELLED' && (
        <div className="mb-4 rounded-2xl border border-danger-100 bg-danger-50 px-4 py-3 text-sm text-danger-700">
          {t('billing.cancelled')} — {inv.cancelReason} · {t('billing.cancelledBy')} {inv.cancelledById ? inv.userNames[inv.cancelledById] : ''} · {fmtDateTime(inv.cancelledAt)}
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <DataTable
              rows={inv.items}
              rowKey={(r) => r.id}
              columns={[
                { key: 'd', header: t('billing.service'), cell: (r) => <><b>{r.description}</b>{r.isMandatory && <Badge tone="primary" dot={false} className="ms-2">{t('billing.mandatory')}</Badge>}<span className="block text-xs text-ink-muted">{t(`enum.ServiceCategory.${r.category}`)}</span></> },
                { key: 'q', header: t('common.quantity'), cell: (r) => qty(r.quantity) },
                { key: 'p', header: t('billing.unitPrice'), cell: (r) => money(r.unitPrice) },
                { key: 'di', header: t('common.discount'), cell: (r) => (num(r.discount) ? money(r.discount) : '—') },
                { key: 't', header: t('billing.lineTotal'), align: 'end', cell: (r) => <b className="tabular-nums">{money(r.lineTotal)}</b> },
              ]}
            />
            {inv.notes && <p className="mt-3 text-sm text-ink-soft">{inv.notes}</p>}
          </Card>
          <Card>
            <CardHeader title={t('billing.payments')} icon={<Receipt className="h-5 w-5" />} />
            <DataTable
              rows={inv.payments}
              rowKey={(r) => r.id}
              dense
              empty={<p className="py-4 text-center text-sm text-ink-muted">{t('common.noData')}</p>}
              rowClassName={(r) => (r.voidedAt ? 'opacity-50 line-through' : undefined)}
              columns={[
                { key: 'n', header: t('billing.receiptNumber'), cell: (r) => <span className="font-mono text-xs">{r.receiptNumber}</span> },
                { key: 'type', header: t('common.type'), cell: (r) => <Badge tone={r.type === 'REFUND' ? 'violet' : 'success'} dot={false}>{t(`enum.PaymentType.${r.type}`)}</Badge> },
                { key: 'a', header: t('common.amount'), cell: (r) => <b className={clsx('tabular-nums', r.type === 'REFUND' && 'text-violet-700')}>{r.type === 'REFUND' ? '-' : ''}{money(r.amount)}</b> },
                { key: 'm', header: t('billing.method'), cell: (r) => r.method.name },
                { key: 'ref', header: t('billing.reference'), hideOnMobile: true, cell: (r) => <span dir="ltr" className="text-xs">{r.reference ?? '—'}</span> },
                { key: 'd', header: t('common.date'), hideOnMobile: true, cell: (r) => <span className="text-xs">{fmtDateTime(r.paidAt)}</span> },
                { key: 'u', header: t('billing.receivedBy'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.receivedById ? inv.userNames[r.receivedById] : ''}{r.voidedAt && <span className="block text-danger-700 no-underline">{t('billing.voided')}: {r.voidReason}</span>}</span> },
                {
                  key: 'x', header: '', cell: (r) => (
                    <div className="flex gap-1">
                      {!r.voidedAt && <Button size="sm" variant="ghost" icon={<Printer className="h-3.5 w-3.5" />} onClick={() => window.open(`/print/receipt/${r.id}`, '_blank')}>{t('billing.receipt')}</Button>}
                      {!r.voidedAt && can('payments.void') && <Button size="sm" variant="ghost" onClick={async () => { const reason = await confirm({ message: `${r.receiptNumber} — ${money(r.amount)}`, danger: true, reason: { label: t('billing.voidReason'), required: true } }); if (reason) voidPay.mutate({ id: r.id, reason }); }}>{t('billing.voidPayment')}</Button>}
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </div>
        <aside className="space-y-4">
          <Card>
            <CardHeader title={t('billing.patientInfo')} />
            <Link to={`/patients/${inv.patient.id}`} className="text-lg font-bold hover:text-primary-700">{inv.patient.fullName}</Link>
            <p className="text-sm text-ink-muted">#{inv.patient.fileNumber} · <span dir="ltr">{inv.patient.phone}</span></p>
            {inv.doctor && <p className="mt-2 text-sm">{t('common.doctor')}: <b>{inv.doctor.fullName}</b></p>}
            {inv.visit && <p className="text-sm">{t('billing.visit')}: <Link to={`/visits/${inv.visit.id}`} className="font-semibold text-primary-700 hover:underline">{inv.visit.visitNumber}</Link></p>}
          </Card>
          <Card>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-muted">{t('common.subtotal')}</dt><dd className="tabular-nums">{money(inv.subtotal)}</dd></div>
              {num(inv.discountTotal) > 0 && <div className="flex justify-between"><dt className="text-ink-muted">{t('common.discount')}</dt><dd className="tabular-nums">-{money(inv.discountTotal)}</dd></div>}
              {num(inv.taxTotal) > 0 && <div className="flex justify-between"><dt className="text-ink-muted">{t('common.tax')}</dt><dd className="tabular-nums">{money(inv.taxTotal)}</dd></div>}
              <div className="flex justify-between border-t border-line pt-2 text-base font-bold"><dt>{t('billing.total')}</dt><dd className="tabular-nums">{money(inv.total)}</dd></div>
              <div className="flex justify-between text-success-700"><dt>{t('common.paid')}</dt><dd className="tabular-nums">{money(inv.paidAmount)}</dd></div>
              {num(inv.refundedAmount) > 0 && <div className="flex justify-between text-violet-700"><dt>{t('billing.refunded')}</dt><dd className="tabular-nums">-{money(inv.refundedAmount)}</dd></div>}
              <div className={clsx('flex justify-between rounded-xl px-3 py-2 text-lg font-bold', num(inv.balance) > 0 ? 'bg-danger-50 text-danger-700' : 'bg-success-50 text-success-700')}>
                <dt>{t('common.balance')}</dt><dd className="tabular-nums">{money(inv.balance)}</dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>
      {payMode && (
        <PaymentDialog
          invoiceId={inv.id}
          mode={payMode}
          max={payMode === 'REFUND' ? netPaid : num(inv.balance)}
          onClose={() => setPayMode(null)}
          onDone={(pid) => payMode === 'PAYMENT' && window.open(`/print/receipt/${pid}`, '_blank')}
        />
      )}
    </div>
  );
}
