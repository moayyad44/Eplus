import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { amt0 } from '@/lib/accounting';
import { Card, CardHeader, ErrorState, PageHeader, PageLoader, StatCard } from '@/components/ui';
import { BarsChart, ShareBars } from '@/components/shared/charts';

interface Dash {
  revenue: Record<'today' | 'month' | 'year', number>; expense: Record<'today' | 'month' | 'year', number>;
  balances: Record<'cash' | 'banks' | 'visaClearing' | 'arPatients' | 'arInsurance' | 'ap' | 'salariesPayable' | 'inventory' | 'fixedAssets' | 'chequesOnHand' | 'chequesCollecting' | 'chequesIssued', number>;
  visa: { notReached: number; count: number; fees: number; reached: number };
  cheques: Record<'inReceived' | 'inSafe' | 'collecting' | 'collected' | 'bounced' | 'outUnpaid', number>;
  charts: { months: { month: string; revenue: number; expense: number; profit: number }[]; byMethod: { label: string; value: number }[]; byCategory: { label: string; value: number }[]; byDoctor: { label: string; value: number }[] };
  alerts: { level: 'info' | 'warning' | 'danger'; key: string; n: number; link: string }[]; startDate: string | null;
}

/** Real figures from the books and from EmergencyPlus — every tile and alert opens the screen behind it. */
export default function AccountingDashboard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['acc', 'dashboard'], queryFn: () => api.get<Dash>('/accounting/dashboard'), refetchInterval: 120_000 });
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data!, b = d.balances;
  const icon = { info: Info, warning: AlertTriangle, danger: OctagonAlert };
  const tone = { info: 'bg-primary-50 text-primary-800', warning: 'bg-warning-50 text-warning-700', danger: 'bg-danger-50 text-danger-700' };
  const tile = (k: keyof Dash['balances'], to: string, c: 'primary' | 'success' | 'warning' | 'danger' | 'violet' | 'neutral' = 'primary') => <StatCard key={k} label={t(`ao.dash.b.${k}`)} value={amt0(b[k])} tone={c} onClick={() => nav(to)} />;
  return (
    <div>
      <PageHeader title={t('acc.dash.title')} subtitle={t('acc.dash.subtitle')} />
      {d.alerts.length > 0 && <div className="mb-4 grid gap-2 md:grid-cols-2">{d.alerts.map((a) => { const I = icon[a.level]; return (
        <button key={a.key} type="button" onClick={() => nav(a.link)} className={clsx('flex items-center gap-2 rounded-xl px-3 py-2 text-start text-sm font-semibold', tone[a.level])}><I className="h-4 w-4 shrink-0" />{t(`ao.dash.alert.${a.key}`, { n: a.n })}</button>
      ); })}</div>}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('ao.dash.revToday')} value={amt0(d.revenue.today)} hint={`${t('ao.dash.expToday')}: ${amt0(d.expense.today)}`} tone="success" onClick={() => nav('/accounting/revenue?by=day')} />
        <StatCard label={t('acc.dash.revMonth')} value={amt0(d.revenue.month)} hint={`${t('acc.dash.expMonth')}: ${amt0(d.expense.month)}`} tone="primary" onClick={() => nav('/accounting/income-statement')} />
        <StatCard label={t('acc.dash.netMonth')} value={amt0(d.revenue.month - d.expense.month)} tone={d.revenue.month >= d.expense.month ? 'success' : 'danger'} onClick={() => nav('/accounting/income-statement')} />
        <StatCard label={t('acc.dash.netYear')} value={amt0(d.revenue.year - d.expense.year)} hint={`${t('acc.dash.revYear')}: ${amt0(d.revenue.year)}`} tone="violet" onClick={() => nav('/accounting/income-statement')} />
      </div>
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tile('cash', '/accounting/treasury', 'success')}{tile('banks', '/accounting/treasury', 'primary')}{tile('visaClearing', '/accounting/visa', 'warning')}{tile('arPatients', '/accounting/aging?type=patients')}
          {tile('arInsurance', '/accounting/aging?type=insurance')}{tile('ap', '/accounting/aging?type=suppliers', 'danger')}{tile('salariesPayable', '/accounting/payroll', 'warning')}{tile('chequesOnHand', '/accounting/cheques', 'neutral')}
          {tile('chequesCollecting', '/accounting/cheques?alert=collecting', 'neutral')}{tile('chequesIssued', '/accounting/cheques?tab=OUT', 'neutral')}{tile('inventory', '/accounting/accounts', 'violet')}{tile('fixedAssets', '/accounting/assets', 'violet')}
        </div>
      </Card>
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t('ao.dash.monthly')} />
          {d.charts.months.length ? <BarsChart data={d.charts.months} x="month" series={[{ key: 'revenue', label: t('acc.is.revenue') }, { key: 'expense', label: t('acc.is.expense') }]} format={(v) => amt0(v)} /> : <p className="py-10 text-center text-sm text-ink-muted">{t('acc.dash.empty')}</p>}
        </Card>
        <Card>
          <CardHeader title={t('ao.dash.visa')} />
          <dl className="space-y-2 text-sm">
            <p className="flex justify-between"><span>{t('ao.visa.notReached')}</span><b>{amt0(d.visa.notReached)}</b></p>
            <p className="flex justify-between"><span>{t('ao.visa.reached')}</span><b>{amt0(d.visa.reached)}</b></p>
            <p className="flex justify-between"><span>{t('ao.visa.fees')}</span><b>{amt0(d.visa.fees)}</b></p>
          </dl>
          <CardHeader className="mt-4" title={t('ao.dash.cheques')} />
          <dl className="space-y-2 text-sm">
            {(['inSafe', 'collecting', 'collected', 'bounced', 'outUnpaid'] as const).map((k) => <p key={k} className="flex justify-between"><span>{t(`ao.dash.c.${k}`)}</span><b className={k === 'bounced' && d.cheques[k] ? 'text-danger-700' : ''}>{amt0(d.cheques[k])}</b></p>)}
          </dl>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {(['byMethod', 'byCategory', 'byDoctor'] as const).map((k) => (
          <Card key={k}>
            <CardHeader title={t(`ao.dash.${k}`)} subtitle={t('ao.dash.thisMonth')} />
            {d.charts[k].length ? <ShareBars rows={k === 'byCategory' ? d.charts[k].map((r) => ({ ...r, label: t(`enum.ServiceCategory.${r.label}`, { defaultValue: r.label }) })) : d.charts[k]} format={(v) => amt0(v)} /> : <p className="py-6 text-center text-sm text-ink-muted">—</p>}
          </Card>
        ))}
      </div>
    </div>
  );
}
