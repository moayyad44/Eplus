import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { Button, Card, Checkbox, PageHeader, PageLoader } from '@/components/ui';

export default function AccountingSettings() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['acc', 'settings'], queryFn: () => api.get<{ requireApproval: boolean; startDate: string | null; currency: string }>('/accounting/settings') });
  const [v, setV] = useState({ requireApproval: true });
  useEffect(() => { if (q.data) setV({ requireApproval: q.data.requireApproval }); }, [q.data]);
  const save = useApiMutation(() => api.put('/accounting/settings', v), { invalidate: [['acc']] });
  if (!q.data) return <PageLoader />;
  return (
    <div>
      <PageHeader title={t('acc.settings.title')} />
      <Card className="max-w-2xl space-y-4">
        <Checkbox label={t('acc.settings.requireApproval')} checked={v.requireApproval} onChange={(e) => setV({ requireApproval: e.target.checked })} />
        <div className="text-sm">
          <p className="font-semibold">{t('acc.settings.startDate')}: <span dir="ltr">{q.data.startDate ?? '—'}</span></p>
          <p className="text-xs text-ink-muted">{t('acc.settings.startHint')}</p>
        </div>
        <p className="text-sm">{t('acc.settings.currency')}</p>
        <div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.saveChanges')}</Button></div>
      </Card>
    </div>
  );
}
