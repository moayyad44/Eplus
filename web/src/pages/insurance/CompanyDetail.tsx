import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money, num } from '@/lib/format';
import type { Company, Contract, Rule } from '@/lib/insurance';
import type { ServiceCategory } from '@/lib/types';
import { Badge, Button, Card, CardHeader, Checkbox, DataTable, DateRangePicker, Dialog, ErrorState, Field, IconButton, Input, PageHeader, PageLoader, Select, Tabs, Textarea, presetRange } from '@/components/ui';
import { useServices } from '@/components/insurance/widgets';
import { CompanyDialog } from './Companies';

const CATEGORIES: ServiceCategory[] = ['EXAMINATION', 'CONSULTATION', 'PROCEDURE', 'LAB', 'NURSING', 'MEDICATION', 'OTHER'];

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const [tab, setTab] = useState<'contracts' | 'account'>('contracts');
  const [editCompany, setEditCompany] = useState(false);
  const [contract, setContract] = useState<Contract | 'new' | null>(null);
  const q = useQuery({ queryKey: ['insurance', 'company', id], queryFn: () => api.get<Omit<Company, 'contracts'> & { contracts: Contract[] }>(`/insurance/companies/${id}`) });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  return (
    <div>
      <Link to="/insurance/companies" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-primary-700"><ArrowRight className="h-3.5 w-3.5 ltr:rotate-180" />{t('ins.companies')}</Link>
      <PageHeader
        title={<span className="flex items-center gap-2">{c.nameAr}<Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? t('common.active') : t('common.inactive')}</Badge></span>}
        subtitle={[c.nameEn, c.contractNumber && `${t('ins.f.contractNumber')}: ${c.contractNumber}`, c.contractEnd && `${t('ins.f.contractEnd')}: ${fmtDate(c.contractEnd)}`, c.phone, c.contactPerson].filter(Boolean).join(' · ')}
        actions={can('insurance.company.manage') && <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditCompany(true)}>{t('common.edit')}</Button>}
      />
      <Tabs items={[{ key: 'contracts', label: t('ins.contracts') }, { key: 'account', label: t('ins.account'), hidden: !can('insurance.report.view') }]} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'contracts' && (
        <div className="space-y-4">
          {can('insurance.contract.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setContract('new')}>{t('ins.newContract')}</Button>}
          {c.contracts.map((k) => (
            <Card key={k.id}>
              <CardHeader
                title={<span className="flex items-center gap-2">{k.name}<Badge tone={k.isActive ? 'success' : 'neutral'}>{k.isActive ? t('common.active') : t('common.inactive')}</Badge></span>}
                subtitle={[k.contractNumber, k.startDate && `${fmtDate(k.startDate)} ← ${fmtDate(k.endDate)}`, `${t('ins.f.coveragePercent')}: ${num(k.coveragePercent)}%`, `${t('ins.f.annualLimit')}: ${k.annualLimit != null ? money(k.annualLimit) : t('ins.f.unlimited')}`].filter(Boolean).join(' · ')}
                actions={can('insurance.contract.manage') && <Button size="sm" variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setContract(k)}>{t('common.edit')}</Button>}
              />
              {k.rules.length === 0 ? <p className="text-sm text-ink-muted">{t('ins.rules.none')}</p> : (
                <DataTable dense rows={k.rules} rowKey={(r) => r.id ?? `${r.serviceId}${r.category}`} columns={ruleColumns((k) => t(k))} />
              )}
              {(k.coveredServices || k.excludedServices || k.terms) && (
                <div className="mt-3 grid gap-2 text-xs text-ink-soft sm:grid-cols-3">
                  {k.coveredServices && <p><b>{t('ins.f.coveredServices')}:</b> {k.coveredServices}</p>}
                  {k.excludedServices && <p><b>{t('ins.f.excludedServices')}:</b> {k.excludedServices}</p>}
                  {k.terms && <p><b>{t('ins.f.terms')}:</b> {k.terms}</p>}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {tab === 'account' && <AccountStatement companyId={c.id} />}
      {editCompany && <CompanyDialog company={c as unknown as Company} onClose={() => setEditCompany(false)} />}
      {contract && <ContractDialog companyId={c.id} contract={contract === 'new' ? null : contract} onClose={() => setContract(null)} />}
    </div>
  );
}

const ruleColumns = (t: (k: string) => string) => [
  { key: 'tg', header: t('ins.rules.target'), cell: (r: Rule) => (r.service ? <><b>{r.service.name}</b> <span className="text-xs text-ink-muted">({t('ins.rules.service')})</span></> : <><b>{t(`enum.ServiceCategory.${r.category}`)}</b> <span className="text-xs text-ink-muted">({t('ins.rules.category')})</span></>) },
  { key: 'cv', header: t('ins.rules.coveragePercent'), cell: (r: Rule) => (!r.covered ? <Badge tone="danger" dot={false}>{t('ins.rules.notCovered')}</Badge> : r.patientFixed != null ? `${t('ins.rules.patientFixed')}: ${money(r.patientFixed)}` : r.coveragePercent != null ? `${num(r.coveragePercent)}%` : '—') },
  { key: 'mx', header: t('ins.rules.maxAmount'), cell: (r: Rule) => (r.maxAmount != null ? money(r.maxAmount) : '—') },
  { key: 'pr', header: t('ins.rules.price'), cell: (r: Rule) => (r.price != null ? money(r.price) : '—') },
  { key: 'ap', header: t('ins.rules.requiresApproval'), cell: (r: Rule) => (r.requiresApproval ? <Badge tone="warning" dot={false}>{t('common.yes')}</Badge> : '—') },
  { key: 'rp', header: t('ins.rules.requiresReport'), cell: (r: Rule) => (r.requiresReport ? <Badge tone="info" dot={false}>{t('common.yes')}</Badge> : '—') },
];

type RuleRow = { serviceId: string | null; category: ServiceCategory | null; covered: boolean; coveragePercent: string; patientFixed: string; maxAmount: string; price: string; requiresApproval: boolean; requiresReport: boolean; notes: string };
const toRow = (r: Rule): RuleRow => ({
  serviceId: r.serviceId, category: r.category, covered: r.covered, coveragePercent: r.coveragePercent == null ? '' : String(num(r.coveragePercent)), patientFixed: r.patientFixed == null ? '' : String(num(r.patientFixed)),
  maxAmount: r.maxAmount == null ? '' : String(num(r.maxAmount)), price: r.price == null ? '' : String(num(r.price)), requiresApproval: r.requiresApproval, requiresReport: r.requiresReport, notes: r.notes ?? '',
});

function ContractDialog({ companyId, contract, onClose }: { companyId: string; contract: Contract | null; onClose: () => void }) {
  const { t } = useTranslation();
  const services = useServices();
  const [v, setV] = useState({
    name: contract?.name ?? '', contractNumber: contract?.contractNumber ?? '', startDate: contract?.startDate?.slice(0, 10) ?? '', endDate: contract?.endDate?.slice(0, 10) ?? '',
    isActive: contract?.isActive ?? true, coveragePercent: String(num(contract?.coveragePercent ?? 80)), annualLimit: contract?.annualLimit == null ? '' : String(num(contract.annualLimit)),
    terms: contract?.terms ?? '', coveredServices: contract?.coveredServices ?? '', excludedServices: contract?.excludedServices ?? '', notes: contract?.notes ?? '',
  });
  const [rules, setRules] = useState<RuleRow[]>(contract?.rules.map(toRow) ?? []);
  const [pick, setPick] = useState('');
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const setRule = (i: number, p: Partial<RuleRow>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const add = (value: string) => {
    if (!value) return;
    const [kind, key] = value.split(':');
    const base = { covered: true, coveragePercent: '', patientFixed: '', maxAmount: '', price: '', requiresApproval: false, requiresReport: false, notes: '' };
    setRules([...rules, kind === 'cat' ? { ...base, serviceId: null, category: key as ServiceCategory } : { ...base, serviceId: key, category: null }]);
    setPick('');
  };
  const nul = (s: string) => (s === '' ? null : Number(s));
  const save = useApiMutation(
    () => {
      const body = {
        ...v, startDate: v.startDate || null, endDate: v.endDate || null, annualLimit: v.annualLimit || null,
        rules: rules.map((r) => ({ ...r, coveragePercent: nul(r.coveragePercent), patientFixed: nul(r.patientFixed), maxAmount: nul(r.maxAmount), price: nul(r.price), notes: r.notes || null })),
      };
      return contract ? api.put(`/insurance/contracts/${contract.id}`, body) : api.post(`/insurance/companies/${companyId}/contracts`, body);
    },
    { invalidate: [['insurance']], onSuccess: onClose },
  );
  const fe = save.fieldErrors;
  const svcName = (sid: string) => services.data?.find((s) => s.id === sid)?.name ?? sid;
  const usedCats = new Set(rules.map((r) => r.category));
  const usedSvc = new Set(rules.map((r) => r.serviceId));
  return (
    <Dialog open onClose={onClose} size="xl" title={contract ? contract.name : t('ins.newContract')}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('ins.f.name')} required error={fe.name}><Input value={v.name} onChange={set('name')} /></Field>
        <Field label={t('ins.f.contractNumber')}><Input value={v.contractNumber} onChange={set('contractNumber')} dir="ltr" /></Field>
        <Field label={t('ins.f.coveragePercent')} error={fe.coveragePercent}><Input type="number" min={0} max={100} value={v.coveragePercent} onChange={set('coveragePercent')} dir="ltr" /></Field>
        <Field label={t('ins.f.startDate')}><Input type="date" value={v.startDate} onChange={set('startDate')} /></Field>
        <Field label={t('ins.f.endDate')} error={fe.endDate}><Input type="date" value={v.endDate} onChange={set('endDate')} /></Field>
        <Field label={t('ins.f.annualLimit')} hint={t('ins.f.unlimited')}><Input type="number" min={0} step="0.001" value={v.annualLimit} onChange={set('annualLimit')} dir="ltr" /></Field>
        <Field label={t('ins.f.coveredServices')}><Textarea rows={2} value={v.coveredServices} onChange={set('coveredServices')} /></Field>
        <Field label={t('ins.f.excludedServices')}><Textarea rows={2} value={v.excludedServices} onChange={set('excludedServices')} /></Field>
        <Field label={t('ins.f.terms')}><Textarea rows={2} value={v.terms} onChange={set('terms')} /></Field>
        <Checkbox label={t('common.active')} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
      </div>
      <div className="mt-5">
        <h4 className="mb-1 text-sm font-bold">{t('ins.rules.title')}</h4>
        <p className="mb-3 text-xs leading-relaxed text-ink-muted">{t('ins.rules.hint')}</p>
        {fe.rules && <p className="mb-2 text-xs text-danger-600">{fe.rules}</p>}
        <Select value={pick} onChange={(e) => add(e.target.value)} className="mb-3 max-w-md">
          <option value="">{t('common.add')}…</option>
          <optgroup label={t('ins.rules.addCategory')}>{CATEGORIES.filter((c) => !usedCats.has(c)).map((c) => <option key={c} value={`cat:${c}`}>{t(`enum.ServiceCategory.${c}`)}</option>)}</optgroup>
          <optgroup label={t('ins.rules.addService')}>{services.data?.filter((s) => s.isActive && !usedSvc.has(s.id)).map((s) => <option key={s.id} value={`svc:${s.id}`}>{s.name}</option>)}</optgroup>
        </Select>
        {rules.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead><tr className="border-b border-line text-xs text-ink-muted">
                <th className="p-2 text-start">{t('ins.rules.target')}</th><th className="p-2">{t('ins.rules.covered')}</th><th className="p-2">{t('ins.rules.coveragePercent')}</th>
                <th className="p-2">{t('ins.rules.patientFixed')}</th><th className="p-2">{t('ins.rules.maxAmount')}</th><th className="p-2">{t('ins.rules.price')}</th>
                <th className="p-2">{t('ins.rules.requiresApproval')}</th><th className="p-2">{t('ins.rules.requiresReport')}</th><th />
              </tr></thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr key={`${r.serviceId}${r.category}`} className="border-b border-line">
                    <td className="p-2 font-semibold">{r.serviceId ? svcName(r.serviceId) : <>{t(`enum.ServiceCategory.${r.category}`)} <span className="text-xs font-normal text-ink-muted">({t('ins.rules.category')})</span></>}</td>
                    <td className="p-2 text-center"><input type="checkbox" className="accent-primary-600" checked={r.covered} onChange={(e) => setRule(i, { covered: e.target.checked })} /></td>
                    <td className="p-2"><Input type="number" min={0} max={100} disabled={!r.covered || r.patientFixed !== ''} value={r.coveragePercent} onChange={(e) => setRule(i, { coveragePercent: e.target.value })} className="!h-9 w-20" dir="ltr" /></td>
                    <td className="p-2"><Input type="number" min={0} step="0.001" disabled={!r.covered} value={r.patientFixed} onChange={(e) => setRule(i, { patientFixed: e.target.value })} className="!h-9 w-24" dir="ltr" /></td>
                    <td className="p-2"><Input type="number" min={0} step="0.001" disabled={!r.covered} value={r.maxAmount} onChange={(e) => setRule(i, { maxAmount: e.target.value })} className="!h-9 w-24" dir="ltr" /></td>
                    <td className="p-2"><Input type="number" min={0} step="0.001" disabled={!r.serviceId} value={r.price} onChange={(e) => setRule(i, { price: e.target.value })} className="!h-9 w-24" dir="ltr" /></td>
                    <td className="p-2 text-center"><input type="checkbox" className="accent-primary-600" checked={r.requiresApproval} onChange={(e) => setRule(i, { requiresApproval: e.target.checked })} /></td>
                    <td className="p-2 text-center"><input type="checkbox" className="accent-primary-600" checked={r.requiresReport} onChange={(e) => setRule(i, { requiresReport: e.target.checked })} /></td>
                    <td className="p-2"><IconButton size="sm" label={t('common.remove')} onClick={() => setRules(rules.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  );
}

interface Account {
  company: { nameAr: string }; openingBalance: number; claimsSubmitted: number; approved: number; rejected: number; resubmitted: number; transferredToPatients: number;
  writtenOff: number; writtenOffFromApproved: number; cancelled: number; payments: number; closingBalance: number;
  ledger: { id: string; date: string; type: string; claimId: string; claimNumber: string; patient: string; notes: string | null; reason: string | null; effect: number; approved: number }[];
}

function AccountStatement({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState(presetRange('month'));
  const q = useQuery({ queryKey: ['insurance', 'account', companyId, range], queryFn: () => api.get<Account>(`/insurance/reports/companies/${companyId}/account`, { ...range }) });
  const a = q.data;
  const line = (label: string, value: number, strong?: boolean) => (
    <div className={`flex justify-between gap-3 py-1.5 ${strong ? 'border-t border-line pt-2 text-base font-bold' : 'text-sm'}`}><span>{label}</span><span className="tabular-nums">{money(value)}</span></div>
  );
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')}</Button>
      </div>
      {!a ? <PageLoader /> : (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="rounded-2xl bg-surface-subtle p-4">
            {line(t('ins.r.opening'), a.openingBalance)}
            {line(t('ins.r.claimsSubmitted'), a.claimsSubmitted)}
            <div className="flex justify-between gap-3 py-1 text-xs text-ink-muted"><span>{t('ins.r.approvedInfo')}</span><span className="tabular-nums">{money(a.approved)}</span></div>
            {line(t('ins.r.rejectedLine'), a.rejected ? -a.rejected : 0)}
            {a.resubmitted > 0 && line(t('ins.r.resubmittedLine'), a.resubmitted)}
            {a.writtenOffFromApproved > 0 && line(t('ins.r.writtenOffLine'), -a.writtenOffFromApproved)}
            {a.cancelled > 0 && line(t('ins.r.cancelledLine'), -a.cancelled)}
            {line(t('ins.r.paymentsLine'), a.payments ? -a.payments : 0)}
            {line(t('ins.r.closing'), a.closingBalance, true)}
            <div className="mt-2 flex justify-between gap-3 text-xs text-ink-muted"><span>{t('ins.r.transferredInfo')}</span><span className="tabular-nums">{money(a.transferredToPatients)}</span></div>
          </div>
          <DataTable
            dense
            rows={a.ledger}
            rowKey={(r) => r.id}
            empty={<p className="py-4 text-center text-sm text-ink-muted">{t('common.noData')}</p>}
            columns={[
              { key: 'd', header: t('common.date'), cell: (r) => <span className="text-xs">{fmtDateTime(r.date)}</span> },
              { key: 'c', header: t('ins.c.number'), cell: (r) => <Link to={`/insurance/claims/${r.claimId}`} className="font-mono text-xs text-primary-700 hover:underline">{r.claimNumber}</Link> },
              { key: 'p', header: t('common.patient'), cell: (r) => r.patient },
              { key: 't', header: t('common.type'), cell: (r) => <span>{t(`ins.ev.${r.type}`)}<span className="block text-[11px] text-ink-muted">{r.reason ?? r.notes ?? ''}</span></span> },
              { key: 'e', header: t('ins.r.effect'), align: 'end', cell: (r) => <b className={`tabular-nums ${r.effect < 0 ? 'text-success-700' : ''}`}>{r.effect ? money(r.effect) : r.approved ? `(${money(r.approved)})` : '—'}</b> },
            ]}
          />
        </div>
      )}
    </Card>
  );
}
