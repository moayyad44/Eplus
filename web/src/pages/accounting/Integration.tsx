import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, DataTable, PageHeader, Pagination, Segmented, StatCard, useConfirm } from '@/components/ui';

interface Row { id: string; sourceKey: string; kind: string; sourceId: string; status: string; attempts: number; lastError: string | null; note: string | null; queuedAt: string; processedAt: string | null; entry: { id: string; number: string; status: string } | null }
const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { DONE: 'success', PENDING: 'warning', FAILED: 'danger', SKIPPED: 'neutral' };
const SOURCE: Record<string, (id: string) => string> = {
  invoice: (id) => `/billing/invoices/${id}`, 'invoice-cancel': (id) => `/billing/invoices/${id}`, expense: () => '/expenses', 'supplier-payment': () => '/suppliers', po: (id) => `/purchases/${id}`, 'ins-payment': () => '/insurance/payments',
};

export default function Integration() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const list = usePagedList<Row, { status?: string }>('acc-link', '/accounting/link', { pageSize: 30 });
  const extra = list.data as unknown as { counts?: Record<string, number>; startDate?: string | null } | undefined;
  const retry = useApiMutation((ids?: string[]) => api.post<{ done: number; failed: number }>('/accounting/link/retry', { ids }), { invalidate: [['acc-link'], ['acc']], success: false, onSuccess: (r) => toast.success(t('acc.link.resynced', { n: r.done + r.failed, d: r.done, f: r.failed })) });
  const resync = useApiMutation(() => api.post<{ queued: number; done: number; failed: number }>('/accounting/link/resync', {}), { invalidate: [['acc-link'], ['acc']], success: false, onSuccess: (r) => toast.success(t('acc.link.resynced', { n: r.queued, d: r.done, f: r.failed })) });
  const manage = can('accounting.settings');
  return (
    <div>
      <PageHeader title={t('acc.link.title')} subtitle={t('acc.link.subtitle')} actions={manage && <>
        <Button variant="outline" icon={<RotateCcw className="h-4 w-4" />} loading={retry.isPending} disabled={!extra?.counts?.FAILED} onClick={() => retry.mutate(undefined)}>{t('acc.link.retryAll')}</Button>
        <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} loading={resync.isPending} disabled={!extra?.startDate} onClick={async () => (await confirm({ message: t('acc.link.resyncConfirm') })) && resync.mutate(undefined)}>{t('acc.link.resync')}</Button>
      </>} />
      {extra && !extra.startDate && <p className="mb-3 rounded-xl bg-warning-50 px-3 py-2 text-sm text-warning-700">{t('acc.link.notStarted')}</p>}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {(['DONE', 'PENDING', 'FAILED', 'SKIPPED'] as const).map((s) => <StatCard key={s} label={t(`acc.link.status.${s}`)} value={extra?.counts?.[s] ?? 0} tone={s === 'FAILED' ? 'danger' : s === 'PENDING' ? 'warning' : s === 'DONE' ? 'success' : 'neutral'} onClick={() => list.setFilters({ status: s })} />)}
      </div>
      <Card>
        <div className="mb-3"><Segmented items={[{ key: '', label: t('acc.f.all') }, ...(['FAILED', 'PENDING', 'DONE', 'SKIPPED'] as const).map((s) => ({ key: s, label: t(`acc.link.status.${s}`) }))]} value={list.filters.status ?? ''} onChange={(s) => list.setFilters({ status: s || undefined })} /></div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          columns={[
            { key: 'k', header: t('acc.link.operation'), cell: (r) => <button type="button" className="text-start hover:text-primary-700" onClick={() => SOURCE[r.kind] && nav(SOURCE[r.kind](r.sourceId))}><b>{t(`acc.link.kind.${r.kind}`)}</b><span className="block font-mono text-[10px] text-ink-muted" dir="ltr">{r.sourceId.slice(0, 8)}</span></button> },
            { key: 's', header: t('acc.f.status'), cell: (r) => <Badge tone={TONE[r.status]} dot={false}>{t(`acc.link.status.${r.status}`)}</Badge> },
            { key: 'e', header: t('acc.link.result'), cell: (r) => r.entry ? <button type="button" className="font-mono text-xs font-semibold text-primary-700" dir="ltr" onClick={() => nav(`/accounting/journal/${r.entry!.id}`)}>{r.entry.number}{r.entry.status === 'DELETED' ? ' ✕' : ''}</button> : <span className="text-xs text-ink-muted">{r.note ?? ''}</span> },
            { key: 'err', header: t('common.notes'), cell: (r) => r.lastError ? <span className="text-xs text-danger-600">{r.lastError}</span> : r.entry && r.note ? <span className="text-xs text-ink-muted">{r.note}</span> : '' },
            { key: 'q', header: t('acc.link.queued'), hideOnMobile: true, cell: (r) => <span className="text-xs">{fmtDateTime(r.processedAt ?? r.queuedAt)}<span className="block text-ink-muted">{t('acc.link.attempts')}: {r.attempts}</span></span> },
            { key: 'x', header: '', cell: (r) => manage && r.status === 'FAILED' && <Button size="sm" variant="ghost" onClick={() => retry.mutate([r.id])}>{t('acc.link.retry')}</Button> },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
