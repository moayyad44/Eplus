import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, CalendarClock, Pencil, Printer, Receipt, RotateCcw, Send, ShieldCheck, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtDay, money, num, qty, ymd } from '@/lib/format';
import type { Invoice } from '@/lib/billing';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, ErrorState, Field, IconButton, Input, PageHeader, PageLoader, Textarea, useConfirm } from '@/components/ui';
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
  const [payDate, setPayDate] = useState<{ id: string; receiptNumber: string; current: string } | null>(null);
  // Opened straight after "issue & record payment": print the invoice itself rather than the receipt.
  const [afterIssue, setAfterIssue] = useState(false);
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/billing/invoices/${id}`) });
  const issue = useApiMutation(() => api.post(`/billing/invoices/${id}/issue`), { invalidate: [['invoice', id], ['invoices']] });
  const cancel = useApiMutation((reason: string) => api.post(`/billing/invoices/${id}/cancel`, { reason }), { invalidate: [['invoice', id], ['invoices']], success: t('common.done') });
  const voidPay = useApiMutation((v: { id: string; reason: string }) => api.post(`/billing/payments/${v.id}/void`, { reason: v.reason }), { invalidate: [['invoice', id], ['invoices']], success: t('common.done') });

  useEffect(() => {
    if (params.get('pay') && q.data && num(q.data.balance) > 0 && can('payments.create')) {
      setPayMode('PAYMENT');
      setAfterIssue(true);
      params.delete('pay');
      setParams(params, { replace: true });
    }
  }, [params, q.data, can, setParams]);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const inv = q.data;
  const open = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status);
  const netPaid = num(inv.paidAmount) - num(inv.refundedAmount);
  const insured = inv.payerType === 'INSURANCE';

  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{inv.invoiceNumber ?? t('enum.InvoiceStatus.DRAFT')} <StatusBadge enumName="InvoiceStatus" value={inv.status} /></span>}
        subtitle={<>{inv.template?.name} · {t('billing.invoiceDate')}: {fmtDate(inv.issuedAt ?? inv.createdAt)}{inv.dueDate && ` · ${t('billing.dueDate')}: ${fmtDate(inv.dueDate)}`}</>}
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
                ...(insured ? [
                  { key: 'ins', header: t('ins.inv.insuranceShare'), align: 'end' as const, cell: (r: Invoice['items'][number]) => (
                    <span className="tabular-nums text-primary-700">{money(r.insuranceShare)}{r.coverageNote && <span className="block text-[11px] text-ink-muted">{r.coverageNote}</span>}</span>
                  ) },
                  { key: 'pat', header: t('ins.inv.patientShare'), align: 'end' as const, cell: (r: Invoice['items'][number]) => <b className="tabular-nums">{money(r.patientShare)}</b> },
                ] : []),
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
                      {!r.voidedAt && can('payments.backdate') && <IconButton size="sm" label={t('billing.payDate.edit')} onClick={() => setPayDate({ id: r.id, receiptNumber: r.receiptNumber, current: ymd(new Date(r.paidAt)) })}><CalendarClock className="h-4 w-4" /></IconButton>}
                      {!r.voidedAt && can('payments.void') && <Button size="sm" variant="ghost" onClick={async () => { const reason = await confirm({ message: `${r.receiptNumber} — ${money(r.amount)}`, danger: true, reason: { label: t('billing.voidReason'), required: true } }); if (reason) voidPay.mutate({ id: r.id, reason }); }}>{t('billing.voidPayment')}</Button>}
                    </div>
                  ),
                },
              ]}
            />
            <PaymentDateHistory invoiceId={inv.id} />
          </Card>
        </div>
        <aside className="space-y-4">
          <InvoiceDateCard inv={inv} />
          <Card>
            <CardHeader title={t('billing.patientInfo')} />
            <Link to={`/patients/${inv.patient.id}`} className="text-lg font-bold hover:text-primary-700">{inv.patient.fullName}</Link>
            <p className="text-sm text-ink-muted">#{inv.patient.fileNumber} · <span dir="ltr">{inv.patient.phone}</span></p>
            {inv.doctor && <p className="mt-2 text-sm">{t('common.doctor')}: <b>{inv.doctor.fullName}</b></p>}
            {inv.visit && <p className="text-sm">{t('billing.visit')}: <Link to={`/visits/${inv.visit.id}`} className="font-semibold text-primary-700 hover:underline">{inv.visit.visitNumber}</Link></p>}
          </Card>
          {insured && (
            <Card>
              <CardHeader title={t('ins.title')} icon={<ShieldCheck className="h-5 w-5" />} />
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('ins.company')}</dt><dd className="font-semibold">{inv.insuranceCompany?.nameAr}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('ins.contract')}</dt><dd>{inv.insuranceContract?.name}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('ins.m.memberId')}</dt><dd className="font-mono" dir="ltr">{inv.patientInsurance?.memberId}</dd></div>
                {inv.claim && (
                  <>
                    <div className="flex justify-between gap-2 border-t border-line pt-2"><dt className="text-ink-muted">{t('ins.inv.claimLink')}</dt>
                      <dd>{can('insurance.view') ? <Link to={`/insurance/claims/${inv.claim.id}`} className="font-mono font-semibold text-primary-700 hover:underline">{inv.claim.claimNumber}</Link> : <span className="font-mono">{inv.claim.claimNumber}</span>}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('common.status')}</dt><dd><StatusBadge enumName="ClaimStatus" value={inv.claim.status} /></dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('ins.c.paid')}</dt><dd className="tabular-nums">{money(inv.claim.paidAmount)}</dd></div>
                    {num(inv.claim.rejectedAmount) > 0 && <div className="flex justify-between gap-2 text-danger-700"><dt>{t('ins.c.rejected')}</dt><dd className="tabular-nums">{money(inv.claim.rejectedAmount)}</dd></div>}
                    <div className="flex justify-between gap-2 rounded-lg bg-primary-50 px-2 py-1 font-bold text-primary-800"><dt>{t('ins.inv.receivable')}</dt><dd className="tabular-nums">{money(inv.claim.outstandingAmount)}</dd></div>
                  </>
                )}
              </dl>
            </Card>
          )}
          <Card>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-muted">{t('common.subtotal')}</dt><dd className="tabular-nums">{money(inv.subtotal)}</dd></div>
              {num(inv.discountTotal) > 0 && <div className="flex justify-between"><dt className="text-ink-muted">{t('common.discount')}</dt><dd className="tabular-nums">-{money(inv.discountTotal)}</dd></div>}
              {num(inv.taxTotal) > 0 && <div className="flex justify-between"><dt className="text-ink-muted">{t('common.tax')}</dt><dd className="tabular-nums">{money(inv.taxTotal)}</dd></div>}
              <div className="flex justify-between border-t border-line pt-2 text-base font-bold"><dt>{insured ? t('ins.inv.total') : t('billing.total')}</dt><dd className="tabular-nums">{money(inv.total)}</dd></div>
              {insured && (
                <>
                  <div className="flex justify-between rounded-lg bg-primary-50 px-2 py-1 text-primary-800"><dt>{t('ins.inv.insuranceShare')}</dt><dd className="tabular-nums font-semibold">{money(inv.insuranceShare)}</dd></div>
                  <div className="flex justify-between px-2 font-semibold"><dt>{t('ins.inv.patientShare')}</dt><dd className="tabular-nums">{money(inv.patientShare)}</dd></div>
                  {num(inv.transferredFromInsurance) > 0 && <div className="flex justify-between px-2 text-warning-700"><dt>+ {t('ins.inv.transferred')}</dt><dd className="tabular-nums">{money(inv.transferredFromInsurance)}</dd></div>}
                </>
              )}
              <div className="flex justify-between text-success-700"><dt>{insured ? t('ins.inv.patientPaid') : t('common.paid')}</dt><dd className="tabular-nums">{money(inv.paidAmount)}</dd></div>
              {num(inv.refundedAmount) > 0 && <div className="flex justify-between text-violet-700"><dt>{t('billing.refunded')}</dt><dd className="tabular-nums">-{money(inv.refundedAmount)}</dd></div>}
              <div className={clsx('flex justify-between rounded-xl px-3 py-2 text-lg font-bold', num(inv.balance) > 0 ? 'bg-danger-50 text-danger-700' : 'bg-success-50 text-success-700')}>
                <dt>{insured ? t('ins.inv.patientBalance') : t('common.balance')}</dt><dd className="tabular-nums">{money(inv.balance)}</dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>
      {payDate && <PaymentDateDialog invoiceId={inv.id} {...payDate} onClose={() => setPayDate(null)} />}
      {payMode && (
        <PaymentDialog
          invoiceId={inv.id}
          mode={payMode}
          max={payMode === 'REFUND' ? netPaid : num(inv.balance)}
          onClose={() => { setPayMode(null); setAfterIssue(false); }}
          onDone={(pid) => payMode === 'PAYMENT' && window.open(afterIssue ? `/print/invoice/${inv.id}` : `/print/receipt/${pid}`, '_blank')}
        />
      )}
    </div>
  );
}

/**
 * Invoice date next to the real creation / issue times (kept for audit), the change-date action for users
 * with invoices.backdate (also enforced by the API), and the history of date changes from the audit log.
 */
function InvoiceDateCard({ inv }: { inv: Invoice }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<{ date: string; reason: string } | null>(null);
  const history = useQuery({
    queryKey: ['invoice', inv.id, 'date-history'],
    queryFn: () => api.get<{ id: string; at: string; userName: string | null; oldDate: string | null; newDate: string | null; reason: string | null }[]>(`/billing/invoices/${inv.id}/date-history`),
  });
  const change = useApiMutation((v: { date: string; reason: string }) => api.put<{ oldDate: string; newDate: string }>(`/billing/invoices/${inv.id}/date`, { date: v.date, reason: v.reason || null }), {
    invalidate: [['invoice', inv.id], ['invoices']],
    success: false,
    onSuccess: (r) => { toast.success(t('billing.date.changed', { from: day(r.oldDate), to: day(r.newDate) })); setEdit(null); },
  });
  const current = ymd(new Date(inv.issuedAt ?? inv.createdAt));
  // A YYYY-MM-DD day shown like other dates, isolated so it reads correctly inside Arabic sentences.
  const day = (d: string | null) => (d ? `\u2068${fmtDay(`${d}T00:00:00Z`)}\u2069` : '—');
  const save = async () => {
    if (!edit) return;
    if (await confirm({ message: t('billing.date.confirm', { number: `\u2068${inv.invoiceNumber ?? t('enum.InvoiceStatus.DRAFT')}\u2069`, from: day(current), to: day(edit.date) }), confirmLabel: t('billing.date.save') })) change.mutate(edit);
  };
  const row = (label: string, value: React.ReactNode, strong = false) => (
    <div className="flex justify-between gap-2"><dt className="text-ink-muted">{label}</dt><dd className={strong ? 'font-bold' : 'tabular-nums'}>{value}</dd></div>
  );
  return (
    <Card>
      <CardHeader
        title={t('billing.invoiceDate')}
        icon={<CalendarClock className="h-5 w-5" />}
        actions={inv.status !== 'CANCELLED' && can('invoices.backdate') && <Button size="sm" variant="outline" onClick={() => setEdit({ date: current, reason: '' })}>{t('billing.date.edit')}</Button>}
      />
      <dl className="space-y-2 text-sm">
        {row(t('billing.invoiceDate'), <bdi>{inv.issuedAt ? fmtDate(inv.issuedAt) : t('billing.date.onIssue')}</bdi>, true)}
        {row(t('billing.date.createdAt'), <bdi>{fmtDateTime(inv.createdAt)}</bdi>)}
        {inv.issuedRecordedAt && row(t('billing.date.issuedRecordedAt'), <bdi>{fmtDateTime(inv.issuedRecordedAt)}</bdi>)}
      </dl>
      {!!history.data?.length && (
        <div className="mt-3 border-t border-line pt-2">
          <p className="mb-1 text-xs font-semibold text-ink-muted">{t('billing.date.history')}</p>
          <ul className="space-y-1.5 text-xs">
            {history.data.map((h) => (
              <li key={h.id} className="rounded-lg bg-surface-subtle px-2 py-1.5">
                <span className="tabular-nums">{t('billing.date.fromTo', { from: day(h.oldDate), to: day(h.newDate) })}</span>
                <span className="block text-ink-muted">{h.userName} · <bdi>{fmtDateTime(h.at)}</bdi>{h.reason && ` · ${h.reason}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {edit && (
        <Dialog open onClose={() => setEdit(null)} title={t('billing.date.edit')} footer={<><Button variant="outline" onClick={() => setEdit(null)}>{t('common.cancel')}</Button><Button loading={change.isPending} disabled={!edit.date || edit.date === current} onClick={save}>{t('billing.date.save')}</Button></>}>
          <div className="space-y-3">
            <p className="rounded-xl bg-warning-50 px-3 py-2 text-xs text-warning-800">{t('billing.date.hint')}</p>
            <Field label={t('billing.invoiceDate')} required error={change.fieldErrors.date}><Input type="date" max={ymd()} value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
            <Field label={t('common.reason')}><Textarea rows={2} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

/** A YYYY-MM-DD day shown like other dates, isolated so it reads correctly inside Arabic sentences. */
const isoDay = (d: string | null) => (d ? `\u2068${fmtDay(`${d}T00:00:00Z`)}\u2069` : '—');

/** Changes the date of a recorded receipt (payments.backdate, enforced by the API too), after a confirmation. */
function PaymentDateDialog({ invoiceId, id, receiptNumber, current, onClose }: { invoiceId: string; id: string; receiptNumber: string; current: string; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [v, setV] = useState({ date: current, reason: '' });
  const change = useApiMutation(() => api.put<{ oldDate: string; newDate: string }>(`/billing/payments/${id}/date`, { date: v.date, reason: v.reason || null }), {
    invalidate: [['invoice', invoiceId], ['invoices'], ['cashier'], ['payments']],
    success: false,
    onSuccess: (r) => { toast.success(t('billing.payDate.changed', { number: `\u2068${receiptNumber}\u2069`, from: isoDay(r.oldDate), to: isoDay(r.newDate) })); onClose(); },
  });
  const save = async () => {
    if (await confirm({ message: t('billing.payDate.confirm', { number: `\u2068${receiptNumber}\u2069`, from: isoDay(current), to: isoDay(v.date) }), confirmLabel: t('billing.date.save') })) change.mutate(undefined);
  };
  return (
    <Dialog open onClose={onClose} title={`${t('billing.payDate.edit')} — ${receiptNumber}`} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={change.isPending} disabled={!v.date || v.date === current} onClick={save}>{t('billing.date.save')}</Button></>}>
      <div className="space-y-3">
        <p className="rounded-xl bg-warning-50 px-3 py-2 text-xs text-warning-800">{t('billing.payDate.hint')}</p>
        <Field label={t('billing.paidAtLabel')} required error={change.fieldErrors.date}><Input type="date" max={ymd()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('common.reason')}><Textarea rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

/** Receipt date changes on this invoice, from the append-only audit log. */
function PaymentDateHistory({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['invoice', invoiceId, 'payment-date-history'],
    queryFn: () => api.get<{ id: string; at: string; userName: string | null; receiptNumber: string | null; oldDate: string | null; newDate: string | null; reason: string | null }[]>(`/billing/invoices/${invoiceId}/payment-date-history`),
  });
  if (!q.data?.length) return null;
  return (
    <div className="mt-3 border-t border-line pt-2">
      <p className="mb-1 text-xs font-semibold text-ink-muted">{t('billing.payDate.history')}</p>
      <ul className="space-y-1.5 text-xs">
        {q.data.map((h) => (
          <li key={h.id} className="rounded-lg bg-surface-subtle px-2 py-1.5">
            <b className="font-mono">{h.receiptNumber}</b> · <span className="tabular-nums">{t('billing.date.fromTo', { from: isoDay(h.oldDate), to: isoDay(h.newDate) })}</span>
            <span className="block text-ink-muted">{h.userName} · <bdi>{fmtDateTime(h.at)}</bdi>{h.reason && ` · ${h.reason}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
