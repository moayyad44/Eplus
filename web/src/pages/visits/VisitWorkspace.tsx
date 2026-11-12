import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, CheckCircle2, FileText, FlaskConical, HeartPulse, Pill, Printer, ShieldCheck, Stethoscope } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime, money } from '@/lib/format';
import type { Patient, VisitStatus } from '@/lib/types';
import type { Consultation, Diagnosis, LabOrder, MedicalReport, NursingNote, Prescription, Vitals } from '@/lib/clinical';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, PageLoader, Tabs, useConfirm } from '@/components/ui';
import { AuthorizationsList, PayerPicker, type PayerValue } from '@/components/insurance/widgets';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { VitalsStrip } from '@/components/shared/VitalsStrip';
import { AttachmentsPanel } from '@/components/shared/Attachments';
import { allowedTargets } from '@/components/shared/visitFlow';
import { ConsultationTab, VitalsTab, NursingTab, PrescriptionTab, LabTab, ReportTab, HistoryTab } from './tabs';

export interface VisitDetail {
  id: string; visitNumber: string; status: VisitStatus; priority: string; queueNumber: number | null; isDirect: boolean; arrivedAt: string; chiefComplaint?: string | null; notes: string | null;
  patient: Patient; doctor: { id: string; fullName: string; specialty: string | null } | null; visitType: { name: string } | null;
  statusLogs: { id: string; fromStatus: string | null; toStatus: string; userId: string | null; note: string | null; createdAt: string }[];
  invoices: { id: string; invoiceNumber: string | null; status: string; total: number; balance: number; payerType: string; insuranceShare: number; patientShare: number }[];
  payerType: 'SELF_PAY' | 'INSURANCE'; patientInsuranceId: string | null;
  patientInsurance: { id: string; memberId: string; cardNumber: string | null; company: { id: string; nameAr: string }; contract: { id: string; name: string; coveragePercent: number } } | null;
  vitalSigns?: Vitals[]; nursingNotes?: NursingNote[]; consultation?: Consultation | null; diagnoses?: Diagnosis[]; prescriptions?: Prescription[];
  labOrders?: LabOrder[]; medicalReports?: (MedicalReport & { content: string })[];
  userNames: Record<string, string>; canViewMedical: boolean;
}

type Tab = 'consult' | 'vitals' | 'nursing' | 'rx' | 'lab' | 'report' | 'files' | 'history' | 'log';

export default function VisitWorkspace() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const { t } = useTranslation();
  const { can, canAny } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['visit', id], queryFn: () => api.get<VisitDetail>(`/visits/${id}`) });
  const defaultTab: Tab = (params.get('tab') as Tab) || (can('consultation.manage') ? 'consult' : can('vitals.record') ? 'vitals' : 'history');
  const [tab, setTab] = useState<Tab>(defaultTab);
  useEffect(() => setTab(defaultTab), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = useApiMutation((v: { status: VisitStatus; note?: string }) => api.post(`/visits/${id}/status`, v), { invalidate: [['visit', id], ['queue']], success: t('queue.statusChanged') });
  const finish = useApiMutation(() => api.post(`/visits/${id}/finish`), { invalidate: [['visit', id], ['queue']], success: t('visit.finished') });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = q.data;
  const p = v.patient;
  const closed = ['CANCELLED', 'NO_SHOW'].includes(v.status);
  const refresh = () => qc.invalidateQueries({ queryKey: ['visit', id] });
  const targets = allowedTargets(v.status, canAny, can).filter((x) => !['CANCELLED', 'NO_SHOW'].includes(x.status) && !(v.isDirect && ['WAITING', 'CALLED'].includes(x.status)));
  const latestVitals = v.vitalSigns?.[0];

  const tabs = [
    { key: 'consult' as const, label: t('visit.tabs.consult'), icon: <Stethoscope className="h-4 w-4" />, hidden: !v.canViewMedical },
    { key: 'vitals' as const, label: t('visit.tabs.vitals'), icon: <HeartPulse className="h-4 w-4" />, count: v.vitalSigns?.length, hidden: !v.canViewMedical },
    { key: 'nursing' as const, label: t('visit.tabs.nursing'), count: v.nursingNotes?.length, hidden: !v.canViewMedical },
    { key: 'rx' as const, label: t('visit.tabs.rx'), icon: <Pill className="h-4 w-4" />, count: v.prescriptions?.length, hidden: !v.canViewMedical },
    { key: 'lab' as const, label: t('visit.tabs.lab'), icon: <FlaskConical className="h-4 w-4" />, count: v.labOrders?.length, hidden: !v.canViewMedical },
    { key: 'report' as const, label: t('visit.tabs.report'), icon: <FileText className="h-4 w-4" />, count: v.medicalReports?.length, hidden: !v.canViewMedical },
    { key: 'files' as const, label: t('visit.tabs.files'), hidden: !can('attachments.view') },
    { key: 'history' as const, label: t('visit.tabs.history'), hidden: !v.canViewMedical },
    { key: 'log' as const, label: t('visit.tabs.log') },
  ];

  return (
    <div>
      <button onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-primary-700"><ArrowRight className="h-3.5 w-3.5 ltr:rotate-180" />{t('common.back')}</button>
      <Card className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {v.isDirect ? <Badge tone="violet" dot={false}>{t('visit.direct.badge')}</Badge> : <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-50 text-lg font-extrabold text-primary-700">{v.queueNumber}</span>}
              <Link to={`/patients/${p.id}`} className="text-xl font-bold hover:text-primary-700">{p.fullName}</Link>
              <StatusBadge enumName="VisitStatus" value={v.status} />
              {v.priority !== 'NORMAL' && <StatusBadge enumName="Priority" value={v.priority} dot={false} />}
              <PayerBadge v={v} />
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              #{p.fileNumber} · {t(`enum.Gender.${p.gender}`)}{p.age != null && ` · ${t('common.yearsOld', { age: p.age })}`} · {v.visitNumber} · {fmtDateTime(v.arrivedAt)} · {v.doctor?.fullName ?? t('queue.unassigned')}{v.visitType && ` · ${v.visitType.name}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {targets.slice(0, 4).map((tg) => (
              <Button key={tg.status} size="sm" variant={tg.revert ? 'ghost' : 'outline'} loading={status.isPending && status.variables?.status === tg.status} onClick={async () => {
                if (tg.revert && !(await confirm({ message: `${t('queue.revert')} ${t(`enum.VisitStatus.${tg.status}`)}` }))) return;
                status.mutate({ status: tg.status });
              }}>
                {tg.revert && `${t('queue.revert')} `}{t(`enum.VisitStatus.${tg.status}`)}
              </Button>
            ))}
            {can('consultation.manage') && !['WAITING_PAYMENT', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(v.status) && (
              <Button size="sm" variant="success" icon={<CheckCircle2 className="h-4 w-4" />} loading={finish.isPending} onClick={() => finish.mutate(undefined)}>{t('visit.finish')}</Button>
            )}
            {can('invoices.create') && !closed && !v.invoices.some((i) => i.status !== 'CANCELLED') && (
              <Button size="sm" icon={<FileText className="h-4 w-4" />} onClick={() => nav(`/billing/invoices/new?visitId=${v.id}`)}>{t('visit.createInvoice')}</Button>
            )}
            {v.invoices.filter((i) => i.status !== 'CANCELLED').map((i) => (
              <Button key={i.id} size="sm" variant="secondary" onClick={() => nav(`/billing/invoices/${i.id}`)}>{i.invoiceNumber ?? t('enum.InvoiceStatus.DRAFT')} · {money(i.balance)}</Button>
            ))}
          </div>
        </div>
      </Card>

      {!v.canViewMedical ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card><EmptyState title={t('visit.noMedical')} /></Card>
          {canAny('insurance.view', 'insurance.update') && <VisitInsuranceCard v={v} />}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
          <div className="min-w-0">
            <Tabs items={tabs} value={tab} onChange={setTab} className="mb-4" />
            {tab === 'consult' && <ConsultationTab visit={v} onSaved={refresh} readOnly={closed || !can('consultation.manage')} />}
            {tab === 'vitals' && <VitalsTab visit={v} onSaved={refresh} readOnly={closed || !can('vitals.record')} />}
            {tab === 'nursing' && <NursingTab visit={v} onSaved={refresh} readOnly={closed || !can('nursing.record')} />}
            {tab === 'rx' && <PrescriptionTab visit={v} onSaved={refresh} readOnly={closed || !can('consultation.manage')} />}
            {tab === 'lab' && <LabTab visit={v} onSaved={refresh} readOnly={closed || !can('lab.order')} />}
            {tab === 'report' && <ReportTab visit={v} onSaved={refresh} readOnly={!can('consultation.manage')} />}
            {tab === 'files' && <Card><AttachmentsPanel visitId={v.id} /></Card>}
            {tab === 'history' && <HistoryTab patientId={p.id} currentVisitId={v.id} />}
            {tab === 'log' && (
              <Card>
                <CardHeader title={t('visit.statusLog')} />
                <ol className="space-y-2">
                  {v.statusLogs.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-36 text-xs tabular-nums text-ink-muted">{fmtDateTime(l.createdAt)}</span>
                      {l.fromStatus && <><StatusBadge enumName="VisitStatus" value={l.fromStatus} /><span>←</span></>}
                      <StatusBadge enumName="VisitStatus" value={l.toStatus} />
                      <span className="text-xs text-ink-muted">{t('visit.by')} {l.userId ? v.userNames[l.userId] : '—'}</span>
                      {l.note && <span className="text-xs text-ink-soft">— {l.note}</span>}
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
          <aside className="space-y-4">
            <Card>
              <CardHeader title={t('visit.patientSummary')} />
              {p.allergies && p.allergies.length > 0 && (
                <div className="mb-3 rounded-xl bg-danger-50 p-3">
                  <p className="mb-1 flex items-center gap-1 text-xs font-bold text-danger-700"><AlertTriangle className="h-4 w-4" />{t('patients.allergies')}</p>
                  <div className="flex flex-wrap gap-1">{p.allergies.map((a) => <Badge key={a.id} tone="danger" dot={false}>{a.allergen}</Badge>)}</div>
                </div>
              )}
              <p className="text-xs font-bold text-ink-muted">{t('patients.chronic')}</p>
              <p className="mb-3 text-sm">{p.histories?.filter((h) => h.type === 'CHRONIC').map((h) => h.name).join('، ') || '—'}</p>
              <p className="text-xs font-bold text-ink-muted">{t('patients.medications')}</p>
              <p className="mb-3 text-sm" dir="auto">{p.medications?.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join('، ') || '—'}</p>
              {v.chiefComplaint && <><p className="text-xs font-bold text-ink-muted">{t('patients.chiefComplaint')}</p><p className="mb-3 text-sm">{v.chiefComplaint}</p></>}
              {latestVitals && <><p className="mb-1.5 text-xs font-bold text-ink-muted">{t('patients.vitals')}</p><VitalsStrip v={latestVitals} /></>}
            </Card>
            {canAny('insurance.view', 'insurance.update') && <VisitInsuranceCard v={v} />}
            {(v.prescriptions?.length ?? 0) > 0 && (
              <Button variant="outline" className="w-full" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/print/prescription/${v.prescriptions![0].id}`, '_blank')}>{t('visit.rx.print')}</Button>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function PayerBadge({ v }: { v: VisitDetail }) {
  const { t } = useTranslation();
  if (v.payerType !== 'INSURANCE' || !v.patientInsurance) return <Badge tone="neutral" dot={false}>{t('ins.payer.selfPay')}</Badge>;
  return <Badge tone="primary"><ShieldCheck className="h-3 w-3" />{t('ins.payer.insurance')}: {v.patientInsurance.company.nameAr} · {v.patientInsurance.memberId}</Badge>;
}

/** Who pays for this visit, and its pre-authorizations. The payer can change until an invoice is issued. */
function VisitInsuranceCard({ v }: { v: VisitDetail }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [payer, setPayer] = useState<PayerValue | null>({ payerType: v.payerType, patientInsuranceId: v.patientInsuranceId });
  const save = useApiMutation(() => api.put(`/visits/${v.id}/payer`, payer), { invalidate: [['visit', v.id]], success: t('ins.payer.changed'), onSuccess: () => setOpen(false) });
  const issued = v.invoices.some((i) => !['DRAFT', 'CANCELLED'].includes(i.status));
  return (
    <Card>
      <CardHeader title={t('ins.payer.label')} icon={<ShieldCheck className="h-5 w-5" />}
        actions={can('insurance.update') && !issued && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{t('ins.payer.change')}</Button>} />
      {v.payerType === 'INSURANCE' && v.patientInsurance ? (
        <dl className="mb-3 space-y-1 text-sm">
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('ins.company')}</dt><dd className="font-semibold">{v.patientInsurance.company.nameAr}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('ins.contract')}</dt><dd>{v.patientInsurance.contract.name}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('ins.m.memberId')}</dt><dd className="font-mono" dir="ltr">{v.patientInsurance.memberId}</dd></div>
        </dl>
      ) : <p className="mb-3 text-sm text-ink-muted">{t('ins.payer.selfPay')}</p>}
      {v.payerType === 'INSURANCE' && <AuthorizationsList patientId={v.patient.id} visitId={v.id} compact />}
      <Dialog open={open} onClose={() => setOpen(false)} title={t('ins.payer.change')} subtitle={v.patient.fullName}
        footer={<><Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
        <PayerPicker patientId={v.patient.id} value={payer} onChange={setPayer} />
      </Dialog>
    </Card>
  );
}
