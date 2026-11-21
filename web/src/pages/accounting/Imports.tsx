import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { CheckCircle2, Download, FileSearch } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, PageLoader, Select, useConfirm } from '@/components/ui';

interface IType { key: string; title: string; allowed: boolean; columns: { key: string; header: string; required?: boolean; note: string }[] }
interface Row { line: number; values: Record<string, string>; errors: string[]; warnings: string[]; skip?: boolean }
interface Preview { rows: Row[]; summary: { total: number; errors: number; skipped: number; ready: number } }

export default function Imports() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const types = useQuery({ queryKey: ['acc', 'import-types'], queryFn: () => api.get<IType[]>('/accounting/imports') });
  const [type, setType] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fd = () => { const f = new FormData(); f.append('file', file!); return f; };
  const preview = useApiMutation(() => api.upload<Preview>(`/accounting/imports/${type}/preview`, fd()), { success: false });
  const commit = useApiMutation(() => api.upload<{ imported: number; skipped: number }>(`/accounting/imports/${type}/commit`, fd()), { invalidate: [['acc']], success: false, onSuccess: (r) => { toast.success(t('ao.im.done', { n: r.imported, s: r.skipped })); preview.reset(); } });
  if (types.isLoading) return <PageLoader />;
  const cur = types.data?.find((x) => x.key === type);
  const p = preview.data;
  return (
    <div>
      <PageHeader title={t('ao.im.title')} subtitle={t('ao.im.subtitle')} />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('ao.im.type')}><Select value={type} onChange={(e) => { setType(e.target.value); preview.reset(); }} className="w-72"><option value="">—</option>{types.data!.filter((x) => x.allowed).map((x) => <option key={x.key} value={x.key}>{x.title}</option>)}</Select></Field>
            {type && <a href={`/api/accounting/imports/${type}/template`} download className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong px-4 text-sm font-semibold hover:bg-surface-subtle"><Download className="h-4 w-4" />{t('ao.im.template')}</a>}
          </div>
          {cur && <ul className="mt-3 grid gap-1 text-xs text-ink-muted sm:grid-cols-2">{cur.columns.map((c) => <li key={c.key}><b className="text-ink">{c.header}</b>{c.required && ' *'}{c.note && ` — ${c.note}`}</li>)}</ul>}
          <p className="mt-3 text-xs text-ink-muted">{t('ao.im.otherTypes')}</p>
        </Card>
        {type && <Card>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('acc.opening.file')}><Input type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); preview.reset(); }} /></Field>
            <Button icon={<FileSearch className="h-4 w-4" />} disabled={!file} loading={preview.isPending} onClick={() => preview.mutate(undefined)}>{t('ao.im.preview')}</Button>
          </div>
        </Card>}
        {p && <Card padded={false}>
          <CardHeader className="p-4" title={t('ao.im.result')} actions={<div className="flex flex-wrap gap-2">
            <Badge tone="success" dot={false}>{t('ao.im.ready')}: {p.summary.ready}</Badge>
            <Badge dot={false}>{t('ao.im.skipped')}: {p.summary.skipped}</Badge>
            {p.summary.errors > 0 && <Badge tone="danger" dot={false}>{t('ao.im.errors')}: {p.summary.errors}</Badge>}
            <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} disabled={p.summary.errors > 0 || !p.summary.ready} loading={commit.isPending} onClick={async () => (await confirm({ message: t('ao.im.confirm', { n: p.summary.ready, s: p.summary.skipped }) })) && commit.mutate(undefined)}>{t('ao.im.commit')}</Button>
          </div>} />
          {p.summary.errors > 0 && <p className="mx-4 mb-2 rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-700">{t('ao.im.fixFirst')}</p>}
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 bg-white"><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2">#</th>{cur?.columns.map((c) => <th key={c.key} className="p-2 text-start">{c.header}</th>)}<th className="p-2 text-start">{t('ao.im.check')}</th></tr></thead>
              <tbody>{p.rows.map((r) => (
                <tr key={r.line} className={clsx('border-b border-line/60', r.errors.length ? 'bg-danger-50/60' : r.skip && 'opacity-50')}>
                  <td className="p-2 text-center text-xs">{r.line}</td>
                  {cur?.columns.map((c) => <td key={c.key} className="p-2 text-xs">{r.values[c.key]}</td>)}
                  <td className="p-2 text-xs">{r.errors.map((e) => <span key={e} className="block text-danger-700">✕ {e}</span>)}{r.warnings.map((w) => <span key={w} className="block text-warning-700">⚠ {w}</span>)}{!r.errors.length && !r.skip && <span className="text-success-700">✓</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>}
      </div>
    </div>
  );
}
