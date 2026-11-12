import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { AlertTriangle, Info, OctagonAlert, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { usePref } from '@/lib/hooks';
import { api } from '@/lib/api';
import { amt0 } from '@/lib/accounting';
import { Button, Card, CardHeader, Checkbox, Dialog, ErrorState, PageHeader, PageLoader, StatCard } from '@/components/ui';
import { BarsChart, ShareBars } from '@/components/shared/charts';

interface Dash {
  revenue: Record<'today' | 'month' | 'year', number>; expense: Record<'today' | 'month' | 'year', number>;
  balances: Record<'cash' | 'banks' | 'visaClearing' | 'arPatients' | 'arInsurance' | 'ap' | 'salariesPayable' | 'inventory' | 'fixedAssets' | 'chequesOnHand' | 'chequesCollecting' | 'chequesIssued', number>;
  visa: { notReached: number; count: number; fees: number; reached: number };
  cheques: Record<'inReceived' | 'inSafe' | 'collecting' | 'collected' | 'bounced' | 'outUnpaid', number>;
  charts: { months: { month: string; revenue: number; expense: number; profit: number }[]; byMethod: { label: string; value: number }[]; byCategory: { label: string; value: number }[]; byDoctor: { label: string; value: number }[] };
  alerts: { level: 'info' | 'warning' | 'danger'; key: string; n: number; link: string }[]; startDate: string | null;
}

/** Every card the user may hide (personal choice, kept on the server). */
const TOP = ['revToday', 'revMonth', 'netMonth', 'netYear'] as const;
const TILES = ['cash', 'banks', 'visaClearing', 'arPatients', 'arInsurance', 'ap', 'salariesPayable', 'chequesOnHand', 'chequesCollecting', 'chequesIssued', 'inventory', 'fixedAssets'] as const;
const PANELS = ['alerts', 'monthly', 'visa', 'cheques', 'byMethod', 'byCategory', 'byDoctor'] as const;
const TILE_LINK: Record<(typeof TILES)[number], [string, 'primary' | 'success' | 'warning' | 'danger' | 'violet' | 'neutral']> = {
  cash: ['/accounting/treasury', 'success'], banks: ['/accounting/treasury', 'primary'], visaClearing: ['/accounting/visa', 'warning'], arPatients: ['/accounting/aging?type=patients', 'primary'],
  arInsurance: ['/accounting/aging?type=insurance', 'primary'], ap: ['/accounting/aging?type=suppliers', 'danger'], salariesPayable: ['/accounting/payroll', 'warning'], chequesOnHand: ['/accounting/cheques', 'neutral'],
  chequesCollecting: ['/accounting/cheques?alert=collecting', 'neutral'], chequesIssued: ['/accounting/cheques?tab=OUT', 'neutral'], inventory: ['/accounting/accounts', 'violet'], fixedAssets: ['/accounting/assets', 'violet'],
};

/** Real figures from the books and from EmergencyPlus — every tile and alert opens the screen behind it. */
export default function AccountingDashboard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['acc', 'dashboard'], queryFn: () => api.get<Dash>('/accounting/dashboard'), refetchInterval: 120_000 });
  const pref = usePref<{ hidden: string[] }>('acc-dashboard', { hidden: [] });
  const [customizing, setCustomizing] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data!, b = d.balances;
  const shown = (k: string) => !pref.value.hidden.includes(k);
  const icon = { info: Info, warning: AlertTriangle, danger: OctagonAlert };
  const tone = { info: 'bg-primary-50 text-primary-800', warning: 'bg-warning-50 text-warning-700', danger: 'bg-danger-50 text-danger-700' };
  const top: Record<(typeof TOP)[number], JSX.Element> = {
    revToday: <StatCard key="revToday" label={t('ao.dash.revToday')} value={amt0(d.revenue.today)} hint={`${t('ao.dash.expToday')}: ${amt0(d.expense.today)}`} tone="success" onClick={() => nav('/accounting/revenue?by=day')} />,
    revMonth: <StatCard key="revMonth" label={t('acc.dash.revMonth')} value={amt0(d.revenue.month)} hint={`${t('acc.dash.expMonth')}: ${amt0(d.expense.month)}`} tone="primary" onClick={() => nav('/accounting/income-statement')} />,
    netMonth: <StatCard key="netMonth" label={t('acc.dash.netMonth')} value={amt0(d.revenue.month - d.expense.month)} tone={d.revenue.month >= d.expense.month ? 'success' : 'danger'} onClick={() => nav('/accounting/income-statement')} />,
    netYear: <StatCard key="netYear" label={t('acc.dash.netYear')} value={amt0(d.revenue.year - d.expense.year)} hint={`${t('acc.dash.revYear')}: ${amt0(d.revenue.year)}`} tone="violet" onClick={() => nav('/accounting/income-statement')} />,
  };
  const tops = TOP.filter(shown), tiles = TILES.filter(shown);
  const charts = (['byMethod', 'byCategory', 'byDoctor'] as const).filter(shown);
  return (
    <div>
      <PageHeader title={t('acc.dash.title')} subtitle={t('acc.dash.subtitle')} actions={<Button variant="outline" icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setCustomizing(true)}>{t('ao.dash.customize')}</Button>} />
      {shown('alerts') && d.alerts.length > 0 && <div className="mb-4 grid gap-2 md:grid-cols-2">{d.alerts.map((a) => { const I = icon[a.level]; return (
        <button key={a.key} type="button" onClick={() => nav(a.link)} className={clsx('flex items-center gap-2 rounded-xl px-3 py-2 text-start text-sm font-semibold', tone[a.level])}><I className="h-4 w-4 shrink-0" />{t(`ao.dash.alert.${a.key}`, { n: a.n })}</button>
      ); })}</div>}
      {tops.length > 0 && <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tops.map((k) => top[k])}</div>}
      {tiles.length > 0 && <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((k) => <StatCard key={k} label={t(`ao.dash.b.${k}`)} value={amt0(b[k])} tone={TILE_LINK[k][1]} onClick={() => nav(TILE_LINK[k][0])} />)}
        </div>
      </Card>}
      {(shown('monthly') || shown('visa') || shown('cheques')) && <div className="mb-4 grid gap-4 lg:grid-cols-3">
        {shown('monthly') && <Card className={shown('visa') || shown('cheques') ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <CardHeader title={t('ao.dash.monthly')} />
          {d.charts.months.length ? <BarsChart data={d.charts.months} x="month" series={[{ key: 'revenue', label: t('acc.is.revenue') }, { key: 'expense', label: t('acc.is.expense') }]} format={(v) => amt0(v)} /> : <p className="py-10 text-center text-sm text-ink-muted">{t('acc.dash.empty')}</p>}
        </Card>}
        {(shown('visa') || shown('cheques')) && <Card>
          {shown('visa') && <>
            <CardHeader title={t('ao.dash.visa')} />
            <dl className="space-y-2 text-sm">
              <p className="flex justify-between"><span>{t('ao.visa.notReached')}</span><b>{amt0(d.visa.notReached)}</b></p>
              <p className="flex justify-between"><span>{t('ao.visa.reached')}</span><b>{amt0(d.visa.reached)}</b></p>
              <p className="flex justify-between"><span>{t('ao.visa.fees')}</span><b>{amt0(d.visa.fees)}</b></p>
            </dl>
          </>}
          {shown('cheques') && <>
            <CardHeader className={shown('visa') ? 'mt-4' : ''} title={t('ao.dash.cheques')} />
            <dl className="space-y-2 text-sm">
              {(['inSafe', 'collecting', 'collected', 'bounced', 'outUnpaid'] as const).map((k) => <p key={k} className="flex justify-between"><span>{t(`ao.dash.c.${k}`)}</span><b className={k === 'bounced' && d.cheques[k] ? 'text-danger-700' : ''}>{amt0(d.cheques[k])}</b></p>)}
            </dl>
          </>}
        </Card>}
      </div>}
      {charts.length > 0 && <div className="grid gap-4 lg:grid-cols-3">
        {charts.map((k) => (
          <Card key={k}>
            <CardHeader title={t(`ao.dash.${k}`)} subtitle={t('ao.dash.thisMonth')} />
            {d.charts[k].length ? <ShareBars rows={k === 'byCategory' ? d.charts[k].map((r) => ({ ...r, label: t(`enum.ServiceCategory.${r.label}`, { defaultValue: r.label }) })) : d.charts[k]} format={(v) => amt0(v)} /> : <p className="py-6 text-center text-sm text-ink-muted">—</p>}
          </Card>
        ))}
      </div>}
      {customizing && <Customize hidden={pref.value.hidden} onSave={(hidden) => { pref.set({ hidden }); setCustomizing(false); }} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

function Customize({ hidden, onSave, onClose }: { hidden: string[]; onSave: (hidden: string[]) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [h, setH] = useState(new Set(hidden));
  const label = (k: string) => (TOP as readonly string[]).includes(k) ? t(k === 'revToday' ? 'ao.dash.revToday' : `acc.dash.${k}`) : (TILES as readonly string[]).includes(k) ? t(`ao.dash.b.${k}`) : t(`ao.dash.panel.${k}`);
  const group = (title: string, keys: readonly string[]) => (
    <div>
      <p className="mb-1.5 flex items-center justify-between text-sm font-bold">{title}
        <span className="flex gap-1 text-xs font-normal">
          <button type="button" className="text-primary-700" onClick={() => setH((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n; })}>{t('ao.dash.showAll')}</button>·
          <button type="button" className="text-primary-700" onClick={() => setH((s) => new Set([...s, ...keys]))}>{t('ao.dash.hideAll')}</button>
        </span>
      </p>
      <div className="grid gap-1 sm:grid-cols-2">{keys.map((k) => <Checkbox key={k} label={label(k)} checked={!h.has(k)} onChange={(e) => setH((s) => { const n = new Set(s); e.target.checked ? n.delete(k) : n.add(k); return n; })} />)}</div>
    </div>
  );
  return (
    <Dialog open onClose={onClose} title={t('ao.dash.customize')} footer={<><Button variant="ghost" onClick={() => onSave([])}>{t('ao.dash.reset')}</Button><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={() => onSave([...h])}>{t('common.save')}</Button></>}>
      <p className="mb-3 text-xs text-ink-muted">{t('ao.dash.customizeHint')}</p>
      <div className="space-y-4">{group(t('ao.dash.g.top'), TOP)}{group(t('ao.dash.g.tiles'), TILES)}{group(t('ao.dash.g.panels'), PANELS)}</div>
    </Dialog>
  );
}
