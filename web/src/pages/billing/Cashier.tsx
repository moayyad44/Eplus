import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Banknote, BadgePercent, Printer, ReceiptText, RotateCcw, ShieldCheck, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { Card, CardHeader, DateRangePicker, EmptyState, ErrorState, Button, PageHeader, PageLoader, StatCard, presetRange } from '@/components/ui';
import { BarsChart, ShareBars } from '@/components/shared/charts';

export interface FinanceSummary {
  invoiceCount: number; grossSales: number; discounts: number; tax: number; netSales: number; unpaidFromPeriod: number; collected: number; refunded: number;
  netReceipts: number; expenses: number; netIncome: number; outstandingTotal: number; outstandingCount: number;
  patientBilled: number; insuranceBilled: number; insuranceReceived: number; cashCollected: number; patientReceivables: number; insuranceReceivables: number;
  insuranceApproved: number; insuranceRejected: number; insuranceWrittenOff: number; insuranceTransferred: number;
  byMethod: { methodId: string; name: string; code: string; collected: number; refunded: number; count: number }[];
  daily: { day: string; collected: number; refunded: number }[];
}

export default function Cashier() {
  const { t } = useTranslation();
  const [range, setRange] = useState(presetRange('today'));
  const q = useQuery({ queryKey: ['cashier', range], queryFn: () => api.get<FinanceSummary>('/cashier/summary', { ...range }) });
  const s = q.data;
  return (
    <div>
      <PageHeader title={t('billing.cashier')} subtitle={t('billing.cashierSubtitle')} actions={<Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>} />
      <div className="mb-4"><DateRangePicker value={range} onChange={setRange} /></div>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !s ? <PageLoader /> : (
        <div className="space-y-4">
          <p className="hidden text-sm print:block">{range.from} — {range.to}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('billing.grossSales')} value={money(s.grossSales)} hint={`${t('billing.invoiceCount')}: ${s.invoiceCount}`} icon={<ReceiptText className="h-5 w-5" />} />
            <StatCard label={t('billing.collected')} value={money(s.collected)} tone="success" icon={<Banknote className="h-5 w-5" />} />
            <StatCard label={t('billing.refunds')} value={money(s.refunded)} tone="violet" icon={<RotateCcw className="h-5 w-5" />} />
            <StatCard label={t('billing.netReceipts')} value={money(s.netReceipts)} tone="primary" icon={<Wallet className="h-5 w-5" />} />
            <StatCard label={t('billing.discounts')} value={money(s.discounts)} tone="warning" icon={<BadgePercent className="h-5 w-5" />} />
            <StatCard label={t('billing.unpaid')} value={money(s.unpaidFromPeriod)} tone="danger" hint={`${t('billing.totalOutstanding')}: ${money(s.outstandingTotal)}`} />
            <StatCard label={t('billing.expenses')} value={money(s.expenses)} tone="neutral" icon={<TrendingDown className="h-5 w-5" />} />
            <StatCard label={t('billing.netIncome')} hint={t('billing.ins.netIncomeHint')} value={money(s.netIncome)} tone={s.netIncome >= 0 ? 'success' : 'danger'} icon={<TrendingUp className="h-5 w-5" />} />
          </div>
          <InsuranceFigures s={s} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title={t('billing.byMethod')} />
              {s.byMethod.length ? <ShareBars rows={s.byMethod.map((m) => ({ label: `${m.name} (${m.count})`, value: m.collected - m.refunded }))} format={(v) => money(v)} /> : <EmptyState />}
            </Card>
            <Card>
              <CardHeader title={t('billing.daily')} />
              {s.daily.length ? <BarsChart data={s.daily} x="day" series={[{ key: 'collected', label: t('billing.collected') }]} format={(v) => money(v, false)} xFormat={(d) => d.slice(5)} /> : <EmptyState />}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/** Insurance kept apart: billed to companies, actually received, and still owed — never mixed with patient cash or discounts. */
export function InsuranceFigures({ s }: { s: FinanceSummary }) {
  const { t } = useTranslation();
  if (!s.insuranceBilled && !s.insuranceReceived && !s.insuranceReceivables) return null;
  const cell = (label: string, value: number, tone: string) => (
    <div className={`rounded-xl p-3 ${tone}`}><p className="text-xs text-ink-muted">{label}</p><b className="text-lg tabular-nums">{money(value)}</b></div>
  );
  return (
    <Card>
      <CardHeader title={t('billing.ins.title')} icon={<ShieldCheck className="h-5 w-5" />} subtitle={t('billing.ins.hint')} />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        {cell(t('billing.ins.totalBilled'), s.netSales, 'bg-surface-subtle')}
        {cell(t('billing.ins.patientBilled'), s.patientBilled, 'bg-surface-subtle')}
        {cell(t('billing.ins.insuranceBilled'), s.insuranceBilled, 'bg-primary-50')}
        {cell(t('billing.ins.cashCollected'), s.cashCollected, 'bg-success-50')}
        {cell(t('billing.ins.insuranceReceived'), s.insuranceReceived, 'bg-success-50')}
        {cell(t('billing.ins.patientReceivables'), s.patientReceivables, 'bg-danger-50')}
        {cell(t('billing.ins.insuranceReceivables'), s.insuranceReceivables, 'bg-warning-50')}
        {cell(t('billing.ins.rejected'), s.insuranceRejected, 'bg-danger-50')}
      </div>
      <p className="mt-2 text-xs text-ink-muted">{t('billing.ins.footer', { approved: money(s.insuranceApproved), writtenOff: money(s.insuranceWrittenOff), transferred: money(s.insuranceTransferred) })}</p>
    </Card>
  );
}
