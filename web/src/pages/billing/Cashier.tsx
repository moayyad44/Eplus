import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Banknote, BadgePercent, Printer, ReceiptText, RotateCcw, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { Card, CardHeader, DateRangePicker, EmptyState, ErrorState, Button, PageHeader, PageLoader, StatCard, presetRange } from '@/components/ui';
import { BarsChart, ShareBars } from '@/components/shared/charts';

export interface FinanceSummary {
  invoiceCount: number; grossSales: number; discounts: number; tax: number; netSales: number; unpaidFromPeriod: number; collected: number; refunded: number;
  netReceipts: number; expenses: number; netIncome: number; outstandingTotal: number; outstandingCount: number;
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
            <StatCard label={t('billing.netIncome')} value={money(s.netIncome)} tone={s.netIncome >= 0 ? 'success' : 'danger'} icon={<TrendingUp className="h-5 w-5" />} />
          </div>
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
