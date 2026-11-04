import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock, LockOpen, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { Badge, Button, Card, CardHeader, Dialog, ErrorState, Field, Input, PageHeader, PageLoader, useConfirm } from '@/components/ui';

interface Period { id: string; name: string; startDate: string; endDate: string; status: string; entries: number; reopenReason: string | null }
interface Year { id: string; name: string; startDate: string; endDate: string; status: string; periods: Period[] }

export default function Periods() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['acc', 'years'], queryFn: () => api.get<Year[]>('/accounting/fiscal-years') });
  const [adding, setAdding] = useState(false);
  const close = useApiMutation((id: string) => api.post(`/accounting/periods/${id}/close`), { invalidate: [['acc']] });
  const reopen = useApiMutation((v: { id: string; reason: string }) => api.post(`/accounting/periods/${v.id}/reopen`, { reason: v.reason }), { invalidate: [['acc']] });
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div>
      <PageHeader title={t('acc.periods.title')} subtitle={t('acc.periods.subtitle')} actions={can('accounting.periods.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>{t('acc.periods.newYear')}</Button>} />
      <div className="space-y-4">
        {q.data!.map((y) => (
          <Card key={y.id}>
            <CardHeader title={y.name} subtitle={`${y.startDate} → ${y.endDate}`} />
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {y.periods.map((p) => (
                <div key={p.id} className="rounded-xl border border-line px-3 py-2 text-sm">
                  <p className="flex items-center justify-between gap-2"><b dir="ltr">{p.name}</b><Badge tone={p.status === 'OPEN' ? 'success' : 'neutral'} dot={false}>{p.status === 'OPEN' ? t('acc.periods.open') : t('acc.periods.closed')}</Badge></p>
                  <p className="text-xs text-ink-muted">{p.entries} {t('acc.periods.entries')}</p>
                  {p.reopenReason && p.status === 'OPEN' && <p className="text-xs text-warning-700">{t('acc.periods.reopened', { r: p.reopenReason })}</p>}
                  <div className="mt-1.5">
                    {p.status === 'OPEN' && can('accounting.periods.manage') && <Button size="sm" variant="ghost" icon={<Lock className="h-3.5 w-3.5" />} onClick={async () => (await confirm({ message: t('acc.periods.closeConfirm', { n: p.name }) })) && close.mutate(p.id)}>{t('acc.periods.close')}</Button>}
                    {p.status === 'CLOSED' && can('accounting.periods.reopen') && <Button size="sm" variant="ghost" icon={<LockOpen className="h-3.5 w-3.5" />} onClick={async () => { const reason = await confirm({ message: p.name, reason: { label: t('acc.periods.reopenReason'), required: true } }); if (reason) reopen.mutate({ id: p.id, reason }); }}>{t('acc.periods.reopen')}</Button>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {adding && <NewYear onClose={() => setAdding(false)} last={q.data![0]} />}
    </div>
  );
}

function NewYear({ onClose, last }: { onClose: () => void; last?: Year }) {
  const { t } = useTranslation();
  const y = last ? Number(last.endDate.slice(0, 4)) + 1 : new Date().getFullYear();
  const [v, setV] = useState({ name: `السنة المالية ${y}`, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
  const save = useApiMutation(() => api.post('/accounting/fiscal-years', v), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={t('acc.periods.newYear')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        <Field label={t('acc.periods.name')}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label={t('acc.periods.start')}><Input type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} /></Field>
        <Field label={t('acc.periods.end')}><Input type="date" value={v.endDate} onChange={(e) => setV({ ...v, endDate: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
