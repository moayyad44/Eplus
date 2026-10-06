import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Send } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDate, money, num } from '@/lib/format';
import { useInsuranceCompanies, type ClaimRow } from '@/lib/insurance';
import { Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

const STATUSES = ['DRAFT', 'READY', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED', 'PARTIALLY_PAID', 'PAID', 'CLOSED', 'CANCELLED'];

export default function Claims() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const companies = useInsuranceCompanies();
  const list = usePagedList<ClaimRow, { status?: string; companyId?: string; open?: string }>('insurance-claims', '/insurance/claims', { pageSize: 50 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const sums = (list.data as unknown as { sums?: Record<string, number> })?.sums;
  const submit = useApiMutation(() => api.post('/insurance/claims/submit-batch', { ids: [...sel] }), { invalidate: [['insurance-claims'], ['insurance']], onSuccess: () => setSel(new Set()) });
  const selectable = (r: ClaimRow) => ['DRAFT', 'READY'].includes(r.status);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const doExport = async () => {
    const all = await api.get<Paged<ClaimRow>>('/insurance/claims', { ...list.filters, q: list.q, pageSize: 200 });
    exportCsv('insurance-claims', [
      { header: t('ins.c.number'), value: (r) => r.claimNumber }, { header: t('ins.c.claimDate'), value: (r) => fmtDate(r.createdAt) },
      { header: t('ins.company'), value: (r) => r.company.nameAr }, { header: t('ins.contract'), value: (r) => r.contract.name },
      { header: t('common.patient'), value: (r) => r.patient.fullName }, { header: t('ins.c.member'), value: (r) => r.memberId },
      { header: t('ins.c.invoice'), value: (r) => r.invoice.invoiceNumber ?? '' }, { header: t('ins.c.total'), value: (r) => num(r.totalAmount) },
      { header: t('ins.c.insuranceAmount'), value: (r) => num(r.insuranceAmount) }, { header: t('ins.c.approved'), value: (r) => num(r.approvedAmount) },
      { header: t('ins.c.rejected'), value: (r) => num(r.rejectedAmount) }, { header: t('ins.c.paid'), value: (r) => num(r.paidAmount) },
      { header: t('ins.c.outstanding'), value: (r) => num(r.outstandingAmount) }, { header: t('common.status'), value: (r) => t(`enum.ClaimStatus.${r.status}`) },
    ], all.items);
  };
  return (
    <div>
      <PageHeader title={t('ins.claims')} subtitle={t('ins.claimsSub')}
        actions={
          <>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={doExport}>{t('common.exportCsv')}</Button>
            {can('insurance.claim.submit') && <Button icon={<Send className="h-4 w-4" />} disabled={!sel.size} loading={submit.isPending} onClick={() => submit.mutate(undefined)}>{t('ins.c.submitSelected', { count: sel.size })}</Button>}
          </>
        } />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-64" />
          <Select value={list.filters.companyId ?? ''} onChange={(e) => list.setFilters({ companyId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('ins.company')}: {t('common.all')}</option>
            {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </Select>
          <Select value={list.filters.status ?? ''} onChange={(e) => list.setFilters({ status: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.status')}: {t('common.all')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`enum.ClaimStatus.${s}`)}</option>)}
          </Select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary-600" checked={list.filters.open === 'true'} onChange={(e) => list.setFilters({ open: e.target.checked ? 'true' : undefined })} />{t('ins.c.openOnly')}</label>
        </div>
        {sums && (
          <div className="mb-4 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-5">
            {([['insuranceAmount', 'ins.c.insuranceAmount', 'bg-surface-subtle'], ['approvedAmount', 'ins.c.approved', 'bg-success-50'], ['rejectedAmount', 'ins.c.rejected', 'bg-danger-50'], ['paidAmount', 'ins.c.paid', 'bg-primary-50'], ['outstandingAmount', 'ins.c.outstanding', 'bg-warning-50']] as const).map(([k, label, bg]) => (
              <div key={k} className={`rounded-xl p-2 ${bg}`}><p className="text-xs text-ink-muted">{t(label)}</p><b className="tabular-nums">{money(sums[k] ?? 0)}</b></div>
            ))}
          </div>
        )}
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/insurance/claims/${r.id}`)}
          columns={[
            ...(can('insurance.claim.submit') ? [{ key: 'sel', header: '', cell: (r: ClaimRow) => selectable(r) && <input type="checkbox" className="accent-primary-600" checked={sel.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} /> }] : []),
            { key: 'n', header: t('ins.c.number'), cell: (r) => <span className="font-mono text-xs font-semibold">{r.claimNumber}</span> },
            { key: 'd', header: t('ins.c.claimDate'), cell: (r) => fmtDate(r.createdAt) },
            { key: 'p', header: t('common.patient'), cell: (r) => <><b>{r.patient.fullName}</b><span className="block text-xs text-ink-muted" dir="ltr">{r.memberId}</span></> },
            { key: 'c', header: t('ins.company'), hideOnMobile: true, cell: (r) => r.company.nameAr },
            { key: 'a', header: t('ins.c.insuranceAmount'), cell: (r) => <span className="tabular-nums">{money(r.insuranceAmount)}</span> },
            { key: 'pd', header: t('ins.c.paid'), hideOnMobile: true, cell: (r) => <span className="tabular-nums">{money(r.paidAmount)}</span> },
            { key: 'o', header: t('ins.c.outstanding'), cell: (r) => <b className="tabular-nums">{money(r.outstandingAmount)}</b> },
            { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="ClaimStatus" value={r.status} /> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
