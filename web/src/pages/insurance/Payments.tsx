import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Landmark } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money, num, toLocalInput } from '@/lib/format';
import { useInsuranceCompanies, type ClaimRow } from '@/lib/insurance';
import type { PaymentMethod } from '@/lib/types';
import { Badge, Button, Card, DataTable, DateRangePicker, Dialog, Field, Input, PageHeader, Pagination, Select, Textarea, presetRange, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Row { id: string; receiptNumber: string; amount: number; paidAt: string; reference: string | null; notes: string | null; voidedAt: string | null; voidReason: string | null; company: { nameAr: string }; method: { name: string }; _count: { allocations: number } }

export default function InsurancePayments() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const companies = useInsuranceCompanies();
  const [open, setOpen] = useState(false);
  const list = usePagedList<Row, { companyId?: string; from?: string; to?: string }>('insurance-payments', '/insurance/payments', { filters: presetRange('month') });
  const sum = (list.data as unknown as { sum?: number })?.sum ?? 0;
  const voidPay = useApiMutation((v: { id: string; reason: string }) => api.post(`/insurance/payments/${v.id}/void`, { reason: v.reason }), { invalidate: [['insurance-payments'], ['insurance'], ['insurance-claims']], success: t('common.done') });
  return (
    <div>
      <PageHeader title={t('ins.payments')} subtitle={t('ins.paymentsSub')}
        actions={can('insurance.payment.create') && <Button icon={<Landmark className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('ins.newPayment')}</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select value={list.filters.companyId ?? ''} onChange={(e) => list.setFilters({ companyId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('ins.company')}: {t('common.all')}</option>
            {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </Select>
          <DateRangePicker value={{ from: list.filters.from!, to: list.filters.to! }} onChange={(r) => list.setFilters(r)} />
          <span className="ms-auto rounded-xl bg-success-50 px-3 py-1.5 text-sm font-bold text-success-700">{t('common.total')}: <span className="tabular-nums">{money(sum)}</span></span>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          rowClassName={(r) => (r.voidedAt ? 'opacity-50 line-through' : undefined)}
          columns={[
            { key: 'n', header: t('ins.p.receipt'), cell: (r) => <span className="font-mono text-xs font-semibold">{r.receiptNumber}</span> },
            { key: 'd', header: t('ins.p.paidAt'), cell: (r) => fmtDateTime(r.paidAt) },
            { key: 'c', header: t('ins.p.company'), cell: (r) => <b>{r.company.nameAr}</b> },
            { key: 'a', header: t('ins.p.amount'), cell: (r) => <b className="tabular-nums">{money(r.amount)}</b> },
            { key: 'm', header: t('ins.p.method'), hideOnMobile: true, cell: (r) => r.method.name },
            { key: 'r', header: t('ins.p.reference'), hideOnMobile: true, cell: (r) => <span dir="ltr" className="text-xs">{r.reference ?? '—'}</span> },
            { key: 'k', header: t('ins.p.claims'), hideOnMobile: true, cell: (r) => r._count.allocations },
            {
              key: 'x', header: '', cell: (r) => r.voidedAt ? <span className="text-xs text-danger-700 no-underline">{t('ins.p.voided')}: {r.voidReason}</span> : can('insurance.payment.void') && (
                <Button size="sm" variant="ghost" onClick={async () => { const reason = await confirm({ message: `${r.receiptNumber} — ${money(r.amount)}`, danger: true, reason: { label: t('common.reason'), required: true } }); if (reason) voidPay.mutate({ id: r.id, reason }); }}>{t('ins.p.void')}</Button>
              ),
            },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {open && <NewPaymentDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Money from a company, spread over its open claims (oldest first by default). */
export function NewPaymentDialog({ onClose, companyId: initialCompany }: { onClose: () => void; companyId?: string }) {
  const { t } = useTranslation();
  const companies = useInsuranceCompanies();
  const methods = useQuery({ queryKey: ['catalog', 'payment-methods'], queryFn: () => api.get<PaymentMethod[]>('/settings/payment-methods') });
  const [companyId, setCompanyId] = useState(initialCompany ?? '');
  const [v, setV] = useState({ methodId: '', reference: '', notes: '', paidAt: toLocalInput(new Date()), total: '' });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const claims = useQuery({
    queryKey: ['insurance', 'open-claims', companyId],
    queryFn: () => api.get<{ items: ClaimRow[] }>('/insurance/claims', { companyId, open: 'true', pageSize: 200, sort: 'createdAt', order: 'asc' }),
    enabled: !!companyId,
  });
  const rows = [...(claims.data?.items ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  useEffect(() => { if (!v.methodId && methods.data?.length) setV((x) => ({ ...x, methodId: methods.data!.find((m) => m.isActive && m.code !== 'CASH')?.id ?? methods.data![0].id })); }, [methods.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const due = (r: ClaimRow) => num(r.outstandingAmount);
  const autoFill = () => {
    let left = num(v.total);
    const next: Record<string, string> = {};
    for (const r of rows) { const a = Math.min(left, due(r)); if (a > 0) next[r.id] = String(Math.round(a * 1000) / 1000); left -= a; }
    setAlloc(next);
  };
  const totalAllocated = Object.values(alloc).reduce((a, x) => a + num(x), 0);
  const save = useApiMutation(
    () => api.post('/insurance/payments', {
      companyId, methodId: v.methodId, reference: v.reference || null, notes: v.notes || null, paidAt: v.paidAt ? new Date(v.paidAt).toISOString() : null,
      allocations: Object.entries(alloc).filter(([, a]) => num(a) > 0).map(([claimId, amount]) => ({ claimId, amount: num(amount) })),
    }),
    { invalidate: [['insurance-payments'], ['insurance'], ['insurance-claims']], onSuccess: onClose },
  );
  return (
    <Dialog open onClose={onClose} size="xl" title={t('ins.newPayment')}
      footer={<><span className="me-auto text-sm">{t('ins.p.totalAllocated')}: <b className="tabular-nums">{money(totalAllocated)}</b></span><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={!totalAllocated} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('ins.p.company')} required error={save.fieldErrors.companyId}>
          <Select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setAlloc({}); }} placeholder={t('common.select')}>
            {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </Select>
        </Field>
        <Field label={t('ins.p.method')} required>
          <Select value={v.methodId} onChange={(e) => setV({ ...v, methodId: e.target.value })}>{methods.data?.filter((m) => m.isActive).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
        </Field>
        <Field label={t('ins.p.reference')} required={!!methods.data?.find((m) => m.id === v.methodId)?.requiresReference}><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} dir="ltr" /></Field>
        <Field label={t('ins.p.paidAt')}><Input type="datetime-local" value={v.paidAt} onChange={(e) => setV({ ...v, paidAt: e.target.value })} /></Field>
        <Field label={t('ins.p.amount')} hint={t('ins.p.payAll')}>
          <div className="flex gap-2"><Input type="number" min={0} step="0.001" value={v.total} onChange={(e) => setV({ ...v, total: e.target.value })} dir="ltr" /><Button variant="outline" onClick={autoFill} disabled={!rows.length}>{t('ins.p.payAll')}</Button></div>
        </Field>
        <Field label={t('common.notes')}><Textarea rows={1} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
      <p className="mt-3 text-xs text-ink-muted">{t('ins.p.implicitHint')}</p>
      {companyId && (
        !rows.length ? <p className="mt-3 rounded-xl bg-surface-subtle p-3 text-sm text-ink-muted">{t('ins.p.noOpen')}</p> : (
          <div className="mt-3 max-h-[45vh] overflow-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="sticky top-0 bg-white"><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2 text-start">{t('ins.c.number')}</th><th className="p-2 text-start">{t('common.patient')}</th><th className="p-2">{t('ins.c.claimDate')}</th><th className="p-2">{t('common.status')}</th><th className="p-2">{t('ins.p.due')}</th><th className="p-2">{t('ins.p.allocate')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={clsx('border-b border-line', num(alloc[r.id]) > 0 && 'bg-success-50/50')}>
                    <td className="p-2 font-mono text-xs"><Link to={`/insurance/claims/${r.id}`} target="_blank" className="text-primary-700 hover:underline">{r.claimNumber}</Link></td>
                    <td className="p-2">{r.patient.fullName}</td>
                    <td className="p-2 text-center">{fmtDate(r.createdAt)}</td>
                    <td className="p-2 text-center"><StatusBadge enumName="ClaimStatus" value={r.status} /></td>
                    <td className="p-2 text-center tabular-nums">{money(due(r))}</td>
                    <td className="p-2"><Input type="number" min={0} max={due(r)} step="0.001" value={alloc[r.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [r.id]: e.target.value })} className="!h-9 w-28" dir="ltr" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {num(v.total) > 0 && Math.abs(num(v.total) - totalAllocated) > 0.0005 && <Badge tone="warning" className="mt-2">{t('ins.p.totalAllocated')}: {money(totalAllocated)} ≠ {money(v.total)}</Badge>}
    </Dialog>
  );
}
