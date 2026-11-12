import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, DatabaseBackup, Download, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, CardHeader, DataTable } from '@/components/ui';

interface BackupList { enabled: boolean; pending: boolean; lastError: string | null; items: { name: string; size: number; createdAt: string }[] }

const size = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function Backups() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api.get<BackupList>('/backups'), refetchInterval: (s) => (s.state.data?.pending ? 5000 : 60_000) });
  const run = useApiMutation(() => api.post('/backups/run'), { invalidate: [['backups']], success: t('settings.backups.requested') });
  const d = q.data;
  const last = d?.items[0];
  const stale = !last || Date.now() - new Date(last.createdAt).getTime() > 48 * 3600_000;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<DatabaseBackup className="h-5 w-5" />}
          title={t('settings.backups.title')}
          subtitle={t('settings.backups.subtitle')}
          actions={d?.enabled && <Button loading={run.isPending || d.pending} onClick={() => run.mutate(undefined)}>{d.pending ? t('settings.backups.running') : t('settings.backups.now')}</Button>}
        />
        {d && !d.enabled && <p className="rounded-xl bg-warning-50 px-3 py-2 text-sm text-warning-700">{t('settings.backups.disabled')}</p>}
        {d?.enabled && (
          <div className="space-y-2">
            {d.lastError && (
              <p className="flex items-start gap-2 rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{t('settings.backups.failed')}: {d.lastError}</p>
            )}
            {stale ? (
              <p className="flex items-start gap-2 rounded-xl bg-warning-50 px-3 py-2 text-sm text-warning-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{t('settings.backups.stale')}</p>
            ) : (
              <p className="flex items-start gap-2 rounded-xl bg-success-50 px-3 py-2 text-sm text-success-700"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />{t('settings.backups.ok', { when: fmtDateTime(last!.createdAt) })}</p>
            )}
            <p className="text-xs leading-relaxed text-ink-muted">{t('settings.backups.offsite')}</p>
          </div>
        )}
      </Card>
      {d?.enabled && (
        <Card padded={false} className="p-2">
          <DataTable
            rows={d.items}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => q.refetch()}
            rowKey={(r) => r.name}
            columns={[
              { key: 'date', header: t('settings.backups.date'), cell: (r) => <b>{fmtDateTime(r.createdAt)}</b> },
              { key: 'name', header: t('settings.backups.file'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.name}</span>, hideOnMobile: true },
              { key: 'size', header: t('settings.backups.size'), cell: (r) => <Badge tone="neutral" dot={false}><span dir="ltr">{size(r.size)}</span></Badge> },
              {
                key: 'dl', header: '', align: 'end',
                cell: (r) => (
                  <a href={`/api/backups/${encodeURIComponent(r.name)}/download`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-primary-700 hover:bg-primary-50">
                    <Download className="h-4 w-4" />{t('common.download')}
                  </a>
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
