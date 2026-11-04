import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { amt0, monthStart, today, yearStart, type AccountRow } from '@/lib/accounting';
import { Card, ErrorState, PageHeader, PageLoader, StatCard } from '@/components/ui';

/** Real figures from the posted books only; every figure opens the statement behind it. */
export default function AccountingDashboard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const month = useQuery({ queryKey: ['acc', 'accounts', 'month'], queryFn: () => api.get<AccountRow[]>('/accounting/accounts', { from: monthStart(), to: today() }) });
  const year = useQuery({ queryKey: ['acc', 'accounts', 'year'], queryFn: () => api.get<AccountRow[]>('/accounting/accounts', { from: yearStart(), to: today() }) });
  const waiting = useQuery({ queryKey: ['acc', 'waiting'], queryFn: () => api.get<Paged<unknown>>('/accounting/journal', { status: 'DRAFT', pageSize: 1 }) });
  const settings = useQuery({ queryKey: ['acc', 'settings'], queryFn: () => api.get<{ startDate: string | null }>('/accounting/settings') });
  if (month.isLoading || year.isLoading) return <PageLoader />;
  if (month.error || year.error) return <ErrorState error={month.error ?? year.error} />;
  const m = month.data!, y = year.data!;
  const key = (rows: AccountRow[], k: string) => rows.find((r) => r.systemKey === k);
  const root = (rows: AccountRow[], type: string) => rows.find((r) => r.type === type && r.level === 0);
  const pl = (rows: AccountRow[], type: string) => { const r = root(rows, type); return r ? (type === 'REVENUE' ? r.credit - r.debit : r.debit - r.credit) : 0; };
  const open = (r: AccountRow | undefined, from = monthStart()) => r && nav(`/accounting/statement?accountId=${r.id}&from=${from}&to=${today()}`);
  const bal = (k: string) => key(m, k)?.closing ?? 0;
  const tile = (label: string, k: string, tone: 'primary' | 'success' | 'warning' | 'danger' | 'violet' | 'neutral' = 'primary') => <StatCard label={label} value={amt0(bal(k))} tone={tone} onClick={() => open(key(m, k), yearStart())} />;
  const revM = pl(m, 'REVENUE'), expM = pl(m, 'EXPENSE'), revY = pl(y, 'REVENUE'), expY = pl(y, 'EXPENSE');
  const any = y.some((r) => r.debit || r.credit || r.opening);
  return (
    <div>
      <PageHeader title={t('acc.dash.title')} subtitle={t('acc.dash.subtitle')} />
      {!settings.data?.startDate && <p className="mb-3 flex items-center gap-2 rounded-xl bg-primary-50 px-3 py-2 text-sm text-primary-800"><Info className="h-4 w-4" />{t('acc.dash.notStarted')}</p>}
      {!!waiting.data?.total && <button type="button" onClick={() => nav('/accounting/journal')} className="mb-3 flex w-full items-center gap-2 rounded-xl bg-warning-50 px-3 py-2 text-start text-sm font-semibold text-warning-700"><AlertTriangle className="h-4 w-4" />{t('acc.dash.waiting', { n: waiting.data.total })}</button>}
      {!any && <p className="mb-3 rounded-xl bg-surface-subtle px-3 py-2 text-sm text-ink-muted">{t('acc.dash.empty')}</p>}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('acc.dash.revMonth')} value={amt0(revM)} tone="success" onClick={() => open(root(m, 'REVENUE'))} />
        <StatCard label={t('acc.dash.expMonth')} value={amt0(expM)} tone="warning" onClick={() => open(root(m, 'EXPENSE'))} />
        <StatCard label={t('acc.dash.netMonth')} value={amt0(revM - expM)} tone={revM - expM >= 0 ? 'primary' : 'danger'} onClick={() => nav('/accounting/income-statement')} />
        <StatCard label={t('acc.dash.netYear')} value={amt0(revY - expY)} hint={`${t('acc.dash.revYear')}: ${amt0(revY)}`} tone="violet" onClick={() => nav('/accounting/income-statement')} />
      </div>
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tile(t('acc.dash.cash'), 'CASH_GROUP', 'success')}
          {tile(t('acc.dash.banks'), 'BANK_GROUP', 'primary')}
          {tile(t('acc.dash.visa'), 'VISA_CLEARING', 'warning')}
          {tile(t('acc.dash.ar'), 'AR_PATIENTS', 'primary')}
          {tile(t('acc.dash.ins'), 'AR_INSURANCE', 'primary')}
          {tile(t('acc.dash.ap'), 'AP_SUPPLIERS', 'danger')}
          {tile(t('acc.dash.chequesOnHand'), 'CHEQUES_ON_HAND', 'neutral')}
          {tile(t('acc.dash.chequesCollecting'), 'CHEQUES_UNDER_COLLECTION', 'neutral')}
          {tile(t('acc.dash.inventory'), 'INVENTORY', 'violet')}
          {tile(t('acc.dash.fixedAssets'), 'FIXED_ASSETS_GROUP', 'violet')}
        </div>
      </Card>
    </div>
  );
}
