import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { amt0, monthStart, today } from '@/lib/accounting';
import { Badge, Card, CardHeader, ErrorState, Field, Input, PageHeader, PageLoader, Segmented } from '@/components/ui';
import { BarsChart } from '@/components/shared/charts';
import { Money, ReportActions, exportXlsx } from './shared';

const BUCKETS = ['b0_30', 'b31_60', 'b61_90', 'b90'] as const;
interface AgingRow { id: string; name: string; total: number; b0_30: number; b31_60: number; b61_90: number; b90: number; items: { ref: string; date: string; amount: number; days: number }[] }

/** Aging of patient / insurance receivables and supplier payables. */
export function Aging() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const type = (sp.get('type') as 'patients' | 'insurance' | 'suppliers') || 'patients';
  const [asOf, setAsOf] = useState(today());
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['acc', 'aging', type, asOf], queryFn: () => api.get<{ rows: AgingRow[]; totals: Record<string, number> }>('/accounting/reports/aging', { type, asOf }) });
  const excel = () => q.data && exportXlsx(`${t('ao.ag.title')} — ${t(`ao.ag.${type}`)}`, [{ header: t('ao.ag.party'), key: 'name' }, ...BUCKETS.map((b) => ({ header: t(`ao.ag.${b}`), key: b, money: true })), { header: t('acc.f.total'), key: 'total', money: true }], q.data.rows as never, [...BUCKETS, 'total']);
  return (
    <div>
      <PageHeader title={t('ao.ag.title')} subtitle={t('ao.ag.subtitle')} actions={<ReportActions onExcel={excel} />} />
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <Segmented value={type} onChange={(k) => setSp({ type: k })} items={(['patients', 'insurance', 'suppliers'] as const).map((k) => ({ key: k, label: t(`ao.ag.${k}`) }))} />
        <Field label={t('acc.bs.asOf')}><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      </div>
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorState error={q.error} /> : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr className="border-b border-line bg-surface-subtle text-xs text-ink-muted"><th className="p-2 text-start">{t('ao.ag.party')}</th>{BUCKETS.map((b) => <th key={b} className="p-2 text-end">{t(`ao.ag.${b}`)}</th>)}<th className="p-2 text-end">{t('acc.f.total')}</th></tr></thead>
              <tbody>{q.data!.rows.map((r) => (<Fragment key={r.id}>
                <tr className="cursor-pointer border-b border-line/60 hover:bg-surface-subtle" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td className="p-2 font-semibold">{r.name} <span className="text-xs text-ink-muted">({r.items.length})</span></td>
                  {BUCKETS.map((b) => <td key={b} className={`p-2 text-end ${b === 'b90' && r[b] ? 'font-bold text-danger-700' : ''}`}>{r[b] ? <Money v={r[b]} /> : ''}</td>)}
                  <td className="p-2 text-end font-bold"><Money v={r.total} /></td>
                </tr>
                {open === r.id && <tr key={`${r.id}-d`}><td colSpan={6} className="bg-surface-subtle p-2"><ul className="grid gap-1 text-xs sm:grid-cols-2">{r.items.map((i) => <li key={i.ref + i.date}><b dir="ltr">{i.ref}</b> · {i.date} · <Money v={i.amount} /> · {t('ao.ag.days', { n: i.days })}</li>)}</ul></td></tr>}
              </Fragment>))}</tbody>
              <tfoot><tr className="bg-surface-subtle font-bold"><td className="p-2">{t('acc.f.total')}</td>{BUCKETS.map((b) => <td key={b} className="p-2 text-end"><Money v={q.data!.totals[b]} /></td>)}<td className="p-2 text-end"><Money v={q.data!.totals.total} /></td></tr></tfoot>
            </table>
          </div>
          {!q.data!.rows.length && <p className="p-6 text-center text-sm text-ink-muted">{t('ao.ag.none')}</p>}
        </Card>
      )}
    </div>
  );
}

interface RevRow { key: string | null; label: string | null; amount: number; count: number; paid?: number; outstanding?: number }
const BY = ['category', 'doctor', 'method', 'payer', 'day', 'month'] as const;
/** Revenue from EmergencyPlus invoices by service, doctor, payment method, payer, day or month. */
export function Revenue() {
  const { t } = useTranslation();
  const [f, setF] = useState({ by: 'category' as (typeof BY)[number], from: monthStart(), to: today() });
  const q = useQuery({ queryKey: ['acc', 'revenue', f], queryFn: () => api.get<{ rows: RevRow[]; total: number }>('/accounting/reports/revenue', f) });
  const label = (r: RevRow) => f.by === 'category' ? t(`enum.ServiceCategory.${r.label}`, { defaultValue: r.label ?? '' }) : f.by === 'payer' ? t(`enum.PayerType.${r.label}`, { defaultValue: r.label ?? '' }) : r.label ?? '—';
  const excel = () => q.data && exportXlsx(`${t('ao.rev.title')} — ${t(`ao.rev.by.${f.by}`)}`, [{ header: t(`ao.rev.by.${f.by}`), key: 'l' }, { header: t('ao.rev.count'), key: 'count' }, { header: t('acc.f.amount'), key: 'amount', money: true }, ...(q.data.rows[0]?.paid !== undefined ? [{ header: t('ao.rev.paid'), key: 'paid', money: true }, { header: t('ao.rev.outstanding'), key: 'outstanding', money: true }] : [])], q.data.rows.map((r) => ({ ...r, l: label(r) })), ['amount', 'paid', 'outstanding']);
  return (
    <div>
      <PageHeader title={t('ao.rev.title')} subtitle={t('ao.rev.subtitle')} actions={<ReportActions onExcel={excel} />} />
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <Segmented value={f.by} onChange={(k) => setF({ ...f, by: k })} items={BY.map((k) => ({ key: k, label: t(`ao.rev.by.${k}`) }))} />
        <Field label={t('ao.from')}><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label={t('ao.to')}><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </div>
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorState error={q.error} /> : <>
        {(f.by === 'day' || f.by === 'month') && q.data!.rows.length > 1 && <Card className="mb-4"><BarsChart data={q.data!.rows.map((r) => ({ x: r.label ?? '', v: r.amount }))} x="x" series={[{ key: 'v', label: t('acc.f.amount') }]} format={(v) => amt0(v)} /></Card>}
        <Card padded={false}>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line bg-surface-subtle text-xs text-ink-muted"><th className="p-2 text-start">{t(`ao.rev.by.${f.by}`)}</th><th className="p-2 text-center">{t('ao.rev.count')}</th><th className="p-2 text-end">{t('acc.f.amount')}</th>{q.data!.rows[0]?.paid !== undefined && <><th className="p-2 text-end">{t('ao.rev.paid')}</th><th className="p-2 text-end">{t('ao.rev.outstanding')}</th></>}<th className="p-2 text-end">%</th></tr></thead>
            <tbody>{q.data!.rows.map((r) => (
              <tr key={r.key ?? 'none'} className="border-b border-line/60">
                <td className="p-2 font-semibold">{label(r)}</td>
                <td className="p-2 text-center">{r.count}</td><td className="p-2 text-end"><Money v={r.amount} /></td>
                {r.paid !== undefined && <><td className="p-2 text-end"><Money v={r.paid} /></td><td className="p-2 text-end"><Money v={r.outstanding} /></td></>}
                <td className="p-2 text-end text-xs text-ink-muted">{q.data!.total ? Math.round((r.amount / q.data!.total) * 100) : 0}%</td>
              </tr>
            ))}</tbody>
            <tfoot><tr className="bg-surface-subtle font-bold"><td className="p-2" colSpan={2}>{t('acc.f.total')}</td><td className="p-2 text-end"><Money v={q.data!.total} /></td><td colSpan={3} /></tr></tfoot>
          </table>
          <p className="p-3 text-xs text-ink-muted">{f.by === 'method' ? t('ao.rev.methodHint') : t('ao.rev.hint')}</p>
        </Card>
      </>}
    </div>
  );
}

interface CF { from: string; to: string; opening: number; closing: number; change: number; internalTransfers: number; sections: { key: string; net: number; rows: { accountId: string; name: string; inflow: number; outflow: number; net: number }[] }[] }
/** Cash flow, direct method: what moved money in and out of boxes and banks. */
export function CashFlow() {
  const { t } = useTranslation();
  const [f, setF] = useState({ from: monthStart(), to: today() });
  const q = useQuery({ queryKey: ['acc', 'cash-flow', f], queryFn: () => api.get<CF>('/accounting/reports/cash-flow', f) });
  const excel = () => q.data && exportXlsx(t('ao.cf.title'), [{ header: t('ao.cf.section'), key: 's' }, { header: t('acc.f.account'), key: 'name' }, { header: t('ao.cf.in'), key: 'inflow', money: true }, { header: t('ao.cf.out'), key: 'outflow', money: true }, { header: t('ao.cf.net'), key: 'net', money: true }], q.data.sections.flatMap((s) => s.rows.map((r) => ({ ...r, s: t(`ao.cf.${s.key}`) }))), ['inflow', 'outflow', 'net']);
  return (
    <div>
      <PageHeader title={t('ao.cf.title')} subtitle={t('ao.cf.subtitle')} actions={<ReportActions onExcel={excel} />} />
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <Field label={t('ao.from')}><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label={t('ao.to')}><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </div>
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorState error={q.error} /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2"><Badge dot={false}>{t('ao.cf.opening')}: {amt0(q.data!.opening)}</Badge><Badge tone={q.data!.change >= 0 ? 'success' : 'danger'} dot={false}>{t('ao.cf.change')}: {amt0(q.data!.change)}</Badge><Badge tone="primary" dot={false}>{t('ao.cf.closing')}: {amt0(q.data!.closing)}</Badge></div>
          {q.data!.sections.map((s) => (
            <Card key={s.key} padded={false}>
              <CardHeader className="p-4" title={t(`ao.cf.${s.key}`)} actions={<b><Money v={s.net} /></b>} />
              <table className="w-full text-sm"><tbody>{s.rows.map((r) => (
                <tr key={r.accountId} className="border-t border-line/60"><td className="p-2">{r.name}</td><td className="p-2 text-end text-success-700">{r.inflow ? <Money v={r.inflow} /> : ''}</td><td className="p-2 text-end text-danger-700">{r.outflow ? <Money v={-r.outflow} /> : ''}</td><td className="p-2 text-end font-semibold"><Money v={r.net} /></td></tr>
              ))}{!s.rows.length && <tr><td className="p-3 text-center text-xs text-ink-muted">—</td></tr>}</tbody></table>
            </Card>
          ))}
          <p className="text-xs text-ink-muted">{t('ao.cf.hint', { n: q.data!.internalTransfers })}</p>
        </div>
      )}
    </div>
  );
}
