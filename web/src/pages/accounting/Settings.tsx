import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { useAccounts, type AccountRow } from '@/lib/accounting';
import { Button, Card, CardHeader, Checkbox, Field, Input, PageHeader, PageLoader, Select, useConfirm } from '@/components/ui';

interface Cfg { requireApproval: boolean; requireReason: boolean; startDate: string | null; inventoryMethod: 'PERPETUAL' | 'PERIODIC'; accountMap: Record<string, string>; methodAccounts: Record<string, string>; expenseAccounts: Record<string, string>; revenueAccounts: Record<string, string> }
interface LinkCfg {
  roles: { key: string; accountId: string | null; custom: boolean }[];
  methods: { id: string; name: string; isActive: boolean; accountId: string | null; custom: boolean }[];
  expenses: { id: string; name: string; isActive: boolean; accountId: string | null; custom: boolean }[];
  revenues: { key: string; accountId: string | null; custom: boolean }[];
}
type MapKey = 'accountMap' | 'methodAccounts' | 'expenseAccounts' | 'revenueAccounts';

export default function AccountingSettings() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['acc', 'settings'], queryFn: () => api.get<Cfg>('/accounting/settings') });
  const link = useQuery({ queryKey: ['acc', 'link-config'], queryFn: () => api.get<LinkCfg>('/accounting/link/config') });
  const accounts = useAccounts();
  const [v, setV] = useState<Cfg | null>(null);
  const [start, setStart] = useState('');
  useEffect(() => { if (q.data) { setV(q.data); setStart(q.data.startDate ?? ''); } }, [q.data]);
  const save = useApiMutation((body: Partial<Cfg>) => api.put<Cfg>('/accounting/settings', body), { invalidate: [['acc']], success: t('acc.settings.saved') });
  if (!v || !link.data || !accounts.data) return <PageLoader />;
  const leafs = accounts.data.filter((a) => !a.isGroup && a.isActive);
  const name = (id: string | null) => { const a = accounts.data!.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : '—'; };
  const pick = (map: MapKey, key: string, current: string | null, types?: string[]) => (
    <Select value={v[map][key] ?? ''} onChange={(e) => { const m = { ...v[map] }; if (e.target.value) m[key] = e.target.value; else delete m[key]; setV({ ...v, [map]: m }); }} className="!h-9">
      <option value="">{t('acc.settings.default')}: {name(v[map][key] ? null : current)}</option>
      {(types ? leafs.filter((a) => types.includes(a.type)) : leafs).map((a: AccountRow) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
    </Select>
  );
  const saveAll = () => save.mutate({ requireApproval: v.requireApproval, requireReason: v.requireReason, inventoryMethod: v.inventoryMethod, accountMap: v.accountMap, methodAccounts: v.methodAccounts, expenseAccounts: v.expenseAccounts, revenueAccounts: v.revenueAccounts });
  return (
    <div>
      <PageHeader title={t('acc.settings.title')} actions={<Button loading={save.isPending} onClick={saveAll}>{t('common.saveChanges')}</Button>} />
      <div className="space-y-4">
        <Card>
          <CardHeader title={t('acc.settings.general')} />
          <div className="space-y-3">
            <Checkbox label={t('acc.settings.requireApproval')} checked={v.requireApproval} onChange={(e) => setV({ ...v, requireApproval: e.target.checked })} />
            <Checkbox label={t('acc.settings.requireReason')} checked={v.requireReason} onChange={(e) => setV({ ...v, requireReason: e.target.checked })} />
            <Field label={t('acc.settings.inventoryMethod')} className="max-w-xl">
              <Select value={v.inventoryMethod} onChange={(e) => setV({ ...v, inventoryMethod: e.target.value as Cfg['inventoryMethod'] })}>
                <option value="PERPETUAL">{t('acc.settings.PERPETUAL')}</option><option value="PERIODIC">{t('acc.settings.PERIODIC')}</option>
              </Select>
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t('acc.settings.startDate')} hint={t('acc.settings.startHint')}><Input type="date" value={start} disabled={!!q.data?.startDate} onChange={(e) => setStart(e.target.value)} /></Field>
              {!q.data?.startDate && <Button variant="success" disabled={!start} loading={save.isPending} onClick={async () => (await confirm({ message: t('acc.settings.startConfirm', { d: start }) })) && save.mutate({ startDate: start })}>{t('common.confirm')}</Button>}
            </div>
            <p className="text-sm text-ink-muted">{t('acc.settings.currency')}</p>
          </div>
        </Card>
        <Card>
          <CardHeader title={t('acc.settings.mapping')} subtitle={t('acc.settings.mappingHint')} />
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h3 className="mb-2 font-bold text-primary-800">{t('acc.settings.methods')}</h3>
              <div className="space-y-2">{link.data.methods.map((m) => <Field key={m.id} label={m.name}>{pick('methodAccounts', m.id, m.accountId, ['ASSET'])}</Field>)}</div>
              <h3 className="mb-2 mt-5 font-bold text-primary-800">{t('acc.settings.revenues')}</h3>
              <div className="space-y-2">{link.data.revenues.map((r) => <Field key={r.key} label={t(`enum.ServiceCategory.${r.key}`)}>{pick('revenueAccounts', r.key, r.accountId, ['REVENUE'])}</Field>)}</div>
            </section>
            <section>
              <h3 className="mb-2 font-bold text-primary-800">{t('acc.settings.expenses')}</h3>
              <div className="space-y-2">{link.data.expenses.map((x) => <Field key={x.id} label={x.name}>{pick('expenseAccounts', x.id, x.accountId, ['EXPENSE', 'ASSET'])}</Field>)}</div>
              <h3 className="mb-2 mt-5 font-bold text-primary-800">{t('acc.settings.roles')}</h3>
              <div className="space-y-2">{link.data.roles.map((r) => <Field key={r.key} label={t(`acc.settings.role.${r.key}`)}>{pick('accountMap', r.key, r.accountId)}</Field>)}</div>
            </section>
          </div>
          <div className="mt-4 flex justify-end"><Button loading={save.isPending} onClick={saveAll}>{t('common.saveChanges')}</Button></div>
        </Card>
      </div>
    </div>
  );
}

