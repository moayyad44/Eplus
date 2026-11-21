import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { exportCsv } from '@/lib/export';
import { amt, amt0, monthStart, today, yearStart } from '@/lib/accounting';
import { Badge, Button, Card, ErrorState, Field, Input, PageHeader, PageLoader } from '@/components/ui';

interface Row { id: string; code: string; name: string; type: string; level: number; isGroup: boolean; amount?: number }
const Dates = ({ from, to, onFrom, onTo }: { from?: string; to: string; onFrom?: (v: string) => void; onTo: (v: string) => void }) => {
  const { t } = useTranslation();
  return (
    <Card className="mb-4 print:hidden"><div className="flex flex-wrap gap-3">
      {onFrom && <Field label={t('common.from')}><Input type="date" value={from} onChange={(e) => onFrom(e.target.value)} /></Field>}
      <Field label={onFrom ? t('common.to') : t('acc.bs.asOf')}><Input type="date" value={to} onChange={(e) => onTo(e.target.value)} /></Field>
    </div></Card>
  );
};

export function TrialBalance() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  type TRow = Row & { openingDebit: number; openingCredit: number; debit: number; credit: number; closingDebit: number; closingCredit: number };
  const q = useQuery({ queryKey: ['acc', 'tb', from, to], queryFn: () => api.get<{ rows: TRow[]; totals: Record<string, number>; balanced: boolean }>('/accounting/reports/trial-balance', { from, to }) });
  const d = q.data;
  const cols = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const;
  return (
    <div>
      <PageHeader title={t('acc.tb.title')} subtitle={t('acc.tb.subtitle')} actions={d && <>
        <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
        {can('accounting.export') && <Button variant="outline" onClick={() => exportCsv('trial-balance', [{ header: t('acc.f.code'), value: (r: TRow) => r.code }, { header: t('acc.f.name'), value: (r) => r.name }, ...cols.map((c) => ({ header: c, value: (r: TRow) => r[c].toFixed(3) }))], d.rows)}>{t('common.exportCsv')}</Button>}
      </>} />
      <Dates from={from} to={to} onFrom={setFrom} onTo={setTo} />
      {q.isLoading ? <PageLoader /> : q.error || !d ? <ErrorState error={q.error} /> : (
        <Card>
          <Badge tone={d.balanced ? 'success' : 'danger'} dot={false} className="mb-3">{d.balanced ? t('acc.tb.balancedOk') : t('acc.tb.balancedBad')}</Badge>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="text-xs text-ink-muted"><th rowSpan={2} className="p-2 text-start">{t('acc.f.code')}</th><th rowSpan={2} className="p-2 text-start">{t('acc.f.name')}</th><th colSpan={2} className="p-2">{t('acc.f.opening')}</th><th colSpan={2} className="p-2">{t('acc.f.movement')}</th><th colSpan={2} className="p-2">{t('acc.f.closing')}</th></tr>
                <tr className="border-b border-line text-xs text-ink-muted">{cols.map((c) => <th key={c} className="p-2 text-end">{c.toLowerCase().includes('debit') ? t('acc.f.debit') : t('acc.f.credit')}</th>)}</tr>
              </thead>
              <tbody>{d.rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-b border-line/70 hover:bg-primary-50/40" onClick={() => nav(`/accounting/statement?accountId=${r.id}&from=${from}&to=${to}`)}>
                  <td className="p-2 font-mono text-xs" dir="ltr">{r.code}</td><td className="p-2">{r.name}</td>
                  {cols.map((c) => <td key={c} className="p-2 text-end tabular-nums" dir="ltr">{amt(r[c])}</td>)}
                </tr>
              ))}</tbody>
              <tfoot><tr className="font-bold"><td colSpan={2} className="p-2">{t('acc.f.total')}</td>{cols.map((c) => <td key={c} className="p-2 text-end tabular-nums" dir="ltr">{amt0(d.totals[c])}</td>)}</tr></tfoot>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function Section({ title, rows, total, from, to }: { title: string; rows: Row[]; total: number; from?: string; to: string }) {
  const nav = useNavigate();
  const { t } = useTranslation();
  return (
    <div className="mb-4">
      <h3 className="mb-1 border-b-2 border-primary-200 pb-1 font-bold text-primary-800">{title}</h3>
      <table className="w-full text-sm"><tbody>
        {rows.filter((r) => r.amount || r.isGroup).filter((r) => r.level > 0 || !r.isGroup).map((r) => (
          <tr key={r.id} className={clsx('cursor-pointer hover:bg-primary-50/40', r.isGroup && 'font-semibold')} onClick={() => nav(`/accounting/statement?accountId=${r.id}${from ? `&from=${from}` : ''}&to=${to}`)}>
            <td className="py-1" style={{ paddingInlineStart: `${Math.max(r.level - 1, 0) * 18}px` }}><span className="font-mono text-xs text-ink-muted" dir="ltr">{r.code}</span> {r.name}</td>
            <td className="py-1 text-end tabular-nums" dir="ltr">{amt0(r.amount)}</td>
          </tr>
        ))}
        <tr className="border-t border-line font-bold"><td className="py-1.5">{t('acc.f.total')} {title}</td><td className="py-1.5 text-end tabular-nums" dir="ltr">{amt0(total)}</td></tr>
      </tbody></table>
    </div>
  );
}

export function IncomeStatement() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const q = useQuery({ queryKey: ['acc', 'is', from, to], queryFn: () => api.get<{ revenue: Row[]; expense: Row[]; totalRevenue: number; totalExpense: number; netProfit: number }>('/accounting/reports/income-statement', { from, to }) });
  const d = q.data;
  return (
    <div>
      <PageHeader title={t('acc.is.title')} actions={<Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>} />
      <Dates from={from} to={to} onFrom={setFrom} onTo={setTo} />
      {q.isLoading ? <PageLoader /> : q.error || !d ? <ErrorState error={q.error} /> : (
        <Card className="max-w-3xl">
          <Section title={t('acc.is.revenue')} rows={d.revenue} total={d.totalRevenue} from={from} to={to} />
          <Section title={t('acc.is.expense')} rows={d.expense} total={d.totalExpense} from={from} to={to} />
          <p className={clsx('flex justify-between rounded-xl px-3 py-2 text-lg font-bold', d.netProfit >= 0 ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700')}><span>{t('acc.is.net')}</span><span dir="ltr" className="tabular-nums">{amt0(d.netProfit)}</span></p>
        </Card>
      )}
    </div>
  );
}

export function BalanceSheet() {
  const { t } = useTranslation();
  const [asOf, setAsOf] = useState(today());
  const q = useQuery({ queryKey: ['acc', 'bs', asOf], queryFn: () => api.get<{ assets: Row[]; liabilities: Row[]; equity: Row[]; currentProfit: number; priorUnclosedProfit: number; totalAssets: number; totalLiabilities: number; totalEquity: number; balanced: boolean }>('/accounting/reports/balance-sheet', { asOf }) });
  const d = q.data;
  return (
    <div>
      <PageHeader title={t('acc.bs.title')} subtitle={`${t('acc.bs.asOf')} ${asOf}`} actions={<Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>} />
      <Dates to={asOf} onTo={setAsOf} />
      {q.isLoading ? <PageLoader /> : q.error || !d ? <ErrorState error={q.error} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card><Section title={t('acc.bs.assets')} rows={d.assets} total={d.totalAssets} to={asOf} /></Card>
          <Card>
            <Section title={t('acc.bs.liabilities')} rows={d.liabilities} total={d.totalLiabilities} to={asOf} />
            <Section title={t('acc.bs.equity')} rows={d.equity} total={d.totalEquity - d.currentProfit - d.priorUnclosedProfit} to={asOf} />
            <p className="flex justify-between py-1 text-sm"><span>{t('acc.bs.profit')}</span><span dir="ltr" className="tabular-nums">{amt0(d.currentProfit)}</span></p>
            {d.priorUnclosedProfit !== 0 && <p className="flex justify-between py-1 text-sm"><span>{t('acc.bs.prior')}</span><span dir="ltr" className="tabular-nums">{amt0(d.priorUnclosedProfit)}</span></p>}
            <p className="mt-2 flex justify-between border-t border-line pt-2 font-bold"><span>{t('acc.bs.liabEq')}</span><span dir="ltr" className="tabular-nums">{amt0(d.totalLiabilities + d.totalEquity)}</span></p>
          </Card>
          <Badge tone={d.balanced ? 'success' : 'danger'} dot={false}>{d.balanced ? t('acc.bs.ok') : t('acc.bs.bad')}</Badge>
        </div>
      )}
    </div>
  );
}
