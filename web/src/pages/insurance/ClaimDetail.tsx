import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, CheckCircle2, CircleAlert, Printer } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money, num, qty } from '@/lib/format';
import type { ClaimStatus } from '@/lib/insurance';
import { Button, Card, CardHeader, DataTable, Dialog, ErrorState, Field, Input, PageHeader, PageLoader, Select, Textarea, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { AttachmentsPanel } from '@/components/shared/Attachments';

interface ClaimItem { id: string; serviceId: string; description: string; quantity: number; unitPrice: number; totalAmount: number; insuranceAmount: number; approvedAmount: number; rejectedAmount: number; rejectReason: string | null; approvalNumber: string | null; invoiceItem: { coverageNote: string | null; coveragePercent: number | null; authorization: { requestNumber: string; approvalNumber: string | null } | null } }
interface ClaimEvent { id: string; type: string; fromStatus: string | null; toStatus: string | null; dApproved: number; dRejected: number; dPaid: number; dTransferred: number; dWrittenOff: number; dSubmitted: number; dCancelled: number; reason: string | null; notes: string | null; voidedAt: string | null; userName: string | null; createdAt: string }
export interface ClaimDetailData {
  id: string; claimNumber: string; status: ClaimStatus; workflowStatus: ClaimStatus; memberId: string; policyNumber: string | null; diagnosis: string | null;
  totalAmount: number; insuranceAmount: number; patientAmount: number; submittedAmount: number; approvedAmount: number; rejectedAmount: number; paidAmount: number;
  transferredAmount: number; writtenOffAmount: number; pendingAmount: number; outstandingAmount: number; submissionCount: number; submittedAt: string | null; lastPaymentAt: string | null; closedAt: string | null; createdAt: string;
  patient: { id: string; fullName: string; phone: string; fileNumber: string }; company: { id: string; nameAr: string }; contract: { id: string; name: string };
  patientInsurance: { memberId: string; cardNumber: string | null; policyNumber: string | null; subscriberName: string | null; relation: string; endDate: string | null };
  visit: { id: string; visitNumber: string; arrivedAt: string } | null; doctor: { fullName: string; specialty: string | null } | null;
  invoice: { id: string; invoiceNumber: string | null; issuedAt: string | null; total: number; patientShare: number; insuranceShare: number; discountTotal: number; balance: number; status: string };
  items: ClaimItem[]; events: ClaimEvent[]; checks: { key: string; ok: boolean }[];
  allocations: { id: string; amount: number; payment: { id: string; receiptNumber: string; paidAt: string; voidedAt: string | null; reference: string | null } }[];
}

type Action = 'decision' | 'resubmit' | 'transfer' | 'writeOff' | null;

export default function ClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can, canAny } = useAuth();
  const confirm = useConfirm();
  const [action, setAction] = useState<Action>(null);
  const q = useQuery({ queryKey: ['insurance', 'claim', id], queryFn: () => api.get<ClaimDetailData>(`/insurance/claims/${id}`) });
  const inv = [['insurance'], ['insurance-claims'], ['invoice']];
  const step = useApiMutation((v: { path: string; body?: object }) => api.post(`/insurance/claims/${id}/${v.path}`, v.body ?? {}), { invalidate: inv });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const wf = c.workflowStatus;
  const cancelled = c.status === 'CANCELLED';
  const askNote = async (path: string, message: string, required = false) => {
    const r = await confirm({ message, reason: { label: t('common.notes'), required } });
    if (r) step.mutate({ path, body: { notes: r === 'ok' ? null : r } });
  };
  const amount = (label: string, value: number, tone?: string) => (
    <div className={clsx('rounded-xl p-2.5 text-center', tone ?? 'bg-surface-subtle')}><p className="text-[11px] text-ink-muted">{label}</p><b className="tabular-nums">{money(value)}</b></div>
  );

  return (
    <div>
      <Link to="/insurance/claims" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-primary-700 print:hidden"><ArrowRight className="h-3.5 w-3.5 ltr:rotate-180" />{t('ins.claims')}</Link>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{c.claimNumber}</span><StatusBadge enumName="ClaimStatus" value={c.status} /></span>}
        subtitle={`${c.company.nameAr} — ${c.contract.name} · ${t('ins.c.claimDate')} ${fmtDate(c.createdAt)}${c.submittedAt ? ` · ${t('ins.c.submittedAt')} ${fmtDate(c.submittedAt)}` : ''} · ${t('ins.c.submissionCount')}: ${c.submissionCount}`}
        actions={!cancelled && (
          <div className="flex flex-wrap gap-2 print:hidden">
            {wf === 'DRAFT' && can('insurance.claim.create') && <Button variant="outline" onClick={() => askNote('ready', t('ins.c.ready'))}>{t('ins.c.ready')}</Button>}
            {['DRAFT', 'READY'].includes(wf) && can('insurance.claim.submit') && <Button onClick={() => askNote('submit', t('ins.c.submit'))}>{t('ins.c.submit')}</Button>}
            {wf === 'SUBMITTED' && can('insurance.claim.submit') && <Button variant="outline" onClick={() => askNote('review', t('ins.c.review'))}>{t('ins.c.review')}</Button>}
            {['SUBMITTED', 'UNDER_REVIEW', 'RESUBMISSION_REQUIRED'].includes(wf) && num(c.pendingAmount) > 0 && canAny('insurance.claim.approve', 'insurance.claim.reject') && <Button onClick={() => setAction('decision')}>{t('ins.c.decision')}</Button>}
            {num(c.rejectedAmount) > 0 && can('insurance.claim.reject') && wf !== 'RESUBMISSION_REQUIRED' && <Button variant="outline" onClick={() => askNote('resubmission-required', t('ins.c.resubmissionRequired'))}>{t('ins.c.resubmissionRequired')}</Button>}
            {num(c.rejectedAmount) > 0 && can('insurance.claim.resubmit') && <Button variant="outline" onClick={() => setAction('resubmit')}>{t('ins.c.resubmit')}</Button>}
            {num(c.rejectedAmount) > 0 && can('insurance.claim.reject') && <Button variant="outline" onClick={() => setAction('transfer')}>{t('ins.c.transfer')}</Button>}
            {(num(c.rejectedAmount) > 0 || num(c.approvedAmount) > num(c.paidAmount)) && can('insurance.claim.reject') && <Button variant="ghost" onClick={() => setAction('writeOff')}>{t('ins.c.writeOff')}</Button>}
            {num(c.pendingAmount) === 0 && num(c.paidAmount) >= num(c.approvedAmount) && c.status !== 'CLOSED' && canAny('insurance.claim.approve', 'insurance.claim.reject') && (
              <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => askNote('close', `${t('ins.c.close')} — ${t('ins.c.closeHint')}`)}>{t('ins.c.close')}</Button>
            )}
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('ins.c.printForm')}</Button>
          </div>
        )}
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {amount(t('ins.c.total'), c.totalAmount)}
        {amount(t('ins.c.insuranceAmount'), c.insuranceAmount, 'bg-primary-50')}
        {amount(t('ins.c.patientAmount'), c.patientAmount)}
        {amount(t('ins.c.pending'), c.pendingAmount)}
        {amount(t('ins.c.approved'), c.approvedAmount, 'bg-success-50')}
        {amount(t('ins.c.rejected'), c.rejectedAmount, 'bg-danger-50')}
        {amount(t('ins.c.paid'), c.paidAmount, 'bg-success-50')}
        {amount(t('ins.c.outstanding'), c.outstandingAmount, 'bg-warning-50')}
      </div>
      {(num(c.transferredAmount) > 0 || num(c.writtenOffAmount) > 0) && (
        <p className="mb-4 text-sm text-ink-soft">{t('ins.c.transferred')}: <b>{money(c.transferredAmount)}</b> · {t('ins.c.writtenOff')}: <b>{money(c.writtenOffAmount)}</b></p>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title={t('ins.c.services')} />
            <DataTable
              rows={c.items}
              rowKey={(r) => r.id}
              columns={[
                { key: 'd', header: t('ins.c.item'), cell: (r) => <><b>{r.description}</b><span className="block text-[11px] text-ink-muted">{[r.invoiceItem.coverageNote, r.invoiceItem.authorization && `${r.invoiceItem.authorization.requestNumber} ${r.invoiceItem.authorization.approvalNumber ?? ''}`].filter(Boolean).join(' · ')}</span></> },
                { key: 'q', header: t('common.quantity'), cell: (r) => qty(r.quantity) },
                { key: 't', header: t('common.total'), cell: (r) => money(r.totalAmount) },
                { key: 'i', header: t('ins.c.insuranceAmount'), cell: (r) => <b className="tabular-nums">{money(r.insuranceAmount)}</b> },
                { key: 'a', header: t('ins.c.approved'), cell: (r) => <span className="tabular-nums text-success-700">{money(r.approvedAmount)}</span> },
                { key: 'r', header: t('ins.c.rejected'), cell: (r) => <span className="tabular-nums text-danger-700">{num(r.rejectedAmount) ? money(r.rejectedAmount) : '—'}{r.rejectReason && <span className="block text-[11px]">{r.rejectReason}</span>}</span> },
              ]}
            />
          </Card>
          <Card>
            <CardHeader title={t('ins.c.history')} />
            <ol className="space-y-2">
              {c.events.map((e) => {
                const deltas = ([['dApproved', 'ins.c.approved'], ['dRejected', 'ins.c.rejected'], ['dPaid', 'ins.c.paid'], ['dTransferred', 'ins.c.transferred'], ['dWrittenOff', 'ins.c.writtenOff'], ['dSubmitted', 'ins.c.submitted']] as const)
                  .filter(([k]) => num(e[k]) !== 0).map(([k, label]) => `${t(label)} ${num(e[k]) > 0 ? '+' : ''}${money(e[k])}`);
                return (
                  <li key={e.id} className={clsx('rounded-xl border border-line px-3 py-2 text-sm', e.voidedAt && 'opacity-50 line-through')}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <b>{t(`ins.ev.${e.type}`)}{e.voidedAt && ` — ${t('ins.ev.voided')}`}</b>
                      <span className="text-xs text-ink-muted">{fmtDateTime(e.createdAt)} · {t('ins.c.byUser')} {e.userName ?? '—'}</span>
                    </div>
                    {deltas.length > 0 && <p className="text-xs tabular-nums text-ink-soft">{deltas.join(' · ')}</p>}
                    {e.reason && <p className="text-xs text-danger-700">{t('common.reason')}: {e.reason}</p>}
                    {e.notes && <p className="text-xs text-ink-soft">{e.notes}</p>}
                  </li>
                );
              })}
            </ol>
            {!cancelled && canAny('insurance.claim.create', 'insurance.claim.submit', 'insurance.claim.approve', 'insurance.claim.reject') && (
              <Button size="sm" variant="ghost" className="mt-2 print:hidden" onClick={async () => { const r = await confirm({ message: t('ins.c.addNote'), reason: { label: t('ins.c.note'), required: true } }); if (r) step.mutate({ path: 'notes', body: { notes: r } }); }}>{t('ins.c.addNote')}</Button>
            )}
            <p className="mt-3 text-[11px] text-ink-muted">{t('ins.c.protected')}</p>
          </Card>
        </div>
        <aside className="space-y-4">
          <Card>
            <dl className="space-y-1.5 text-sm">
              {([
                [t('common.patient'), <Link key="p" to={`/patients/${c.patient.id}?tab=insurance`} className="font-semibold text-primary-700 hover:underline">{c.patient.fullName}</Link>],
                [t('ins.c.member'), <span key="m" dir="ltr" className="font-mono">{c.memberId}</span>],
                [t('ins.c.policy'), c.policyNumber ?? '—'],
                [t('ins.m.cardNumber'), c.patientInsurance.cardNumber ?? '—'],
                [t('ins.m.subscriberName'), c.patientInsurance.subscriberName ? `${c.patientInsurance.subscriberName} (${t(`ins.relation.${c.patientInsurance.relation}`)})` : t(`ins.relation.${c.patientInsurance.relation}`)],
                [t('common.doctor'), c.doctor?.fullName ?? '—'],
                [t('ins.c.visit'), c.visit ? <Link key="v" to={`/visits/${c.visit.id}`} className="text-primary-700 hover:underline"><bdi>{c.visit.visitNumber}</bdi> · <bdi>{fmtDate(c.visit.arrivedAt)}</bdi></Link> : '—'],
                [t('ins.c.invoice'), <Link key="i" to={`/billing/invoices/${c.invoice.id}`} className="font-mono text-primary-700 hover:underline">{c.invoice.invoiceNumber}</Link>],
                [t('ins.c.diagnosis'), c.diagnosis ?? '—'],
                [t('ins.c.lastPaymentAt'), fmtDate(c.lastPaymentAt)],
              ] as const).map(([k, v]) => <div key={String(k)} className="flex justify-between gap-3"><dt className="text-ink-muted">{k}</dt><dd className="text-end">{v}</dd></div>)}
            </dl>
          </Card>
          <Card>
            <CardHeader title={t('ins.c.checks')} />
            <ul className="space-y-1.5 text-sm">
              {c.checks.map((k) => <li key={k.key} className={clsx('flex items-center gap-2', k.ok ? 'text-success-700' : 'text-warning-700')}>{k.ok ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}{t(`ins.c.check.${k.key}`)}</li>)}
            </ul>
          </Card>
          {c.allocations.length > 0 && (
            <Card>
              <CardHeader title={t('ins.payments')} />
              <ul className="space-y-1.5 text-sm">
                {c.allocations.map((a) => (
                  <li key={a.id} className={clsx('flex justify-between gap-2', a.payment.voidedAt && 'line-through opacity-50')}>
                    <span className="font-mono text-xs"><bdi>{a.payment.receiptNumber}</bdi> · <bdi>{fmtDate(a.payment.paidAt)}</bdi></span><b className="tabular-nums">{money(a.amount)}</b>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="print:hidden"><CardHeader title={t('ins.c.documents')} /><AttachmentsPanel claimId={c.id} compact /></Card>
        </aside>
      </div>

      {action === 'decision' && <DecisionDialog c={c} onClose={() => setAction(null)} />}
      {(action === 'resubmit' || action === 'transfer' || action === 'writeOff') && <AmountDialog c={c} kind={action} onClose={() => setAction(null)} />}
    </div>
  );
}

function DecisionDialog({ c, onClose }: { c: ClaimDetailData; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const left = (i: ClaimItem) => Math.max(0, Math.round((num(i.insuranceAmount) - num(i.approvedAmount)) * 1000) / 1000);
  const [rows, setRows] = useState(c.items.map((i) => ({ id: i.id, approved: String(can('insurance.claim.approve') ? left(i) : 0), rejected: '0', reason: '' })));
  const [approvalNumber, setApprovalNumber] = useState('');
  const [notes, setNotes] = useState('');
  const set = (i: number, p: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const save = useApiMutation(
    () => api.post(`/insurance/claims/${c.id}/decision`, { approvalNumber: approvalNumber || null, notes: notes || null, items: rows.map((r) => ({ claimItemId: r.id, approved: num(r.approved), rejected: num(r.rejected), reason: r.reason || null })) }),
    { invalidate: [['insurance'], ['insurance-claims']], onSuccess: onClose },
  );
  const sum = rows.reduce((a, r) => a + num(r.approved) + num(r.rejected), 0);
  return (
    <Dialog open onClose={onClose} size="xl" title={t('ins.c.decision')} subtitle={`${c.claimNumber} · ${t('ins.c.pending')}: ${money(c.pendingAmount)}`}
      footer={<><span className="me-auto text-sm tabular-nums text-ink-muted">{money(sum)} / {money(c.pendingAmount)}</span><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="mb-3 flex flex-wrap gap-2">
        {can('insurance.claim.approve') && <Button size="sm" variant="outline" onClick={() => setRows(c.items.map((i, k) => ({ ...rows[k], approved: String(left(i)), rejected: '0' })))}>{t('ins.c.approveAll')}</Button>}
        {can('insurance.claim.reject') && <Button size="sm" variant="outline" onClick={() => setRows(c.items.map((i, k) => ({ ...rows[k], approved: '0', rejected: String(left(i)) })))}>{t('ins.c.rejectAll')}</Button>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2 text-start">{t('ins.c.item')}</th><th className="p-2">{t('ins.c.insuranceAmount')}</th><th className="p-2">{t('ins.c.approvedCol')}</th><th className="p-2">{t('ins.c.rejectedCol')}</th><th className="p-2 text-start">{t('ins.c.reasonCol')}</th></tr></thead>
          <tbody>
            {c.items.map((i, k) => (
              <tr key={i.id} className="border-b border-line">
                <td className="p-2 font-semibold">{i.description}</td>
                <td className="p-2 text-center tabular-nums">{money(i.insuranceAmount)}</td>
                <td className="p-2"><Input type="number" min={0} step="0.001" disabled={!can('insurance.claim.approve')} value={rows[k].approved} onChange={(e) => set(k, { approved: e.target.value })} className="!h-9 w-28" dir="ltr" /></td>
                <td className="p-2"><Input type="number" min={0} step="0.001" disabled={!can('insurance.claim.reject')} value={rows[k].rejected} onChange={(e) => set(k, { rejected: e.target.value })} className="!h-9 w-28" dir="ltr" /></td>
                <td className="p-2"><Input value={rows[k].reason} disabled={!num(rows[k].rejected)} onChange={(e) => set(k, { reason: e.target.value })} className="!h-9" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={t('ins.c.companyApproval')}><Input value={approvalNumber} onChange={(e) => setApprovalNumber(e.target.value)} dir="ltr" /></Field>
        <Field label={t('ins.c.companyNotes')}><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function AmountDialog({ c, kind, onClose }: { c: ClaimDetailData; kind: 'resubmit' | 'transfer' | 'writeOff'; onClose: () => void }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<'REJECTED' | 'APPROVED_UNPAID'>(num(c.rejectedAmount) > 0 ? 'REJECTED' : 'APPROVED_UNPAID');
  const max = kind === 'writeOff' && source === 'APPROVED_UNPAID' ? num(c.approvedAmount) - num(c.paidAmount) : num(c.rejectedAmount);
  const [amount, setAmount] = useState(String(Math.round(max * 1000) / 1000));
  const [text, setText] = useState('');
  const path = kind === 'writeOff' ? 'write-off' : kind;
  const save = useApiMutation(
    () => api.post(`/insurance/claims/${c.id}/${path}`, kind === 'resubmit' ? { amount: num(amount) || null, notes: text || null } : { amount: num(amount) || null, reason: text, ...(kind === 'writeOff' && { source }) }),
    { invalidate: [['insurance'], ['insurance-claims'], ['invoice']], onSuccess: onClose },
  );
  const title = { resubmit: t('ins.c.resubmit'), transfer: t('ins.c.transfer'), writeOff: t('ins.c.writeOff') }[kind];
  return (
    <Dialog open onClose={onClose} title={title} subtitle={c.claimNumber}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3">
        {kind === 'writeOff' && (
          <Field label={t('ins.c.writeOffSource')}>
            <Select value={source} onChange={(e) => { const s = e.target.value as typeof source; setSource(s); setAmount(String(s === 'REJECTED' ? num(c.rejectedAmount) : num(c.approvedAmount) - num(c.paidAmount))); }}>
              {num(c.rejectedAmount) > 0 && <option value="REJECTED">{t('ins.c.woRejected')} ({money(c.rejectedAmount)})</option>}
              {num(c.approvedAmount) > num(c.paidAmount) && <option value="APPROVED_UNPAID">{t('ins.c.woApproved')} ({money(num(c.approvedAmount) - num(c.paidAmount))})</option>}
            </Select>
          </Field>
        )}
        <Field label={t('ins.c.amountOptional')} error={save.fieldErrors.amount}><Input type="number" min={0} max={max} step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" /></Field>
        <Field label={kind === 'resubmit' ? t('common.notes') : t('common.reason')} required={kind !== 'resubmit'} error={save.fieldErrors.reason}><Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
