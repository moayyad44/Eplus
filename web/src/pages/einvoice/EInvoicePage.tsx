import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, Save, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { fmtDateTime, fmtDay, money } from '@/lib/format';
import { RESENDABLE, type EInvoiceStatus } from '@/lib/einvoice';
import { Badge, Button, Card, CardHeader, Checkbox, DataTable, DateRangePicker, Dialog, Field, Input, PageHeader, PageLoader, Pagination, SearchInput, Select, StatCard, Tabs, presetRange, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

type Tab = 'monitor' | 'settings';

export default function EInvoicePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs: Tab[] = [...(can('einvoice.view') ? (['monitor'] as const) : []), ...(can('einvoice.settings') ? (['settings'] as const) : [])];
  const tab = tabs.find((k) => k === params.get('tab')) ?? tabs[0];
  return (
    <div>
      <PageHeader title={t('einv.title')} subtitle={t('einv.subtitle')} />
      {tabs.length > 1 && <Tabs items={tabs.map((k) => ({ key: k, label: t(`einv.tabs.${k}`) }))} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} className="mb-4" />}
      {tab === 'monitor' && <Monitor />}
      {tab === 'settings' && <SettingsForm />}
    </div>
  );
}

interface Summary {
  config: { enabled: boolean; missing: string[] };
  counts: Record<EInvoiceStatus, number>;
  period: { sales: { count: number; total: number }; returns: { count: number; total: number } };
  lastSubmittedAt: string | null;
  oldestOpenAt: string | null;
}
interface Row {
  id: string; kind: 'SALE' | 'RETURN'; party: 'PATIENT' | 'COMPANY'; docNumber: string; icv: number | null; typeName: string; issueDate: string; total: number;
  status: EInvoiceStatus; attempts: number; lastAttemptAt: string | null; nextAttemptAt: string | null; submittedAt: string | null; lastError: string | null; reason: string | null;
  invoice: { id: string; invoiceNumber: string | null; status: string; payerType: string; insuranceCompany: { nameAr: string } | null };
}

const NEEDS_ACTION = 'REJECTED,FAILED,UNKNOWN,PENDING';

function Monitor() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState(presetRange('month'));
  const summary = useQuery({ queryKey: ['einvoice', 'summary', range], queryFn: () => api.get<Summary>('/einvoice/summary', { ...range }), refetchInterval: 30_000 });
  const list = usePagedList<Row, { status?: string; kind?: string; from?: string; to?: string }>('einvoice-docs', '/einvoice/documents', { filters: {} });
  const retry = useApiMutation(() => api.post<{ tried: number }>('/einvoice/retry'), {
    invalidate: [['einvoice'], ['einvoice-docs']], success: false, onSuccess: (r) => toast.success(t('einv.retryAllDone', { n: r.tried })),
  });
  const resend = useApiMutation((id: string) => api.post<{ status: string; lastError: string | null }>(`/einvoice/documents/${id}/send`), {
    invalidate: [['einvoice'], ['einvoice-docs']], success: false,
    onSuccess: (r) => (r.status === 'SUBMITTED' ? toast.success(t('enum.EInvoiceStatus.SUBMITTED')) : toast.error(r.lastError ?? t(`enum.EInvoiceStatus.${r.status}`))),
  });
  const docId = params.get('doc');
  const s = summary.data;
  const c = s?.counts;
  const stuck = c ? c.UNKNOWN + c.FAILED + c.PENDING : 0;
  const filterBy = (status?: string) => list.setFilters({ status });
  return (
    <div className="space-y-4">
      {s && !s.config.enabled && (
        <div className="flex items-start gap-2 rounded-2xl border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('einv.off')}{s.config.missing.length > 0 && <> {t('einv.incomplete', { list: s.config.missing.join('، ') })}</>}</span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label={t('einv.counts.SUBMITTED')} value={c?.SUBMITTED ?? '—'} tone="success" icon={<CheckCircle2 className="h-5 w-5" />} hint={s?.lastSubmittedAt ? `${t('einv.lastOk')}: ${fmtDateTime(s.lastSubmittedAt)}` : undefined} onClick={() => filterBy('SUBMITTED')} />
        <StatCard label={t('einv.counts.REJECTED')} value={c?.REJECTED ?? '—'} tone="danger" icon={<XCircle className="h-5 w-5" />} onClick={() => filterBy('REJECTED')} />
        <StatCard label={t('einv.counts.FAILED')} value={c?.FAILED ?? '—'} tone="danger" icon={<XCircle className="h-5 w-5" />} onClick={() => filterBy('FAILED')} />
        <StatCard label={t('einv.counts.UNKNOWN')} value={c?.UNKNOWN ?? '—'} tone="warning" icon={<Clock className="h-5 w-5" />} onClick={() => filterBy('UNKNOWN')} />
        <StatCard label={t('einv.counts.PENDING')} value={c?.PENDING ?? '—'} tone="primary" icon={<Clock className="h-5 w-5" />} hint={s?.oldestOpenAt ? `${t('einv.oldestOpen')}: ${fmtDateTime(s.oldestOpenAt)}` : undefined} onClick={() => filterBy('PENDING')} />
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <DateRangePicker value={range} onChange={setRange} />
          <span className="rounded-xl bg-success-50 px-3 py-1.5 text-success-700">{t('einv.period.sales')}: <b className="tabular-nums">{s?.period.sales.count ?? 0}</b> · <b className="tabular-nums">{money(s?.period.sales.total ?? 0)}</b></span>
          <span className="rounded-xl bg-violet-50 px-3 py-1.5 text-violet-700">{t('einv.period.returns')}: <b className="tabular-nums">{s?.period.returns.count ?? 0}</b> · <b className="tabular-nums">{money(s?.period.returns.total ?? 0)}</b></span>
          {can('einvoice.send') && stuck > 0 && <Button className="ms-auto" variant="outline" icon={<RefreshCw className="h-4 w-4" />} loading={retry.isPending} onClick={() => retry.mutate(undefined)}>{t('einv.retryAll')}</Button>}
        </div>
      </Card>
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('einv.docNumber')} className="w-full sm:w-64" />
          <Select value={list.filters.status ?? ''} onChange={(e) => list.setFilters({ status: e.target.value || undefined })} className="w-auto">
            <option value="">{t('einv.filterAll')}</option>
            <option value={NEEDS_ACTION}>{t('einv.needsAction')}</option>
            {(['SUBMITTED', 'REJECTED', 'FAILED', 'UNKNOWN', 'PENDING', 'SENDING', 'VOID'] as const).map((st) => <option key={st} value={st}>{t(`enum.EInvoiceStatus.${st}`)}</option>)}
          </Select>
          <Select value={list.filters.kind ?? ''} onChange={(e) => list.setFilters({ kind: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.type')}: {t('common.all')}</option>
            <option value="SALE">{t('einv.kind.SALE')}</option>
            <option value="RETURN">{t('einv.kind.RETURN')}</option>
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          empty={<p className="py-6 text-center text-sm text-ink-muted">{t('einv.noDocs')}</p>}
          columns={[
            { key: 'n', header: t('einv.docNumber'), cell: (r) => <button type="button" className="font-mono text-xs font-semibold text-primary-700 hover:underline" dir="ltr" onClick={() => setParams({ doc: r.id }, { replace: true })}>{r.docNumber}</button> },
            { key: 'k', header: t('common.type'), cell: (r) => <span className="text-xs">{t(`einv.kind.${r.kind}`)} · {t(`einv.party.${r.party}`)}{r.invoice.insuranceCompany && r.party === 'COMPANY' && <span className="block text-ink-muted">{r.invoice.insuranceCompany.nameAr}</span>}</span> },
            { key: 'i', header: t('einv.invoice'), cell: (r) => <Link to={`/billing/invoices/${r.invoice.id}`} className="font-mono text-xs hover:text-primary-700">{r.invoice.invoiceNumber}</Link> },
            { key: 'd', header: t('einv.issueDate'), hideOnMobile: true, cell: (r) => <bdi className="text-xs">{fmtDay(r.issueDate)}</bdi> },
            { key: 'a', header: t('einv.total'), cell: (r) => <b className="tabular-nums">{money(r.total)}</b> },
            { key: 's', header: t('common.status'), cell: (r) => <span><StatusBadge enumName="EInvoiceStatus" value={r.status} />{r.lastError && r.status !== 'SUBMITTED' && <span className="mt-1 block max-w-[280px] text-[11px] text-danger-700">{r.lastError}</span>}</span> },
            { key: 't', header: t('einv.sentAt'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.lastAttemptAt ? fmtDateTime(r.lastAttemptAt) : '—'}<span className="block text-ink-muted">{t('einv.attempts')}: {r.attempts}</span></span> },
            {
              key: 'x', header: '', cell: (r) => RESENDABLE.includes(r.status) && can('einvoice.send') && (
                <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={resend.isPending && resend.variables === r.id} onClick={() => resend.mutate(r.id)}>{t('einv.resend')}</Button>
              ),
            },
          ]}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
      {docId && <DocDialog id={docId} onClose={() => { params.delete('doc'); setParams(params, { replace: true }); }} />}
    </div>
  );
}

interface DocDetail {
  id: string; kind: string; party: string; docNumber: string; uuid: string; icv: number | null; typeName: string; issueDate: string; total: number; status: EInvoiceStatus;
  reason: string | null; xml: string; lastError: string | null; submittedAt: string | null; einvNum: string | null;
  invoice: { id: string; invoiceNumber: string | null }; original: { id: string; docNumber: string } | null;
  attemptsLog: { id: string; at: string; httpStatus: number | null; einvStatus: string | null; outcome: string; message: string | null; durationMs: number | null; userId: string | null }[];
  userNames: Record<string, string>;
}

function DocDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['einvoice', 'doc', id], queryFn: () => api.get<DocDetail>(`/einvoice/documents/${id}`) });
  const [showXml, setShowXml] = useState(false);
  const d = q.data;
  const row = (label: string, value: React.ReactNode) => <div className="flex justify-between gap-3"><dt className="text-ink-muted">{label}</dt><dd className="text-end">{value}</dd></div>;
  return (
    <Dialog open onClose={onClose} size="lg" title={d ? `${t(`einv.kind.${d.kind}`)} — ${d.docNumber}` : t('einv.details')}>
      {!d ? <PageLoader /> : (
        <div className="space-y-4 text-sm">
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {row(t('common.status'), <StatusBadge enumName="EInvoiceStatus" value={d.status} />)}
            {row(t('einv.invoice'), <Link to={`/billing/invoices/${d.invoice.id}`} className="font-mono text-primary-700 hover:underline">{d.invoice.invoiceNumber}</Link>)}
            {row(t('einv.docNumber'), <span className="font-mono" dir="ltr">{d.docNumber}</span>)}
            {row('UUID', <span className="break-all font-mono text-[11px]" dir="ltr">{d.uuid}</span>)}
            {row('ICV', <span className="font-mono">{d.icv ?? '—'}</span>)}
            {row(t('common.type'), `${t(`einv.party.${d.party}`)} · ${t(`einv.type.${d.typeName}`)}`)}
            {row(t('einv.issueDate'), <bdi>{fmtDay(d.issueDate)}</bdi>)}
            {row(t('einv.total'), <b className="tabular-nums">{money(d.total)}</b>)}
            {d.original && row(t('einv.original'), <span className="font-mono" dir="ltr">{d.original.docNumber}</span>)}
            {d.reason && row(t('einv.reason'), d.reason)}
            {d.submittedAt && row(t('einv.submittedAt'), <bdi>{fmtDateTime(d.submittedAt)}</bdi>)}
          </dl>
          {d.lastError && d.status !== 'SUBMITTED' && <p className="rounded-xl bg-danger-50 px-3 py-2 text-xs text-danger-700">{d.lastError}</p>}
          <div>
            <CardHeader title={t('einv.attemptsLog')} className="mb-2" />
            <DataTable
              rows={d.attemptsLog}
              rowKey={(a) => a.id}
              dense
              empty={<p className="py-3 text-center text-xs text-ink-muted">{t('common.noData')}</p>}
              columns={[
                { key: 'at', header: t('common.date'), cell: (a) => <bdi className="text-xs">{fmtDateTime(a.at)}</bdi> },
                { key: 'h', header: 'HTTP', cell: (a) => <span className="font-mono text-xs">{a.httpStatus ?? '—'}</span> },
                { key: 'e', header: 'EINV_STATUS', cell: (a) => <span className="font-mono text-xs">{a.einvStatus ?? '—'}</span> },
                { key: 'o', header: t('common.status'), cell: (a) => <span><StatusBadge enumName="EInvoiceStatus" value={a.outcome} dot={false} />{a.message && <span className="mt-1 block max-w-[260px] text-[11px] text-ink-muted">{a.message}</span>}</span> },
                { key: 'u', header: t('common.user'), cell: (a) => <span className="text-xs">{a.userId ? d.userNames[a.userId] : t('einv.auto')}</span> },
              ]}
            />
          </div>
          {d.xml && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setShowXml(!showXml)}>{t('einv.xml')}</Button>
              {showXml && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface-subtle p-3 text-[11px]" dir="ltr">{d.xml.replace(/></g, '>\n<')}</pre>}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

interface Config {
  enabled: boolean; taxNumber: string; sellerName: string; incomeSourceSeq: string; zeroCategory: 'Z' | 'O'; timeoutSec: number;
  hasClientId: boolean; hasSecretKey: boolean; clientIdHint: string; credentialsReadable: boolean; credentialsUpdatedAt: string | null;
  endpoint: string | null; official: boolean; missing: string[];
}

function SettingsForm() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['einvoice', 'config'], queryFn: () => api.get<Config>('/einvoice/config') });
  const companies = useQuery({ queryKey: ['einvoice', 'companies'], queryFn: () => api.get<{ id: string; nameAr: string; taxNumber: string | null; einvoiceMode: string; isActive: boolean }[]>('/einvoice/companies') });
  const [f, setF] = useState<Partial<Config> & { clientId?: string; secretKey?: string }>({});
  useEffect(() => { if (q.data) setF({ ...q.data, clientId: '', secretKey: '' }); }, [q.data]);
  const save = useApiMutation((body: object) => api.put<Config>('/einvoice/config', body), {
    invalidate: [['einvoice']], success: t('einv.s.saved'), onSuccess: () => setF((x) => ({ ...x, clientId: '', secretKey: '' })),
  });
  if (q.isLoading || !q.data) return <PageLoader />;
  const c = q.data;
  const submit = () => save.mutate({
    enabled: f.enabled, taxNumber: f.taxNumber, sellerName: f.sellerName, incomeSourceSeq: f.incomeSourceSeq, zeroCategory: f.zeroCategory, timeoutSec: Number(f.timeoutSec),
    ...(f.clientId && { clientId: f.clientId }), ...(f.secretKey && { secretKey: f.secretKey }),
  });
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <Card>
        <p className="mb-4 rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800">{t('einv.s.intro')}</p>
        {!c.credentialsReadable && <p className="mb-4 rounded-xl bg-danger-50 px-3 py-2 text-xs text-danger-700">{t('einv.s.unreadable')}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('einv.s.taxNumber')} required error={save.fieldErrors.taxNumber}><Input dir="ltr" inputMode="numeric" value={f.taxNumber ?? ''} onChange={(e) => setF({ ...f, taxNumber: e.target.value })} /></Field>
          <Field label={t('einv.s.incomeSourceSeq')} required error={save.fieldErrors.incomeSourceSeq}><Input dir="ltr" inputMode="numeric" value={f.incomeSourceSeq ?? ''} onChange={(e) => setF({ ...f, incomeSourceSeq: e.target.value })} /></Field>
          <Field label={t('einv.s.sellerName')} required className="sm:col-span-2"><Input value={f.sellerName ?? ''} onChange={(e) => setF({ ...f, sellerName: e.target.value })} /></Field>
          <Field label={t('einv.s.clientId')} required hint={c.hasClientId ? t('einv.s.storedHint', { hint: c.clientIdHint }) : t('einv.s.notStored')}>
            <Input dir="ltr" autoComplete="off" spellCheck={false} placeholder={c.hasClientId ? '••••••••' : ''} value={f.clientId ?? ''} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
          </Field>
          <Field label={t('einv.s.secretKey')} required hint={c.hasSecretKey ? t('einv.s.storedHint', { hint: '••••' }) : t('einv.s.notStored')}>
            <Input dir="ltr" type="password" autoComplete="new-password" placeholder={c.hasSecretKey ? '••••••••' : ''} value={f.secretKey ?? ''} onChange={(e) => setF({ ...f, secretKey: e.target.value })} />
          </Field>
          <Field label={t('einv.s.zeroCategory')} hint={t('einv.s.noTax')}>
            <Select value={f.zeroCategory ?? 'Z'} onChange={(e) => setF({ ...f, zeroCategory: e.target.value as 'Z' | 'O' })}>
              <option value="Z">{t('einv.s.zeroZ')}</option>
              <option value="O">{t('einv.s.zeroO')}</option>
            </Select>
          </Field>
          <Field label={t('einv.s.timeout')}><Input type="number" min={5} max={120} value={f.timeoutSec ?? 30} onChange={(e) => setF({ ...f, timeoutSec: Number(e.target.value) })} /></Field>
          <div className="sm:col-span-2"><Checkbox label={<b>{t('einv.s.enabled')}</b>} checked={!!f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /></div>
        </div>
        {c.missing.length > 0 && <p className="mt-3 text-xs text-warning-800">{t('einv.incomplete', { list: c.missing.join('، ') })}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={submit}>{t('common.save')}</Button>
          {(c.hasClientId || c.hasSecretKey) && (
            <Button variant="ghost" onClick={async () => (await confirm({ message: t('einv.s.clearConfirm'), danger: true })) && save.mutate({ clearCredentials: true, enabled: false })}>{t('einv.s.clear')}</Button>
          )}
        </div>
      </Card>
      <div className="space-y-4">
        <Card>
          <dl className="space-y-1.5 text-sm">
            <div><dt className="text-ink-muted">{t('einv.s.endpoint')}</dt><dd className="break-all font-mono text-xs" dir="ltr">{c.endpoint ?? t('einv.s.noEndpoint')}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-ink-muted">{t('einv.s.noTest')}</p>
        </Card>
        <Card>
          <CardHeader title={t('einv.s.companies')} subtitle={t('einv.s.companiesHint')} />
          <ul className="space-y-2 text-sm">
            {companies.data?.map((co) => (
              <li key={co.id} className="flex items-start justify-between gap-2">
                <Link to={`/insurance/companies/${co.id}`} className="font-semibold hover:text-primary-700">{co.nameAr}</Link>
                <Badge dot={false} tone={co.einvoiceMode === 'PATIENT_SHARE' ? 'neutral' : 'primary'} className="text-end">{t(`einv.mode.${co.einvoiceMode}`)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
