import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Archive, BadgeCheck, Pencil, Plus, ShieldPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import { useInsuranceSummary, type ClaimRow, type Membership } from '@/lib/insurance';
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, IconButton, PageLoader, Select, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { AttachmentsPanel } from '@/components/shared/Attachments';
import { AuthorizationsList, InsuranceAlert, InsuranceStatusBadge, MembershipDialog } from '@/components/insurance/widgets';

const PAYER_TYPES = ['SELF_PAY', 'INSURANCE', 'CORPORATE', 'GOVERNMENT', 'OTHER'];

export function PatientInsuranceTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const s = useInsuranceSummary(patientId);
  const [edit, setEdit] = useState<Membership | 'new' | null>(null);
  const claims = useQuery({ queryKey: ['insurance', 'claims', 'patient', patientId], queryFn: () => api.get<{ items: ClaimRow[] }>('/insurance/claims', { patientId, pageSize: 20 }), enabled: can('insurance.view') });
  const payer = useApiMutation((payerType: string) => api.put(`/insurance/patients/${patientId}/payer-type`, { payerType }), { invalidate: [['insurance', 'patient', patientId]] });

  if (s.isLoading || !s.data) return <PageLoader />;
  const { memberships } = s.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('ins.summary')}
          icon={<ShieldPlus className="h-5 w-5" />}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-muted">{t('ins.payerType')}</span>
              <Select value={s.data.payerType} disabled={!can('insurance.update')} onChange={(e) => payer.mutate(e.target.value)} className="!h-9 w-auto">
                {PAYER_TYPES.map((p) => <option key={p} value={p}>{t(`enum.PayerType.${p}`)}</option>)}
              </Select>
              {can('insurance.create') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>{t('ins.addInsurance')}</Button>}
            </div>
          }
        />
        {!memberships.length ? <EmptyState title={t('ins.noInsurance')} className="!py-6" /> : (
          <div className="grid gap-3 lg:grid-cols-2">{memberships.map((m) => <MembershipCard key={m.id} m={m} onEdit={() => setEdit(m)} />)}</div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><AuthorizationsList patientId={patientId} /></Card>
        <Card>
          <CardHeader title={t('ins.claims')} />
          <DataTable
            dense
            rows={claims.data?.items}
            rowKey={(r) => r.id}
            empty={<p className="py-4 text-center text-sm text-ink-muted">{t('common.noData')}</p>}
            columns={[
              { key: 'n', header: t('ins.c.number'), cell: (r) => <Link to={`/insurance/claims/${r.id}`} className="font-mono text-xs font-semibold text-primary-700 hover:underline">{r.claimNumber}</Link> },
              { key: 'd', header: t('common.date'), cell: (r) => fmtDate(r.createdAt) },
              { key: 'a', header: t('ins.c.insuranceAmount'), cell: (r) => <span className="tabular-nums">{money(r.insuranceAmount)}</span> },
              { key: 'o', header: t('ins.c.outstanding'), cell: (r) => <b className="tabular-nums">{money(r.outstandingAmount)}</b> },
              { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="ClaimStatus" value={r.status} /> },
            ]}
          />
        </Card>
      </div>

      {edit && <MembershipDialog patientId={patientId} membership={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function MembershipCard({ m, onEdit }: { m: Membership; onEdit: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [docs, setDocs] = useState(false);
  const verify = useApiMutation(() => api.post<{ valid: boolean; problem: string | null }>(`/insurance/memberships/${m.id}/verify`, {}), {
    invalidate: [['insurance']], success: false,
    onSuccess: (r) => (r.valid ? import('sonner').then(({ toast }) => toast.success(t('ins.m.verified'))) : import('sonner').then(({ toast }) => toast.error(r.problem))),
  });
  const archive = useApiMutation(() => api.del(`/insurance/memberships/${m.id}`), { invalidate: [['insurance']] });
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3 border-b border-line/60 py-1.5 text-sm last:border-0"><dt className="text-ink-muted">{label}</dt><dd className="text-end font-semibold">{value ?? '—'}</dd></div>
  );
  const pct = m.annualLimit ? Math.min(100, (m.used / m.annualLimit) * 100) : 0;
  return (
    <div className="rounded-2xl border border-line p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-bold">{m.company.nameAr}</p>
          <p className="text-xs text-ink-muted">{m.contract.name}{m.contract.contractNumber && ` · ${m.contract.contractNumber}`}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={m.priority === 'PRIMARY' ? 'primary' : 'neutral'} dot={false}>{t(`ins.${m.priority === 'PRIMARY' ? 'primary' : 'secondary'}`)}</Badge>
          <InsuranceStatusBadge m={m} />
        </div>
      </div>
      <InsuranceAlert m={m} className="mb-2" />
      <dl>
        {row(t('ins.m.memberId'), <span dir="ltr" className="font-mono">{m.memberId}</span>)}
        {row(t('ins.m.cardNumber'), m.cardNumber && <span dir="ltr" className="font-mono">{m.cardNumber}</span>)}
        {row(t('ins.m.policyNumber'), m.policyNumber && <span dir="ltr" className="font-mono">{m.policyNumber}</span>)}
        {row(t('ins.m.subscriberName'), m.subscriberName ? `${m.subscriberName} (${t(`ins.relation.${m.relation}`)})` : t(`ins.relation.${m.relation}`))}
        {row(t('ins.m.endDate'), m.endDate ? <><bdi>{fmtDate(m.startDate)}</bdi> ← <bdi>{fmtDate(m.endDate)}</bdi></> : null)}
        {row(t('ins.m.coverage'), `${m.coveragePercent}% · ${t('ins.m.patientShare')} ${m.patientPercent}%`)}
        {row(t('ins.f.annualLimit'), m.annualLimit != null ? money(m.annualLimit) : t('ins.f.unlimited'))}
        {m.annualLimit != null && row(t('ins.m.used'), <span>{money(m.used)} · {t('ins.m.remaining')} <b className="text-success-700">{money(m.remaining)}</b></span>)}
        {row(t('ins.m.network'), m.network)}
        {row(t('ins.m.lastClaim'), m.lastClaim && <Link to={`/insurance/claims/${m.lastClaim.id}`} className="text-primary-700 hover:underline"><bdi>{m.lastClaim.claimNumber}</bdi> · <bdi>{fmtDate(m.lastClaim.createdAt)}</bdi></Link>)}
        {row(t('ins.m.lastVisit'), m.lastVisit && <Link to={`/visits/${m.lastVisit.id}`} className="text-primary-700 hover:underline"><bdi>{m.lastVisit.visitNumber}</bdi> · <bdi>{fmtDate(m.lastVisit.arrivedAt)}</bdi></Link>)}
        {row(t('ins.m.verifiedAt'), m.verifiedAt ? `${fmtDateTime(m.verifiedAt)} · ${m.verifiedByName ?? ''}` : t('ins.m.notVerified'))}
      </dl>
      {m.annualLimit != null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken" title={t('ins.m.policyYear', { date: fmtDate(m.periodStart) })}>
          <div className="h-full rounded-full bg-primary-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {m.notes && <p className="mt-2 text-xs text-ink-soft">{m.notes}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {can('insurance.verify') && <Button size="sm" variant="outline" icon={<BadgeCheck className="h-4 w-4" />} loading={verify.isPending} onClick={() => verify.mutate(undefined)}>{t('ins.m.verify')}</Button>}
        {can('insurance.update') && <Button size="sm" variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>{t('common.edit')}</Button>}
        <Button size="sm" variant="ghost" onClick={() => setDocs(!docs)}>{t('ins.m.documents')} ({m.attachments.length})</Button>
        {can('insurance.delete') && (
          <IconButton size="sm" label={t('ins.m.archive')} onClick={async () => (await confirm({ message: t('ins.m.archiveConfirm'), danger: true })) && archive.mutate(undefined)}>
            <Archive className="h-4 w-4 text-danger-600" />
          </IconButton>
        )}
      </div>
      {docs && <div className="mt-3 rounded-xl bg-surface-subtle p-3"><p className="mb-2 text-xs text-ink-muted">{t('ins.m.uploadHint')}</p><AttachmentsPanel patientInsuranceId={m.id} compact /></div>}
    </div>
  );
}
