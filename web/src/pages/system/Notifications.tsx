import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { usePagedList } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, PageHeader, Pagination, Skeleton } from '@/components/ui';

interface N { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

export default function Notifications() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = usePagedList<N, { unread?: string }>('notifications', '/notifications', { pageSize: 25 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const open = async (n: N) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`);
    refresh();
    if (n.link) nav(n.link);
  };
  return (
    <div>
      <PageHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle')}
        actions={<Button variant="outline" icon={<CheckCheck className="h-4 w-4" />} onClick={async () => { await api.post('/notifications/read-all'); refresh(); }}>{t('topbar.markAllRead')}</Button>}
      />
      <Card>
        <Checkbox className="mb-3" label={t('notifications.unreadOnly')} checked={list.filters.unread === 'true'} onChange={(e) => list.setFilters({ unread: e.target.checked ? 'true' : undefined })} />
        {list.query.error ? <ErrorState error={list.query.error} onRetry={() => list.query.refetch()} /> : !list.data ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : list.data.items.length === 0 ? <EmptyState icon={<Bell className="h-6 w-6" />} title={t('notifications.empty')} /> : (
          <ul className="divide-y divide-line">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => open(n)} className={clsx('flex w-full items-start gap-3 rounded-xl px-3 py-3 text-start hover:bg-surface-subtle', !n.readAt && 'bg-primary-50/50')}>
                  <span className={clsx('mt-2 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-line-strong' : 'bg-primary-500')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{n.title}</span>
                      <Badge tone="info">{t(`enum.NotificationType.${n.type}`)}</Badge>
                    </span>
                    {n.body && <span className="mt-0.5 block text-sm text-ink-soft">{n.body}</span>}
                    <span className="mt-0.5 block text-xs text-ink-muted">{fmtDateTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
