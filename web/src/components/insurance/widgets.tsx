import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ShieldCheck, ShieldOff } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, money, num, toLocalInput } from '@/lib/format';
import { statusTone, useInsuranceCompanies, useInsuranceSummary, type Authorization, type Membership } from '@/lib/insurance';
import type { Service } from '@/lib/types';
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from '@/components/ui';

/** "Insurance Active" / "Expired" / "Expires in N days" — the status reception must see at a glance. */
export function InsuranceStatusBadge({ m, className }: { m: Pick<Membership, 'effectiveStatus' | 'daysToExpiry'> | null | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!m) return <Badge tone="neutral" className={className}>{t('ins.status.SELF_PAY')}</Badge>;
  const soon = m.effectiveStatus === 'ACTIVE' && m.daysToExpiry != null && m.daysToExpiry <= 30;
  return (
    <Badge tone={statusTone(m)} className={className}>
      {m.effectiveStatus === 'ACTIVE' ? <ShieldCheck className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
      {t(`ins.status.${m.effectiveStatus}`)}{soon && ` · ${t('ins.status.expiresIn', { days: m.daysToExpiry })}`}
    </Badge>
  );
}

/** Clear warning for expired / suspended / soon-expiring insurance. Renders nothing when all is fine. */
export function InsuranceAlert({ m, className }: { m: Membership | null | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!m) return null;
  let msg: string | null = null;
  let danger = true;
  if (m.effectiveStatus === 'EXPIRED') msg = t('ins.status.expiredWarn');
  else if (m.effectiveStatus === 'SUSPENDED') msg = t('ins.status.suspendedWarn');
  else if (m.effectiveStatus === 'ACTIVE' && m.daysToExpiry != null && m.daysToExpiry <= 30) { msg = t('ins.status.soonWarn', { days: m.daysToExpiry }); danger = false; }
  if (!msg) return null;
  return (
    <p className={clsx('flex items-start gap-2 rounded-xl px-3 py-2 text-sm font-semibold', danger ? 'bg-danger-50 text-danger-700' : 'bg-warning-50 text-warning-700', className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{m.company.nameAr} — {msg}{m.endDate && ` (${fmtDate(m.endDate)})`}</span>
    </p>
  );
}

export interface PayerValue { payerType: 'SELF_PAY' | 'INSURANCE'; patientInsuranceId: string | null }

/**
 * Self pay / insurance choice for a visit or an invoice. Defaults to the patient's usable insurance
 * (primary first; the secondary only when the primary is not valid). Unusable memberships are shown but disabled.
 */
export function PayerPicker({ patientId, value, onChange, disabled }: { patientId: string; value: PayerValue | null; onChange: (v: PayerValue) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const summary = useInsuranceSummary(patientId);
  const list = summary.data?.memberships ?? [];
  useEffect(() => {
    if (value || !summary.data) return;
    const usable = list.find((m) => m.effectiveStatus === 'ACTIVE');
    onChange(usable ? { payerType: 'INSURANCE', patientInsuranceId: usable.id } : { payerType: 'SELF_PAY', patientInsuranceId: null });
  }, [summary.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!summary.data) return null;
  const selected = list.find((m) => m.id === value?.patientInsuranceId) ?? null;
  return (
    <div className="space-y-2">
      <Select
        value={value?.payerType === 'INSURANCE' ? value.patientInsuranceId ?? '' : 'SELF_PAY'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === 'SELF_PAY' ? { payerType: 'SELF_PAY', patientInsuranceId: null } : { payerType: 'INSURANCE', patientInsuranceId: e.target.value })}
      >
        <option value="SELF_PAY">{t('ins.payer.selfPay')}</option>
        {list.map((m) => (
          <option key={m.id} value={m.id} disabled={m.effectiveStatus !== 'ACTIVE'}>
            {t('ins.payer.insurance')}: {m.company.nameAr} — {m.contract.name} ({t(`ins.${m.priority === 'PRIMARY' ? 'primary' : 'secondary'}`)}) · {m.memberId}
            {m.effectiveStatus !== 'ACTIVE' ? ` — ${t(`ins.status.${m.effectiveStatus}`)}` : ''}
          </option>
        ))}
      </Select>
      {selected && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <InsuranceStatusBadge m={selected} />
          <span>{t('ins.m.coverage')} {selected.coveragePercent}% · {t('ins.m.patientShare')} {selected.patientPercent}%</span>
          {selected.remaining != null && <span>· {t('ins.inv.limitLeft')}: <b className="tabular-nums">{money(selected.remaining)}</b></span>}
        </div>
      )}
      {list.filter((m) => m.priority === 'PRIMARY').map((m) => <InsuranceAlert key={m.id} m={m} />)}
    </div>
  );
}

// ───────────── Membership add / edit ─────────────

const EMPTY = { contractId: '', priority: 'PRIMARY', cardNumber: '', policyNumber: '', memberId: '', subscriberName: '', relation: 'SELF', startDate: '', endDate: '', status: 'ACTIVE', coveragePercent: '', annualLimit: '', network: '', notes: '' };

export function MembershipDialog({ patientId, membership, onClose }: { patientId: string; membership?: Membership | null; onClose: () => void }) {
  const { t } = useTranslation();
  const companies = useInsuranceCompanies(true);
  const [companyId, setCompanyId] = useState(membership?.companyId ?? '');
  const [v, setV] = useState(() => (membership ? {
    contractId: membership.contractId, priority: membership.priority, cardNumber: membership.cardNumber ?? '', policyNumber: membership.policyNumber ?? '', memberId: membership.memberId,
    subscriberName: membership.subscriberName ?? '', relation: membership.relation, startDate: membership.startDate?.slice(0, 10) ?? '', endDate: membership.endDate?.slice(0, 10) ?? '',
    status: membership.status, coveragePercent: membership.ownCoveragePercent == null ? '' : String(membership.ownCoveragePercent),
    annualLimit: membership.ownAnnualLimit == null ? '' : String(membership.ownAnnualLimit), network: membership.network ?? '', notes: membership.notes ?? '',
  } : EMPTY));
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const contracts = companies.data?.find((c) => c.id === companyId)?.contracts.filter((c) => c.isActive || c.id === v.contractId) ?? [];
  const save = useApiMutation(
    () => {
      const body = { ...v, startDate: v.startDate || null, endDate: v.endDate || null, coveragePercent: v.coveragePercent || null, annualLimit: v.annualLimit || null };
      return membership ? api.put(`/insurance/memberships/${membership.id}`, body) : api.post(`/insurance/patients/${patientId}/memberships`, body);
    },
    { invalidate: [['insurance'], ['patient', patientId]], onSuccess: onClose },
  );
  const fe = save.fieldErrors;
  return (
    <Dialog open onClose={onClose} size="lg" title={membership ? t('ins.editInsurance') : t('ins.addInsurance')}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ins.m.company')} required>
          <Select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setV({ ...v, contractId: '' }); }} placeholder={t('common.select')}>
            {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </Select>
        </Field>
        <Field label={t('ins.m.contract')} required error={fe.contractId}>
          <Select value={v.contractId} onChange={set('contractId')} placeholder={t('common.select')}>
            {contracts.map((c) => <option key={c.id} value={c.id}>{c.name} — {num(c.coveragePercent)}%</option>)}
          </Select>
        </Field>
        <Field label={t('ins.m.memberId')} required error={fe.memberId}><Input value={v.memberId} onChange={set('memberId')} dir="ltr" /></Field>
        <Field label={t('ins.m.cardNumber')}><Input value={v.cardNumber} onChange={set('cardNumber')} dir="ltr" /></Field>
        <Field label={t('ins.m.policyNumber')}><Input value={v.policyNumber} onChange={set('policyNumber')} dir="ltr" /></Field>
        <Field label={t('ins.priority')}>
          <Select value={v.priority} onChange={set('priority')}>
            <option value="PRIMARY">{t('ins.primary')}</option><option value="SECONDARY">{t('ins.secondary')}</option>
          </Select>
        </Field>
        <Field label={t('ins.m.subscriberName')}><Input value={v.subscriberName} onChange={set('subscriberName')} /></Field>
        <Field label={t('ins.m.relation')}>
          <Select value={v.relation} onChange={set('relation')}>
            {['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'OTHER'].map((r) => <option key={r} value={r}>{t(`ins.relation.${r}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('ins.m.startDate')}><Input type="date" value={v.startDate} onChange={set('startDate')} /></Field>
        <Field label={t('ins.m.endDate')} error={fe.endDate}><Input type="date" value={v.endDate} onChange={set('endDate')} /></Field>
        <Field label={t('ins.m.status')}>
          <Select value={v.status} onChange={set('status')}>
            {['ACTIVE', 'SUSPENDED', 'EXPIRED'].map((s) => <option key={s} value={s}>{t(`enum.InsuranceStatus.${s}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('ins.m.network')}><Input value={v.network} onChange={set('network')} /></Field>
        <Field label={t('ins.m.coveragePercent')} error={fe.coveragePercent}><Input type="number" min={0} max={100} value={v.coveragePercent} onChange={set('coveragePercent')} dir="ltr" /></Field>
        <Field label={t('ins.m.annualLimit')} error={fe.annualLimit}><Input type="number" min={0} step="0.001" value={v.annualLimit} onChange={set('annualLimit')} dir="ltr" /></Field>
        <Field label={t('ins.m.notes')} className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field>
      </div>
    </Dialog>
  );
}

// ───────────── Pre-authorization ─────────────

export const useServices = () => useQuery({ queryKey: ['catalog', 'services'], queryFn: () => api.get<Service[]>('/settings/services'), staleTime: 60_000 });

/** Request a pre-authorization; when the company already answered (electronic approvals), record it in the same step. */
export function AuthorizationDialog({ patientId, visitId, serviceId, onClose }: { patientId: string; visitId?: string | null; serviceId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const summary = useInsuranceSummary(patientId);
  const services = useServices();
  const usable = summary.data?.memberships.filter((m) => m.effectiveStatus === 'ACTIVE') ?? [];
  const [v, setV] = useState({ patientInsuranceId: '', serviceId: serviceId ?? '', quantity: '1', diagnosis: '', reason: '', notes: '' });
  const [now, setNow] = useState(true);
  const [d, setD] = useState({ status: 'APPROVED', approvalNumber: '', approvedQuantity: '', approvedAmount: '', validUntil: '', rejectReason: '' });
  useEffect(() => { if (!v.patientInsuranceId && usable[0]) setV((x) => ({ ...x, patientInsuranceId: usable[0].id })); }, [usable.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useApiMutation(
    () => api.post('/insurance/authorizations', {
      ...v, visitId: visitId ?? null, quantity: num(v.quantity) || 1,
      decision: now ? { ...d, approvedQuantity: d.approvedQuantity || null, approvedAmount: d.approvedAmount || null, validUntil: d.validUntil || null, approvalNumber: d.approvalNumber || null, rejectReason: d.rejectReason || null } : null,
    }),
    { invalidate: [['insurance'], ['visit'], ['invoice-preview']], onSuccess: onClose },
  );
  const fe = save.fieldErrors;
  return (
    <Dialog open onClose={onClose} size="lg" title={t('ins.a.new')}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={!usable.length} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      {!usable.length && summary.data && <p className="mb-3 rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-700">{t('ins.payer.none')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ins.a.membership')} required error={fe.patientInsuranceId}>
          <Select value={v.patientInsuranceId} onChange={(e) => setV({ ...v, patientInsuranceId: e.target.value })}>
            {usable.map((m) => <option key={m.id} value={m.id}>{m.company.nameAr} — {m.memberId}</option>)}
          </Select>
        </Field>
        <Field label={t('ins.a.service')} required error={fe.serviceId}>
          <Select value={v.serviceId} onChange={(e) => setV({ ...v, serviceId: e.target.value })} placeholder={t('common.select')}>
            {services.data?.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label={t('ins.a.quantity')}><Input type="number" min={1} value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} dir="ltr" /></Field>
        <Field label={t('ins.a.diagnosis')} hint={visitId ? t('common.optional') : undefined}><Input value={v.diagnosis} onChange={(e) => setV({ ...v, diagnosis: e.target.value })} /></Field>
        <Field label={t('ins.a.reason')} className="sm:col-span-2"><Textarea rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
      <Checkbox className="mt-4" label={t('ins.a.recordNow')} checked={now} onChange={(e) => setNow(e.target.checked)} />
      {now && (
        <div className="mt-3 grid gap-3 rounded-xl border border-line bg-surface-subtle p-3 sm:grid-cols-2">
          <DecisionFields d={d} setD={setD} fe={fe} />
        </div>
      )}
    </Dialog>
  );
}

type DecisionState = { status: string; approvalNumber: string; approvedQuantity: string; approvedAmount: string; validUntil: string; rejectReason: string };
function DecisionFields({ d, setD, fe }: { d: DecisionState; setD: (d: DecisionState) => void; fe: Record<string, string> }) {
  const { t } = useTranslation();
  const k = (key: string) => fe[`decision.${key}`] ?? fe[key];
  return (
    <>
      <Field label={t('common.status')}>
        <Select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })}>
          {['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'].map((s) => <option key={s} value={s}>{t(`enum.AuthorizationStatus.${s}`)}</option>)}
        </Select>
      </Field>
      {d.status === 'REJECTED' ? (
        <Field label={t('ins.a.rejectReason')} required error={k('rejectReason')}><Input value={d.rejectReason} onChange={(e) => setD({ ...d, rejectReason: e.target.value })} /></Field>
      ) : (
        <>
          <Field label={t('ins.a.approvalNumber')} required error={k('approvalNumber')}><Input value={d.approvalNumber} onChange={(e) => setD({ ...d, approvalNumber: e.target.value })} dir="ltr" /></Field>
          <Field label={t('ins.a.approvedQuantity')}><Input type="number" min={1} value={d.approvedQuantity} onChange={(e) => setD({ ...d, approvedQuantity: e.target.value })} dir="ltr" /></Field>
          <Field label={t('ins.a.approvedAmount')} hint={t('common.optional')}><Input type="number" min={0} step="0.001" value={d.approvedAmount} onChange={(e) => setD({ ...d, approvedAmount: e.target.value })} dir="ltr" /></Field>
          <Field label={t('ins.a.validUntil')}><Input type="date" value={d.validUntil} min={toLocalInput(new Date()).slice(0, 10)} onChange={(e) => setD({ ...d, validUntil: e.target.value })} /></Field>
        </>
      )}
    </>
  );
}

export function AuthDecisionDialog({ auth, onClose }: { auth: Authorization; onClose: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState({ status: 'APPROVED', approvalNumber: auth.approvalNumber ?? '', approvedQuantity: String(num(auth.quantity)), approvedAmount: '', validUntil: '', rejectReason: '' });
  const save = useApiMutation(
    () => api.post(`/insurance/authorizations/${auth.id}/decide`, { ...d, approvedQuantity: d.approvedQuantity || null, approvedAmount: d.approvedAmount || null, validUntil: d.validUntil || null, approvalNumber: d.approvalNumber || null, rejectReason: d.rejectReason || null }),
    { invalidate: [['insurance'], ['visit']], onSuccess: onClose },
  );
  return (
    <Dialog open onClose={onClose} title={t('ins.a.decide')} subtitle={`${auth.requestNumber} — ${auth.service.name} — ${auth.patient.fullName}`}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2"><DecisionFields d={d} setD={setD} fe={save.fieldErrors} /></div>
    </Dialog>
  );
}

/** Authorizations of a patient or a visit, with request / decide actions. */
export function AuthorizationsList({ patientId, visitId, compact }: { patientId: string; visitId?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [decide, setDecide] = useState<Authorization | null>(null);
  const q = useQuery({ queryKey: ['insurance', 'authorizations', patientId, visitId], queryFn: () => api.get<{ items: Authorization[] }>('/insurance/authorizations', { patientId, visitId, pageSize: 50 }) });
  const items = q.data?.items ?? [];
  const manage = can('insurance.authorization.manage');
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-bold">{t('ins.authorizations')}</h4>
        {manage && <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t('ins.a.new')}</Button>}
      </div>
      {!items.length ? <p className="text-xs text-ink-muted">{t('common.noData')}</p> : (
        <ul className="space-y-2">
          {items.slice(0, compact ? 5 : 50).map((a) => (
            <li key={a.id} className="rounded-xl border border-line px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b>{a.service.name}</b>
                <Badge tone={a.effectiveStatus === 'APPROVED' ? 'success' : a.effectiveStatus === 'PARTIALLY_APPROVED' ? 'warning' : ['REJECTED', 'EXPIRED'].includes(a.effectiveStatus) ? 'danger' : 'info'}>{t(`enum.AuthorizationStatus.${a.effectiveStatus}`)}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">
                <bdi className="font-mono">{a.requestNumber}</bdi>{a.approvalNumber && <> · {t('ins.a.approvalNumber')}: <span className="font-mono">{a.approvalNumber}</span></>}
                {a.validUntil && <> · {t('ins.a.validUntil')} {fmtDate(a.validUntil)}</>}{a.rejectReason && <> · {a.rejectReason}</>}
                {a._count.invoiceItems > 0 && <> · {t('ins.a.used')}</>}
              </p>
              {manage && ['PENDING', 'SUBMITTED'].includes(a.status) && <Button size="sm" variant="ghost" className="mt-1" onClick={() => setDecide(a)}>{t('ins.a.decide')}</Button>}
            </li>
          ))}
        </ul>
      )}
      {open && <AuthorizationDialog patientId={patientId} visitId={visitId} onClose={() => setOpen(false)} />}
      {decide && <AuthDecisionDialog auth={decide} onClose={() => setDecide(null)} />}
    </div>
  );
}
