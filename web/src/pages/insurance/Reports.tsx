import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Printer } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { exportCsv } from '@/lib/export';
import { fmtDate, money } from '@/lib/format';
import { useInsuranceCompanies } from '@/lib/insurance';
import { Badge, Button, Card, DataTable, DateRangePicker, PageHeader, Select, Tabs, presetRange } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface RecvRow { id: string; claimNumber: string; status: string; company: { nameAr: string }; patient: { fullName: string }; invoice: { invoiceNumber: string | null }; claimDate: string; submittedAt: string | null; amount: number; approved: number; paid: number; rejected: number; outstanding: number; ageDays: number; bucket: string }
interface RejRow { id: string; claimId: string; claimNumber: string; company: { nameAr: string }; patient: { fullName: string }; claimAmount: number; rejected: number; reason: string | null; notes: string | null; rejectedAt: string; userName: string | null; claimStatus: string; resolution: string }
const BUCKETS = ['current', 'd30', 'd60', 'd90', 'd120'];
const BUCKET_TONE: Record<string, string> = { current: 'bg-success-50 text-success-700', d30: 'bg-warning-50 text-warning-700', d60: 'bg-warning-50 text-warning-700', d90: 'bg-danger-50 text-danger-700', d120: 'bg-danger-50 text-danger-700' };

export default function InsuranceReports() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'receivables' | 'rejected') || 'receivables';
  const companies = useInsuranceCompanies();
  const [companyId, setCompanyId] = useState('');
  return (
    <div>
      <PageHeader title={t('ins.reports')}
        actions={<div className="flex gap-2 print:hidden">
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-auto">
            <option value="">{t('ins.company')}: {t('common.all')}</option>
            {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </Select>
          <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
        </div>} />
      <Tabs items={[{ key: 'receivables', label: t('ins.receivables') }, { key: 'rejected', label: t('ins.rejectedReport') }]} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} className="mb-4" />
      {tab === 'receivables' ? <Receivables companyId={companyId} /> : <Rejected companyId={companyId} />}
    </div>
  );
}

function Receivables({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState('');
  const q = useQuery({ queryKey: ['insurance', 'receivables', companyId], queryFn: () => api.get<{ rows: RecvRow[]; buckets: Record<string, number>; total: number }>('/insurance/reports/receivables', { companyId: companyId || undefined }) });
  const rows = (q.data?.rows ?? []).filter((r) => !bucket || r.bucket === bucket);
  return (
    <Card>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-6">
        <button className={clsx('rounded-xl p-2 text-center', !bucket ? 'ring-2 ring-primary-400' : '', 'bg-primary-50')} onClick={() => setBucket('')}>
          <p className="text-[11px] text-ink-muted">{t('common.total')}</p><b className="tabular-nums">{money(q.data?.total ?? 0)}</b>
        </button>
        {BUCKETS.map((b) => (
          <button key={b} className={clsx('rounded-xl p-2 text-center', BUCKET_TONE[b], bucket === b && 'ring-2 ring-primary-400')} onClick={() => setBucket(bucket === b ? '' : b)}>
            <p className="text-[11px]">{t(`ins.r.bucket.${b}`)}</p><b className="tabular-nums">{money(q.data?.buckets[b] ?? 0)}</b>
          </button>
        ))}
      </div>
      <div className="mb-3 flex justify-end print:hidden">
        <Button size="sm" variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('insurance-receivables', [
          { header: t('ins.company'), value: (r: RecvRow) => r.company.nameAr }, { header: t('ins.c.number'), value: (r) => r.claimNumber }, { header: t('common.patient'), value: (r) => r.patient.fullName },
          { header: t('ins.c.claimDate'), value: (r) => fmtDate(r.claimDate) }, { header: t('ins.c.insuranceAmount'), value: (r) => r.amount }, { header: t('ins.c.paid'), value: (r) => r.paid },
          { header: t('ins.c.outstanding'), value: (r) => r.outstanding }, { header: t('ins.r.ageDays'), value: (r) => r.ageDays }, { header: t('ins.r.bucket.current'), value: (r) => t(`ins.r.bucket.${r.bucket}`) },
        ], rows)}>{t('common.exportCsv')}</Button>
      </div>
      <DataTable
        rows={rows}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        columns={[
          { key: 'c', header: t('ins.company'), cell: (r) => r.company.nameAr },
          { key: 'n', header: t('ins.c.number'), cell: (r) => <Link to={`/insurance/claims/${r.id}`} className="font-mono text-xs font-semibold text-primary-700 hover:underline">{r.claimNumber}</Link> },
          { key: 'p', header: t('common.patient'), cell: (r) => r.patient.fullName },
          { key: 'd', header: t('ins.c.claimDate'), cell: (r) => fmtDate(r.submittedAt ?? r.claimDate) },
          { key: 'a', header: t('ins.c.insuranceAmount'), cell: (r) => <span className="tabular-nums">{money(r.amount)}</span> },
          { key: 'pd', header: t('ins.c.paid'), cell: (r) => <span className="tabular-nums">{money(r.paid)}</span> },
          { key: 'o', header: t('ins.c.outstanding'), cell: (r) => <b className="tabular-nums">{money(r.outstanding)}</b> },
          { key: 'g', header: t('ins.r.ageDays'), cell: (r) => <span className={clsx('rounded-lg px-2 py-0.5 text-xs font-semibold', BUCKET_TONE[r.bucket])}>{r.ageDays}</span> },
          { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="ClaimStatus" value={r.status} /> },
        ]}
      />
    </Card>
  );
}

function Rejected({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState(presetRange('month'));
  const q = useQuery({ queryKey: ['insurance', 'rejected', companyId, range], queryFn: () => api.get<{ rows: RejRow[]; total: number }>('/insurance/reports/rejected', { ...range, companyId: companyId || undefined }) });
  const tone = (r: string) => (r === 'OPEN' ? 'danger' : r === 'RESUBMITTED' ? 'info' : r === 'TRANSFERRED' ? 'warning' : 'neutral');
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <span className="rounded-xl bg-danger-50 px-3 py-1.5 text-sm font-bold text-danger-700">{t('ins.c.rejected')}: <span className="tabular-nums">{money(q.data?.total ?? 0)}</span></span>
      </div>
      <DataTable
        rows={q.data?.rows}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        columns={[
          { key: 'c', header: t('ins.company'), cell: (r) => r.company.nameAr },
          { key: 'p', header: t('common.patient'), cell: (r) => r.patient.fullName },
          { key: 'n', header: t('ins.c.number'), cell: (r) => <Link to={`/insurance/claims/${r.claimId}`} className="font-mono text-xs font-semibold text-primary-700 hover:underline">{r.claimNumber}</Link> },
          { key: 'a', header: t('ins.c.insuranceAmount'), cell: (r) => <span className="tabular-nums">{money(r.claimAmount)}</span> },
          { key: 'r', header: t('ins.c.rejected'), cell: (r) => <b className="tabular-nums text-danger-700">{money(r.rejected)}</b> },
          { key: 'why', header: t('common.reason'), cell: (r) => <span className="text-xs">{r.reason}{r.notes && <span className="block text-ink-muted">{r.notes}</span>}</span> },
          { key: 'd', header: t('ins.r.rejectedAt'), cell: (r) => <span className="text-xs">{fmtDate(r.rejectedAt)}<span className="block text-ink-muted">{r.userName}</span></span> },
          { key: 's', header: t('ins.r.resolution'), cell: (r) => <Badge tone={tone(r.resolution) as 'danger'}>{t(`ins.r.res.${r.resolution}`)}</Badge> },
        ]}
      />
    </Card>
  );
}
