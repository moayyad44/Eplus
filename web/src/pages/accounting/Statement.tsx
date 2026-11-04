import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { exportCsv } from '@/lib/export';
import { amt, amt0, monthStart, today, useAccounts } from '@/lib/accounting';
import { Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Select } from '@/components/ui';

interface St {
  account: { id: string; code: string; name: string; nature: string; isGroup: boolean }; from: string; to: string; opening: number; debit: number; credit: number; closing: number;
  rows: { id: string; entryId: string; number: string; date: string; description: string; reference: string | null; account: string; party: string | null; debit: number; credit: number; balance: number }[];
}

export default function Statement() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const accounts = useAccounts();
  const accountId = sp.get('accountId') ?? '';
  const from = sp.get('from') ?? monthStart(), to = sp.get('to') ?? today();
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const q = useQuery({ queryKey: ['acc', 'statement', accountId, from, to], queryFn: () => api.get<St>('/accounting/reports/statement', { accountId, from, to }), enabled: !!accountId });
  const s = q.data;
  return (
    <div>
      <PageHeader
        title={t('acc.statement.title')}
        subtitle={t('acc.statement.subtitle')}
        actions={s && <>
          <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
          {can('accounting.export') && <Button variant="outline" onClick={() => exportCsv(`statement-${s.account.code}`, [
            { header: t('acc.f.date'), value: (r: St['rows'][number]) => r.date }, { header: t('acc.f.number'), value: (r) => r.number }, { header: t('acc.f.statement'), value: (r) => r.description },
            { header: t('acc.f.account'), value: (r) => r.account }, { header: t('acc.f.debit'), value: (r) => r.debit.toFixed(3) }, { header: t('acc.f.credit'), value: (r) => r.credit.toFixed(3) }, { header: t('acc.f.balance'), value: (r) => r.balance.toFixed(3) },
          ], s.rows)}>{t('common.exportCsv')}</Button>}
        </>}
      />
      <Card className="mb-4 print:hidden">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <Field label={t('acc.f.account')}>
            <Select value={accountId} onChange={(e) => set('accountId', e.target.value)}>
              <option value="">{t('acc.journal.pickAccount')}</option>
              {accounts.data?.map((a) => <option key={a.id} value={a.id}>{' '.repeat(a.level * 3)}{a.code} — {a.name}</option>)}
            </Select>
          </Field>
          <Field label={t('common.from')}><Input type="date" value={from} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label={t('common.to')}><Input type="date" value={to} onChange={(e) => set('to', e.target.value)} /></Field>
        </div>
      </Card>
      {!accountId ? <EmptyState title={t('acc.statement.pick')} /> : q.isLoading ? <PageLoader /> : q.error || !s ? <ErrorState error={q.error} /> : (
        <Card>
          <h2 className="mb-3 text-lg font-bold"><span dir="ltr">{s.account.code}</span> — {s.account.name} <span className="text-sm font-normal text-ink-muted">({s.from} → {s.to})</span></h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b border-line text-xs text-ink-muted">
                <th className="p-2 text-start">{t('acc.f.date')}</th><th className="p-2 text-start">{t('acc.f.number')}</th><th className="p-2 text-start">{t('acc.f.statement')}</th>
                {s.account.isGroup && <th className="p-2 text-start">{t('acc.f.account')}</th>}
                <th className="p-2 text-end">{t('acc.f.debit')}</th><th className="p-2 text-end">{t('acc.f.credit')}</th><th className="p-2 text-end">{t('acc.f.balance')}</th>
              </tr></thead>
              <tbody>
                <tr className="border-b border-line bg-surface-subtle font-semibold"><td colSpan={s.account.isGroup ? 6 : 5} className="p-2">{t('acc.f.opening')}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt0(s.opening)}</td></tr>
                {s.rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer border-b border-line/70 hover:bg-primary-50/40" onClick={() => nav(`/accounting/journal/${r.entryId}`)} title={t('acc.statement.openEntry')}>
                    <td className="p-2 tabular-nums">{r.date}</td><td className="p-2 font-mono text-xs" dir="ltr">{r.number}</td>
                    <td className="p-2">{r.description}{(r.reference || r.party) && <span className="block text-xs text-ink-muted">{[r.reference, r.party].filter(Boolean).join(' · ')}</span>}</td>
                    {s.account.isGroup && <td className="p-2 text-xs">{r.account}</td>}
                    <td className="p-2 text-end tabular-nums" dir="ltr">{amt(r.debit)}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt(r.credit)}</td>
                    <td className="p-2 text-end font-semibold tabular-nums" dir="ltr">{amt0(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="font-bold"><td colSpan={s.account.isGroup ? 4 : 3} className="p-2">{t('acc.f.closing')}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt0(s.debit)}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt0(s.credit)}</td><td className="p-2 text-end tabular-nums text-primary-700" dir="ltr">{amt0(s.closing)}</td></tr></tfoot>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
