import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Calculator, PackagePlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { amt0, today } from '@/lib/accounting';
import { Badge, Button, Card, DataTable, Dialog, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { AccountSelect, Money, ReportActions, exportXlsx } from './shared';

interface Asset { id: string; code: string; name: string; category: string; purchaseDate: string; cost: string; salvage: string; usefulLifeMonths: number; method: string; rate: string | null; status: string; accumulated: number; bookValue: number; location: string | null; disposedAt: string | null; proceeds: string | null }

export default function Assets() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('accounting.assets.manage');
  const q = useQuery({ queryKey: ['acc', 'assets'], queryFn: () => api.get<Asset[]>('/accounting/assets') });
  const [adding, setAdding] = useState(false);
  const [dep, setDep] = useState(false);
  const [dispose, setDispose] = useState<Asset | null>(null);
  const rows = q.data ?? [];
  const tot = (k: 'cost' | 'accumulated' | 'bookValue') => rows.filter((r) => r.status === 'ACTIVE').reduce((s, r) => s + Number(r[k]), 0);
  const excel = () => exportXlsx(t('ao.as.title'), [{ header: t('ao.as.code'), key: 'code' }, { header: t('ao.as.name'), key: 'name' }, { header: t('ao.as.category'), key: 'category' }, { header: t('ao.as.purchaseDate'), key: 'purchaseDate' }, { header: t('ao.as.cost'), key: 'c', money: true }, { header: t('ao.as.accumulated'), key: 'accumulated', money: true }, { header: t('ao.as.book'), key: 'bookValue', money: true }, { header: t('acc.f.status'), key: 's' }],
    rows.map((r) => ({ ...r, c: Number(r.cost), s: t(`ao.as.st.${r.status}`) })), ['c', 'accumulated', 'bookValue']);
  return (
    <div>
      <PageHeader title={t('ao.as.title')} subtitle={t('ao.as.subtitle')} actions={<ReportActions onExcel={excel} extra={manage && <>
        <Button variant="outline" icon={<Calculator className="h-4 w-4" />} onClick={() => setDep(true)}>{t('ao.as.runDep')}</Button>
        <Button icon={<PackagePlus className="h-4 w-4" />} onClick={() => setAdding(true)}>{t('ao.as.new')}</Button>
      </>} />} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Badge tone="primary" dot={false}>{t('ao.as.cost')}: {amt0(tot('cost'))}</Badge>
        <Badge tone="warning" dot={false}>{t('ao.as.accumulated')}: {amt0(tot('accumulated'))}</Badge>
        <Badge tone="success" dot={false}>{t('ao.as.book')}: {amt0(tot('bookValue'))}</Badge>
      </div>
      <Card padded={false}>
        <DataTable rows={rows} loading={q.isLoading} error={q.error} rowKey={(r) => r.id} rowClassName={(r) => (r.status !== 'ACTIVE' ? 'opacity-60' : undefined)} columns={[
          { key: 'c', header: t('ao.as.code'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.code}</span> },
          { key: 'n', header: t('ao.as.name'), cell: (r) => <><b>{r.name}</b><span className="block text-xs text-ink-muted">{r.category}{r.location && ` · ${r.location}`}</span></> },
          { key: 'd', header: t('ao.as.purchaseDate'), cell: (r) => r.purchaseDate },
          { key: 'l', header: t('ao.as.life'), hideOnMobile: true, cell: (r) => `${r.usefulLifeMonths} ${t('ao.as.months')} · ${t(`ao.as.m.${r.method}`)}` },
          { key: 'k', header: t('ao.as.cost'), align: 'end', cell: (r) => <Money v={r.cost} /> },
          { key: 'a', header: t('ao.as.accumulated'), align: 'end', cell: (r) => <Money v={r.accumulated} /> },
          { key: 'b', header: t('ao.as.book'), align: 'end', cell: (r) => <b><Money v={r.bookValue} /></b> },
          { key: 's', header: t('acc.f.status'), cell: (r) => <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'} dot={false}>{t(`ao.as.st.${r.status}`)}{r.disposedAt && ` ${r.disposedAt}`}</Badge> },
          { key: 'x', header: '', cell: (r) => manage && r.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={() => setDispose(r)}>{t('ao.as.dispose')}</Button> },
        ]} />
      </Card>
      {adding && <AssetForm onClose={() => setAdding(false)} />}
      {dep && <DepForm onClose={() => setDep(false)} />}
      {dispose && <DisposeForm a={dispose} onClose={() => setDispose(null)} />}
    </div>
  );
}

function AssetForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ name: '', accountId: '', purchaseDate: today(), cost: '', salvage: '0', usefulLifeMonths: '60', method: 'STRAIGHT_LINE', rate: '', fundingAccountId: '', location: '', notes: '' });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const save = useApiMutation(() => api.post('/accounting/assets', { ...v, cost: Number(v.cost), salvage: Number(v.salvage || 0), usefulLifeMonths: Number(v.usefulLifeMonths), rate: v.rate ? Number(v.rate) : null, location: v.location || null, notes: v.notes || null }), { invalidate: [['acc']], onSuccess: onClose });
  const monthly = v.method === 'STRAIGHT_LINE' && Number(v.cost) ? (Number(v.cost) - Number(v.salvage || 0)) / Number(v.usefulLifeMonths || 1) : null;
  return (
    <Dialog open onClose={onClose} size="lg" title={t('ao.as.new')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.as.name')} required className="sm:col-span-2"><Input value={v.name} onChange={set('name')} /></Field>
        <Field label={t('ao.as.category')} required hint={t('ao.as.categoryHint')}><AccountSelect types={['ASSET']} value={v.accountId} onChange={(x) => setV({ ...v, accountId: x })} /></Field>
        <Field label={t('ao.as.funding')} required hint={t('ao.as.fundingHint')}><AccountSelect value={v.fundingAccountId} onChange={(x) => setV({ ...v, fundingAccountId: x })} /></Field>
        <Field label={t('ao.as.purchaseDate')}><Input type="date" value={v.purchaseDate} onChange={set('purchaseDate')} /></Field>
        <Field label={t('ao.as.cost')} required><Input type="number" step="0.001" dir="ltr" value={v.cost} onChange={set('cost')} /></Field>
        <Field label={t('ao.as.salvage')}><Input type="number" step="0.001" dir="ltr" value={v.salvage} onChange={set('salvage')} /></Field>
        <Field label={t('ao.as.lifeMonths')}><Input type="number" dir="ltr" value={v.usefulLifeMonths} onChange={set('usefulLifeMonths')} /></Field>
        <Field label={t('ao.as.method')}><Select value={v.method} onChange={set('method')}><option value="STRAIGHT_LINE">{t('ao.as.m.STRAIGHT_LINE')}</option><option value="DECLINING">{t('ao.as.m.DECLINING')}</option></Select></Field>
        {v.method === 'DECLINING' && <Field label={t('ao.as.rate')}><Input type="number" dir="ltr" value={v.rate} onChange={set('rate')} /></Field>}
        <Field label={t('ao.as.location')}><Input value={v.location} onChange={set('location')} /></Field>
        <Field label={t('ao.notes')} className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field>
      </div>
      {monthly != null && monthly > 0 && <p className="mt-3 rounded-xl bg-primary-50 px-3 py-2 text-sm text-primary-800">{t('ao.as.monthly', { v: amt0(monthly) })}</p>}
    </Dialog>
  );
}

function DepForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const [month, setMonth] = useState(d.toLocaleDateString('en-CA').slice(0, 7));
  const run = useApiMutation(() => api.post<{ assets: number; total: number }>('/accounting/assets/depreciation', { month }), { invalidate: [['acc']], success: false });
  return (
    <Dialog open onClose={onClose} size="sm" title={t('ao.as.runDep')} footer={<><Button variant="outline" onClick={onClose}>{t('common.close')}</Button><Button loading={run.isPending} onClick={() => run.mutate(undefined)}>{t('ao.as.calc')}</Button></>}>
      <Field label={t('ao.pay.month')}><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
      <p className="mt-2 text-xs text-ink-muted">{t('ao.as.depHint')}</p>
      {run.data && <p className="mt-3 rounded-xl bg-success-50 px-3 py-2 text-sm text-success-700">{t('ao.as.depDone', { n: run.data.assets, t: amt0(run.data.total) })}</p>}
    </Dialog>
  );
}

function DisposeForm({ a, onClose }: { a: Asset; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ date: today(), sold: 'true', proceeds: '', proceedsAccountId: '', notes: '' });
  const sold = v.sold === 'true';
  const result = sold ? Number(v.proceeds || 0) - a.bookValue : -a.bookValue;
  const save = useApiMutation(() => api.post(`/accounting/assets/${a.id}/dispose`, { date: v.date, sold, proceeds: Number(v.proceeds || 0), proceedsAccountId: v.proceedsAccountId || null, notes: v.notes || null }), { invalidate: [['acc']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={`${t('ao.as.dispose')}: ${a.name}`} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button variant="danger" loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <p className="mb-3 text-sm">{t('ao.as.book')}: <b>{amt0(a.bookValue)}</b></p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ao.date')}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label={t('ao.as.how')}><Select value={v.sold} onChange={(e) => setV({ ...v, sold: e.target.value })}><option value="true">{t('ao.as.st.SOLD')}</option><option value="false">{t('ao.as.st.DISPOSED')}</option></Select></Field>
        {sold && <><Field label={t('ao.as.proceeds')}><Input type="number" step="0.001" dir="ltr" value={v.proceeds} onChange={(e) => setV({ ...v, proceeds: e.target.value })} /></Field>
          <Field label={t('ao.as.proceedsAccount')}><AccountSelect types={['ASSET']} value={v.proceedsAccountId} onChange={(x) => setV({ ...v, proceedsAccountId: x })} /></Field></>}
        <Field label={t('ao.notes')} className="sm:col-span-2"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
      <p className={`mt-3 rounded-xl px-3 py-2 text-sm ${result >= 0 ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'}`}>{result >= 0 ? t('ao.as.gain', { v: amt0(result) }) : t('ao.as.loss', { v: amt0(-result) })}</p>
    </Dialog>
  );
}
