import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { amt, amt0 } from '@/lib/accounting';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, PageHeader, Select, useConfirm } from '@/components/ui';

interface PRow { row: number; code: string; name: string; debit: number; credit: number; party: string | null; note: string | null; accountId: string | null; accountName: string | null; errors: string[]; warnings: string[] }
interface Preview { sheets: string[]; sheet: string; header: string[]; map: Record<string, number>; rows: PRow[]; totals: { debit: number; credit: number; difference: number; valid: number; invalid: number }; existing: { number: string } | null }
const COLS = ['code', 'debit', 'credit', 'party', 'note'] as const;

export default function Opening() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const confirm = useConfirm();
  const settings = useQuery({ queryKey: ['acc', 'settings'], queryFn: () => api.get<{ startDate: string | null }>('/accounting/settings') });
  const [file, setFile] = useState<File | null>(null);
  const [p, setP] = useState<Preview | null>(null);
  const [sheet, setSheet] = useState('');
  const [cols, setCols] = useState<Record<string, number>>({});
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [date, setDate] = useState('');
  const [fill, setFill] = useState(false);
  const read = useApiMutation((v: { sheet?: string; cols?: Record<string, number> }) => {
    const fd = new FormData();
    fd.append('file', file!);
    if (v.sheet) fd.append('sheet', v.sheet);
    if (v.cols) fd.append('cols', JSON.stringify(v.cols));
    return api.upload<Preview>('/accounting/opening/preview', fd);
  }, { success: false, onSuccess: (r) => { setP(r); setSheet(r.sheet); setCols(r.map); setExcluded(new Set()); } });
  const take = useMemo(() => (p?.rows ?? []).filter((r) => !r.errors.length && !excluded.has(r.row)), [p, excluded]);
  const d = take.reduce((s, r) => s + r.debit, 0), c = take.reduce((s, r) => s + r.credit, 0);
  const diff = Math.round((d - c) * 1000) / 1000;
  const day = date || settings.data?.startDate || '';
  const run = useApiMutation(() => api.post<{ id: string; number: string }>('/accounting/opening/import', { date: day, fillDifference: fill, fileName: file?.name ?? null, rows: take.map((r) => ({ accountId: r.accountId, debit: r.debit, credit: r.credit, party: r.party, note: r.note })) }), {
    invalidate: [['acc']], success: false, onSuccess: (r) => { toast.success(t('acc.opening.done', { n: r.number })); nav(`/accounting/journal/${r.id}`); },
  });
  return (
    <div>
      <PageHeader title={t('acc.opening.title')} subtitle={t('acc.opening.subtitle')} />
      <div className="space-y-4">
        <Card>
          <CardHeader title={t('acc.opening.step1')} subtitle={t('acc.opening.step1Hint')} />
          <a href="/api/accounting/opening/template" download className="inline-flex items-center gap-2 rounded-xl border border-line-strong px-4 py-2 text-sm font-semibold hover:bg-surface-subtle"><Download className="h-4 w-4" />{t('acc.opening.template')}</a>
        </Card>
        <Card>
          <CardHeader title={t('acc.opening.step2')} />
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('acc.opening.file')}><Input type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setP(null); }} /></Field>
            <Button icon={<Upload className="h-4 w-4" />} disabled={!file} loading={read.isPending} onClick={() => read.mutate({})}>{t('acc.opening.step3')}</Button>
          </div>
          {p && (
            <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
              {p.sheets.length > 1 && <Field label={t('acc.opening.sheet')}><Select value={sheet} onChange={(e) => setSheet(e.target.value)}>{p.sheets.map((s) => <option key={s}>{s}</option>)}</Select></Field>}
              {COLS.map((k) => (
                <Field key={k} label={t(`acc.opening.col.${k}`)}>
                  <Select value={String(cols[k] ?? -1)} onChange={(e) => setCols({ ...cols, [k]: Number(e.target.value) })} className="!h-9 w-36">
                    <option value="-1">—</option>{p.header.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}
                  </Select>
                </Field>
              ))}
              <Button variant="outline" size="sm" loading={read.isPending} onClick={() => read.mutate({ sheet, cols })}>{t('acc.opening.reread')}</Button>
            </div>
          )}
        </Card>
        {p && (
          <Card>
            <CardHeader title={t('acc.opening.step3')} />
            <div className="mb-3 flex flex-wrap gap-2">
              <Badge tone="success" dot={false}>{t('acc.opening.valid')}: {take.length}</Badge>
              {p.totals.invalid > 0 && <Badge tone="danger" dot={false}>{t('acc.opening.invalid')}: {p.totals.invalid}</Badge>}
              <Badge dot={false}>{t('acc.f.debit')}: {amt0(d)}</Badge><Badge dot={false}>{t('acc.f.credit')}: {amt0(c)}</Badge>
              <Badge tone={diff ? 'warning' : 'success'} dot={false}>{t('acc.f.difference')}: {amt0(diff)}</Badge>
            </div>
            {p.existing && <p className="mb-3 rounded-xl bg-warning-50 px-3 py-2 text-sm text-warning-700">{t('acc.opening.replaces', { n: p.existing.number })}</p>}
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="sticky top-0 bg-white"><tr className="border-b border-line text-xs text-ink-muted">
                  <th className="p-2">{t('acc.opening.row')}</th><th className="p-2 text-start">{t('acc.f.account')}</th><th className="p-2 text-end">{t('acc.f.debit')}</th><th className="p-2 text-end">{t('acc.f.credit')}</th>
                  <th className="p-2 text-start">{t('acc.opening.errors')} / {t('acc.opening.warnings')}</th><th className="p-2">{t('acc.opening.exclude')}</th>
                </tr></thead>
                <tbody>{p.rows.map((r) => (
                  <tr key={r.row} className={clsx('border-b border-line/70', r.errors.length && 'bg-danger-50/60', excluded.has(r.row) && 'opacity-40')}>
                    <td className="p-2 text-center text-xs">{r.row}</td>
                    <td className="p-2"><span className="font-mono text-xs" dir="ltr">{r.code}</span> {r.accountName ?? r.name}{r.party && <span className="block text-xs text-ink-muted">{r.party}</span>}</td>
                    <td className="p-2 text-end tabular-nums" dir="ltr">{amt(r.debit)}</td><td className="p-2 text-end tabular-nums" dir="ltr">{amt(r.credit)}</td>
                    <td className="p-2 text-xs">{r.errors.map((e) => <span key={e} className="block text-danger-700">✕ {e}</span>)}{r.warnings.map((w) => <span key={w} className="block text-warning-700">⚠ {w}</span>)}</td>
                    <td className="p-2 text-center">{!r.errors.length && <input type="checkbox" checked={excluded.has(r.row)} onChange={(e) => { const s = new Set(excluded); e.target.checked ? s.add(r.row) : s.delete(r.row); setExcluded(s); }} />}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-3">
              <Field label={t('acc.opening.date')}><Input type="date" value={day} onChange={(e) => setDate(e.target.value)} /></Field>
              {diff !== 0 && <Checkbox label={t('acc.opening.fill')} checked={fill} onChange={(e) => setFill(e.target.checked)} />}
              <Button className="ms-auto" variant="success" disabled={!take.length || !day || (diff !== 0 && !fill)} loading={run.isPending} onClick={async () => (await confirm({ message: t('acc.opening.confirmText', { n: take.length, t: amt0(Math.max(d, c)), d: day }) })) && run.mutate(undefined)}>{t('acc.opening.confirm')}</Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
