import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, CheckCircle2, Clock, FileStack, HandCoins, Hourglass, Percent, ShieldCheck, Stethoscope, Users, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useInsuranceCompanies } from '@/lib/insurance';
import { Card, CardHeader, DataTable, DateRangePicker, EmptyState, PageHeader, PageLoader, Select, StatCard, presetRange } from '@/components/ui';
import { ShareBars } from '@/components/shared/charts';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Dash {
  insuredPatients: number; insuredVisits: number; expiringSoon: number;
  claims: { total: number; pending: number; approved: number; rejected: number; paid: number; byStatus: { status: string; count: number; amount: number; outstanding: number }[] };
  totals: { billed: number; approved: number; rejected: number; transferred: number; writtenOff: number; received: number; outstanding: number };
  rejectionRate: number; avgCollectionDays: number | null;
  byCompany: { companyId: string; name: string; outstanding: number; billed: number; paid: number; rejected: number }[];
}

export default function InsuranceDashboard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const companies = useInsuranceCompanies();
  const [range, setRange] = useState(presetRange('month'));
  const [companyId, setCompanyId] = useState('');
  const q = useQuery({ queryKey: ['insurance', 'dashboard', range, companyId], queryFn: () => api.get<Dash>('/insurance/reports/dashboard', { ...range, companyId: companyId || undefined }) });
  const d = q.data;
  return (
    <div>
      <PageHeader title={t('ins.dashboard')} subtitle={t('ins.dashboardSub')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-auto">
              <option value="">{t('ins.company')}: {t('common.all')}</option>
              {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
            </Select>
            <DateRangePicker value={range} onChange={setRange} />
          </div>
        } />
      {!d ? <PageLoader /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('ins.d.outstanding')} value={money(d.totals.outstanding)} tone="warning" icon={<HandCoins className="h-5 w-5" />} onClick={() => nav('/insurance/reports')} />
            <StatCard label={t('ins.d.received')} value={money(d.totals.received)} tone="success" icon={<Wallet className="h-5 w-5" />} onClick={() => nav('/insurance/payments')} />
            <StatCard label={t('ins.d.rejectionRate')} value={`${d.rejectionRate}%`} hint={`${t('ins.d.rejected')}: ${money(d.totals.rejected)}`} tone={d.rejectionRate > 10 ? 'danger' : 'neutral'} icon={<Percent className="h-5 w-5" />} />
            <StatCard label={t('ins.d.avgDays')} value={d.avgCollectionDays != null ? t('ins.d.days', { n: d.avgCollectionDays }) : '—'} tone="violet" icon={<Clock className="h-5 w-5" />} />
            <StatCard label={t('ins.d.insuredPatients')} value={d.insuredPatients} hint={`${t('ins.d.expiringSoon')}: ${d.expiringSoon}`} icon={<Users className="h-5 w-5" />} />
            <StatCard label={t('ins.d.insuredVisits')} value={d.insuredVisits} icon={<Stethoscope className="h-5 w-5" />} />
            <StatCard label={t('ins.d.billed')} value={money(d.totals.billed)} hint={`${t('ins.d.approved')}: ${money(d.totals.approved)}`} icon={<ShieldCheck className="h-5 w-5" />} />
            <StatCard label={t('ins.d.totalClaims')} value={d.claims.total} icon={<FileStack className="h-5 w-5" />} onClick={() => nav('/insurance/claims')} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('ins.d.pendingClaims')} value={d.claims.pending} tone="warning" icon={<Hourglass className="h-5 w-5" />} onClick={() => nav('/insurance/claims')} />
            <StatCard label={t('ins.d.approvedClaims')} value={d.claims.approved} tone="primary" icon={<CheckCircle2 className="h-5 w-5" />} />
            <StatCard label={t('ins.d.rejectedClaims')} value={d.claims.rejected} tone="danger" icon={<Ban className="h-5 w-5" />} onClick={() => nav('/insurance/reports?tab=rejected')} />
            <StatCard label={t('ins.d.paidClaims')} value={d.claims.paid} tone="success" icon={<Wallet className="h-5 w-5" />} />
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title={t('ins.d.byCompany')} />
              {d.byCompany.length ? <ShareBars rows={d.byCompany.map((c) => ({ label: c.name, value: c.outstanding }))} format={(v) => money(v)} /> : <EmptyState />}
            </Card>
            <Card>
              <CardHeader title={t('ins.d.byStatus')} />
              <DataTable
                dense
                rows={d.claims.byStatus}
                rowKey={(r) => r.status}
                empty={<EmptyState />}
                columns={[
                  { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="ClaimStatus" value={r.status} /> },
                  { key: 'c', header: t('ins.claims'), cell: (r) => r.count },
                  { key: 'a', header: t('ins.c.insuranceAmount'), cell: (r) => <span className="tabular-nums">{money(r.amount)}</span> },
                  { key: 'o', header: t('ins.c.outstanding'), cell: (r) => <b className="tabular-nums">{money(r.outstanding)}</b> },
                ]}
              />
              <p className="mt-3 text-xs text-ink-muted">{t('ins.d.transferred')}: {money(d.totals.transferred)} · {t('ins.d.writtenOff')}: {money(d.totals.writtenOff)}</p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
