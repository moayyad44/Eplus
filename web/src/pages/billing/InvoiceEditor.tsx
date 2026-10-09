import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Lock, ShieldCheck, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useDebounced } from '@/lib/hooks';
import { money, num, textMatch } from '@/lib/format';
import type { Invoice, InvoiceTemplate } from '@/lib/billing';
import type { PatientLite, Service } from '@/lib/types';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, IconButton, Input, PageHeader, PageLoader, Select, Textarea } from '@/components/ui';
import { PatientPicker } from '@/components/shared/PatientPicker';
import { Autocomplete } from '@/components/shared/Autocomplete';
import { AuthorizationDialog, PayerPicker, type PayerValue } from '@/components/insurance/widgets';

interface Line {
  serviceId: string; name: string; category: string; quantity: string; unitPrice: string; discount: string; taxRate: number; basePrice: number; allowPriceEdit: boolean;
  mandatoryQty: number | null; priceEdited: boolean; overrideApproval: boolean; insuranceShare: string | null;
}
interface Preview {
  total: number; subtotal: number; discountTotal: number; taxTotal: number; patientShare: number; insuranceShare: number; warnings: string[];
  items: { serviceId: string; unitPrice: number; lineTotal: number; insuranceShare: number; patientShare: number; coveragePercent: number | null; coverageNote: string | null }[];
  insurance: { company: string; contract: string; memberId: string; limit: number | null; used: number; remaining: number | null; lines: { requiresApproval: boolean; requiresReport: boolean; approvalMissing: boolean }[] } | null;
}

export default function InvoiceEditor() {
  const { t } = useTranslation();
  const { can, canAny } = useAuth();
  const nav = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const visitId = params.get('visitId');
  const [patient, setPatient] = useState<PatientLite | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState('0');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [payAfter, setPayAfter] = useState(true);
  const [payer, setPayer] = useState<PayerValue | null>(null);
  const [authFor, setAuthFor] = useState<string | null>(null);
  const insuranceUi = canAny('insurance.view', 'insurance.update');

  const templates = useQuery({ queryKey: ['catalog', 'invoice-templates'], queryFn: () => api.get<InvoiceTemplate[]>('/settings/invoice-templates') });
  const services = useQuery({ queryKey: ['catalog', 'services'], queryFn: () => api.get<Service[]>('/settings/services') });
  const draft = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/billing/invoices/${id}`), enabled: !!id });
  const visit = useQuery({ queryKey: ['visit', visitId], queryFn: () => api.get<{ patient: PatientLite; doctor: { id: string } | null; payerType: 'SELF_PAY' | 'INSURANCE'; patientInsuranceId: string | null }>(`/visits/${visitId}`), enabled: !!visitId });
  const suggest = useQuery({ queryKey: ['invoice-suggest', visitId], queryFn: () => api.get<{ alreadyInvoiced: boolean; items: { serviceId: string; quantity: number }[] }>('/billing/invoices/suggest', { visitId }), enabled: !!visitId && can('invoices.create') });
  const prePatient = useQuery({ queryKey: ['patient', params.get('patientId')], queryFn: () => api.get<PatientLite>(`/patients/${params.get('patientId')}`), enabled: !!params.get('patientId') });

  const svcById = useMemo(() => new Map((services.data ?? []).map((s) => [s.id, s])), [services.data]);
  const toLine = (s: Service, qty = 1, mandatoryQty: number | null = null): Line => ({
    serviceId: s.id, name: s.name, category: s.category, quantity: String(qty), unitPrice: String(num(s.price)), discount: '0', taxRate: num(s.taxRate),
    basePrice: num(s.price), allowPriceEdit: s.allowPriceEdit, mandatoryQty, priceEdited: false, overrideApproval: false, insuranceShare: null,
  });

  // Initial state: edit a draft, or start from a visit / patient.
  useEffect(() => {
    if (loaded || !templates.data || !services.data) return;
    if (id) {
      if (!draft.data) return;
      const d = draft.data;
      setPatient({ ...d.patient, dateOfBirth: null } as PatientLite);
      setDoctorId(d.doctor?.id ?? null);
      setTemplateId(d.template?.id ?? '');
      setLines(d.items.map((i) => {
        const base = toLine(svcById.get(i.serviceId) ?? ({ id: i.serviceId, name: i.description, category: i.category, price: i.unitPrice, taxRate: i.taxRate, allowPriceEdit: false } as Service), num(i.quantity), i.isMandatory ? num(i.quantity) : null);
        return { ...base, unitPrice: String(num(i.unitPrice)), discount: String(num(i.discount)), priceEdited: d.payerType !== 'INSURANCE' && num(i.unitPrice) !== base.basePrice };
      }));
      setInvoiceDiscount(String(num(d.invoiceDiscount)));
      setNotes(d.notes ?? '');
      setPayer({ payerType: d.payerType === 'INSURANCE' ? 'INSURANCE' : 'SELF_PAY', patientInsuranceId: d.patientInsurance?.id ?? null });
      setLoaded(true);
      return;
    }
    if (visitId && (!visit.data || !suggest.data)) return;
    const def = templates.data.find((x) => x.isDefault) ?? templates.data[0];
    setTemplateId(def?.id ?? '');
    const base = def ? def.items.filter((i) => i.isMandatory).map((i) => toLine(i.service, num(i.quantity), num(i.quantity))) : [];
    const extra = (suggest.data?.items ?? []).map((i) => svcById.get(i.serviceId)).filter(Boolean).map((s) => toLine(s!));
    setLines([...base, ...extra.filter((e) => !base.some((b) => b.serviceId === e.serviceId))]);
    if (extra.length) toast.info(t('billing.suggestedLoaded'));
    if (visit.data) {
      setPatient(visit.data.patient);
      setDoctorId(visit.data.doctor?.id ?? null);
      setPayer({ payerType: visit.data.payerType, patientInsuranceId: visit.data.patientInsuranceId });
    }
    setLoaded(true);
  }, [loaded, templates.data, services.data, draft.data, visit.data, suggest.data, id, visitId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (prePatient.data && !patient) setPatient(prePatient.data); }, [prePatient.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeTemplate = (tid: string) => {
    setTemplateId(tid);
    const tpl = templates.data?.find((x) => x.id === tid);
    const mandatory = tpl?.items.filter((i) => i.isMandatory) ?? [];
    setLines((ls) => {
      const kept = ls.filter((l) => l.mandatoryQty === null && !mandatory.some((m) => m.serviceId === l.serviceId));
      return [...mandatory.map((m) => toLine(m.service, num(m.quantity), num(m.quantity))), ...kept];
    });
  };
  const addService = (s: Service) => {
    setSearch('');
    setLines((ls) => (ls.some((l) => l.serviceId === s.id) ? ls.map((l) => (l.serviceId === s.id ? { ...l, quantity: String(num(l.quantity) + 1) } : l)) : [...ls, toLine(s)]));
  };
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const insured = payer?.payerType === 'INSURANCE' && !!payer.patientInsuranceId;
  const body = (issue: boolean) => ({
    patientId: patient?.id, visitId: visitId ?? draft.data?.visit?.id ?? null, doctorId, templateId: templateId || null, issue, notes: notes || null,
    invoiceDiscount: num(invoiceDiscount),
    ...(payer ? { payerType: payer.payerType, patientInsuranceId: payer.patientInsuranceId } : {}),
    items: lines.map((l) => ({
      serviceId: l.serviceId, quantity: num(l.quantity), unitPrice: l.priceEdited || (!insured && num(l.unitPrice) !== l.basePrice) ? num(l.unitPrice) : null, discount: num(l.discount) || null,
      ...(insured && { overrideApproval: l.overrideApproval || undefined, insuranceShare: l.insuranceShare === null || l.insuranceShare === '' ? null : num(l.insuranceShare) }),
    })),
  });

  // Server-side dry run: contract prices, coverage per line, approvals, yearly limit.
  const previewBody = useDebounced(JSON.stringify(insured && patient && lines.length ? { ...body(false), issue: undefined, draftId: id } : null), 350);
  const preview = useQuery({
    queryKey: ['invoice-preview', previewBody],
    queryFn: () => api.post<Preview>('/billing/invoices/preview', JSON.parse(previewBody)),
    enabled: previewBody !== 'null',
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pv = insured ? preview.data : undefined;

  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const totals = useMemo(() => {
    let subtotal = 0, disc = 0, tax = 0, lt = 0;
    for (const l of lines) {
      const gross = r3(num(l.unitPrice) * num(l.quantity));
      const d = Math.min(num(l.discount), gross);
      const tx = r3(((gross - d) * l.taxRate) / 100);
      subtotal += gross; disc += d; tax += tx; lt += gross - d + tx;
    }
    return { subtotal, disc, tax, total: Math.max(0, lt - num(invoiceDiscount)) };
  }, [lines, invoiceDiscount]);
  const shown = pv ? { subtotal: num(pv.subtotal), disc: num(pv.discountTotal) - num(invoiceDiscount), tax: num(pv.taxTotal), total: num(pv.total) } : totals;

  const canPrice = can('invoices.price_override');
  const canDiscount = can('invoices.discount');
  const canOverride = can('insurance.coverage.override');
  const save = useApiMutation(
    (issue: boolean) => (id ? api.put<Invoice>(`/billing/invoices/${id}`, body(issue)) : api.post<Invoice>('/billing/invoices', body(issue))),
    {
      invalidate: [['invoices'], ['queue'], ['visit'], ['insurance']],
      success: false,
      onSuccess: (inv, issue) => {
        toast.success(issue ? t('billing.issued', { number: inv.invoiceNumber }) : t('common.saved'));
        nav(`/billing/invoices/${inv.id}${issue && payAfter && num(inv.balance) > 0 ? '?pay=1' : ''}`, { replace: true });
      },
    },
  );

  if (!loaded && (templates.isLoading || services.isLoading || draft.isLoading || visit.isLoading)) return <PageLoader />;
  const previewError = insured && preview.error ? (preview.error as Error).message : null;

  return (
    <div>
      <PageHeader title={id ? t('billing.editDraft') : t('billing.newInvoice')} />
      {suggest.data?.alreadyInvoiced && <p className="mb-4 rounded-xl bg-warning-50 px-4 py-2 text-sm text-warning-700">{t('billing.alreadyInvoiced')}</p>}
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <div className="grid gap-3 md:grid-cols-2">
              <Field group label={t('common.patient')} required error={save.fieldErrors.patientId}>
                <PatientPicker value={patient} onChange={(p) => { setPatient(p); setPayer(null); }} invalid={!!save.fieldErrors.patientId} />
              </Field>
              <Field label={t('billing.template')} hint={t('billing.templateHint')}>
                <Select value={templateId} onChange={(e) => changeTemplate(e.target.value)}>
                  {templates.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </Field>
              {patient && insuranceUi && (
                <Field group label={t('ins.payer.label')} className="md:col-span-2">
                  <PayerPicker key={patient.id} patientId={patient.id} value={payer} onChange={setPayer} />
                </Field>
              )}
            </div>
          </Card>
          {(previewError || (pv?.warnings.length ?? 0) > 0) && (
            <div className="space-y-1.5 rounded-2xl border border-warning-100 bg-warning-50 px-4 py-3 text-sm text-warning-700">
              {previewError && <p className="flex items-start gap-2 font-semibold text-danger-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{previewError}</p>}
              {pv?.warnings.map((w) => <p key={w} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}</p>)}
            </div>
          )}
          <Card>
            <CardHeader title={t('common.items')} actions={insured && preview.isFetching ? <span className="text-xs text-ink-muted">{t('ins.inv.calculating')}</span> : undefined} />
            <div className="mb-3">
              <Autocomplete<Service>
                value={search}
                onChange={setSearch}
                onPick={addService}
                fetcher={async (q) => (services.data ?? []).filter((s) => textMatch(q, s.name, s.code)).slice(0, 12)}
                queryKey="svc"
                minChars={1}
                placeholder={t('billing.itemSearch')}
                render={(s) => <span className="flex justify-between gap-2"><span><b>{s.name}</b> <span className="text-xs text-ink-muted">{t(`enum.ServiceCategory.${s.category}`)}</span></span><span className="tabular-nums">{money(s.price)}</span></span>}
              />
            </div>
            {!lines.length ? <EmptyState title={t('billing.noItems')} className="!py-6" /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="border-b border-line text-xs text-ink-muted">
                    <th className="p-2 text-start">{t('billing.service')}</th><th className="w-24 p-2 text-start">{t('common.quantity')}</th><th className="w-32 p-2 text-start">{t('billing.unitPrice')}</th>
                    <th className="w-28 p-2 text-start">{t('common.discount')}</th><th className="w-32 p-2 text-end">{t('billing.lineTotal')}</th>
                    {insured && <><th className="w-28 p-2 text-end">{t('ins.inv.insuranceShare')}</th><th className="w-24 p-2 text-end">{t('ins.inv.patientShare')}</th></>}
                    <th className="w-10" />
                  </tr></thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const pl = pv?.items[i];
                      const info = pv?.insurance?.lines[i];
                      const unit = insured && pl && !l.priceEdited ? String(num(pl.unitPrice)) : l.unitPrice;
                      const gross = num(unit) * num(l.quantity);
                      const d = num(l.discount);
                      const total = pl ? num(pl.lineTotal) : gross - d + ((gross - d) * l.taxRate) / 100;
                      const priceEditable = l.allowPriceEdit || canPrice;
                      return (
                        <tr key={l.serviceId} className="border-b border-line align-top">
                          <td className="p-2">
                            <span className="font-semibold">{l.name}</span>
                            <span className="ms-2 inline-flex flex-wrap gap-1">
                              <Badge dot={false}>{t(`enum.ServiceCategory.${l.category}`)}</Badge>
                              {l.mandatoryQty !== null && <Badge tone="primary" dot={false}><Lock className="h-3 w-3" />{t('billing.mandatory')}</Badge>}
                              {insured && pl && num(pl.unitPrice) !== l.basePrice && !l.priceEdited && <Badge tone="violet" dot={false}>{t('ins.inv.insurancePrice')}</Badge>}
                            </span>
                            {insured && pl?.coverageNote && <span className={`mt-1 block text-[11px] ${info?.approvalMissing ? 'font-semibold text-danger-700' : 'text-ink-muted'}`}>{pl.coverageNote}</span>}
                            {insured && info?.requiresApproval && (info.approvalMissing || l.overrideApproval) && (
                              <span className="mt-1 flex flex-wrap items-center gap-2">
                                {can('insurance.authorization.manage') && <Button size="sm" variant="outline" onClick={() => setAuthFor(l.serviceId)}>{t('ins.inv.requestApproval')}</Button>}
                                {canOverride && <Checkbox label={t('ins.inv.override')} checked={l.overrideApproval} onChange={(e) => setLine(i, { overrideApproval: e.target.checked })} />}
                              </span>
                            )}
                          </td>
                          <td className="p-2"><Input type="number" min={l.mandatoryQty ?? 0.01} step="1" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className="!h-9" dir="ltr" /></td>
                          <td className="p-2"><Input type="number" step="0.001" min={0} value={unit} disabled={!priceEditable} title={priceEditable ? undefined : t('billing.priceLocked')} onChange={(e) => setLine(i, { unitPrice: e.target.value, priceEdited: true })} className="!h-9" dir="ltr" /></td>
                          <td className="p-2"><Input type="number" step="0.001" min={0} value={l.discount} disabled={!canDiscount} onChange={(e) => setLine(i, { discount: e.target.value })} className="!h-9" dir="ltr" /></td>
                          <td className="p-2 text-end font-bold tabular-nums">{money(total)}</td>
                          {insured && (
                            <>
                              <td className="p-2 text-end">
                                {canOverride ? (
                                  <Input type="number" step="0.001" min={0} value={l.insuranceShare ?? (pl ? String(num(pl.insuranceShare)) : '')} onChange={(e) => setLine(i, { insuranceShare: e.target.value })} className="!h-9 text-end" dir="ltr" title={t('ins.inv.overrideHint')} />
                                ) : <span className="font-semibold tabular-nums text-primary-700">{pl ? money(pl.insuranceShare) : '…'}</span>}
                                {pl?.coveragePercent != null && <span className="block text-[11px] text-ink-muted">{num(pl.coveragePercent)}%</span>}
                              </td>
                              <td className="p-2 text-end font-semibold tabular-nums">{pl ? money(pl.patientShare) : '…'}</td>
                            </>
                          )}
                          <td className="p-2">{l.mandatoryQty === null && <IconButton size="sm" label={t('common.remove')} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Field label={t('common.notes')} className="mt-4"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </Card>
        </div>
        <aside>
          <Card className="sticky top-20">
            <CardHeader title={t('billing.summary')} />
            {insured && pv?.insurance && (
              <p className="mb-3 flex items-start gap-2 rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{pv.insurance.company} — {pv.insurance.contract} · {pv.insurance.memberId}{pv.insurance.remaining != null && <> · {t('ins.inv.limitLeft')}: <b>{money(pv.insurance.remaining)}</b></>}</span>
              </p>
            )}
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-muted">{t('common.subtotal')}</dt><dd className="tabular-nums">{money(shown.subtotal)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">{t('billing.itemsDiscount')}</dt><dd className="tabular-nums">-{money(shown.disc)}</dd></div>
              {shown.tax > 0 && <div className="flex justify-between"><dt className="text-ink-muted">{t('common.tax')}</dt><dd className="tabular-nums">{money(shown.tax)}</dd></div>}
              {canDiscount && (
                <div className="flex items-center justify-between gap-2"><dt className="text-ink-muted">{t('billing.invoiceDiscount')}</dt><dd><Input type="number" step="0.001" min={0} value={invoiceDiscount} onChange={(e) => setInvoiceDiscount(e.target.value)} className="!h-8 w-28" dir="ltr" /></dd></div>
              )}
              <div className="flex justify-between border-t border-line pt-3 text-lg font-bold"><dt>{insured ? t('ins.inv.total') : t('billing.total')}</dt><dd className="tabular-nums text-primary-700">{money(shown.total)}</dd></div>
              {insured && pv && (
                <>
                  <div className="flex justify-between rounded-xl bg-primary-50 px-3 py-2 font-semibold text-primary-800"><dt>{t('ins.inv.insuranceShare')}</dt><dd className="tabular-nums">{money(pv.insuranceShare)}</dd></div>
                  <div className="flex justify-between rounded-xl bg-success-50 px-3 py-2 text-base font-bold text-success-700"><dt>{t('ins.inv.patientShare')}</dt><dd className="tabular-nums">{money(pv.patientShare)}</dd></div>
                  <p className="text-[11px] text-ink-muted">{t('ins.inv.notCoveredNote')}</p>
                </>
              )}
            </dl>
            {save.fieldErrors.items && <p className="mt-2 text-xs text-danger-600">{save.fieldErrors.items}</p>}
            <div className="mt-5 space-y-2">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary-600" checked={payAfter} onChange={(e) => setPayAfter(e.target.checked)} />{t('billing.payNow')}</label>
              <Button size="lg" className="w-full" icon={<Wallet className="h-5 w-5" />} disabled={!patient || !lines.length || !!previewError} loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>
                {payAfter ? t('billing.issueAndPay') : `${t('billing.issue')} — ${t('billing.leaveUnpaid')}`}
              </Button>
              {can('invoices.update') && <Button variant="outline" className="w-full" disabled={!patient || !lines.length} loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>{t('billing.saveDraft')}</Button>}
            </div>
          </Card>
        </aside>
      </div>
      {authFor && patient && <AuthorizationDialog patientId={patient.id} visitId={visitId ?? draft.data?.visit?.id} serviceId={authFor} onClose={() => setAuthFor(null)} />}
    </div>
  );
}
