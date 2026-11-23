import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FlaskConical, HeartPulse, Pill, Stethoscope, FileText, ClipboardList } from 'lucide-react';
import { fmtDateTime } from '@/lib/format';
import type { TimelineVisit } from '@/lib/clinical';
import { Badge } from '@/components/ui';
import { StatusBadge } from './StatusBadge';
import { VitalsStrip } from './VitalsStrip';

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-ink-soft">{icon}{title}</p>
      {children}
    </div>
  );
}

export function VisitTimelineItem({ v }: { v: TimelineVisit }) {
  const { t } = useTranslation();
  return (
    <li className="relative ps-7">
      <span className="absolute start-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-white bg-primary-400 ring-2 ring-primary-100" />
      <div className="rounded-2xl border border-line bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{fmtDateTime(v.arrivedAt)}</span>
            <StatusBadge enumName="VisitStatus" value={v.status} />
            {v.visitType && <Badge dot={false}>{v.visitType.name}</Badge>}
            <span className="text-xs text-ink-muted">{v.doctor?.fullName ?? ''}</span>
          </div>
          <Link to={`/visits/${v.id}`} className="text-xs font-semibold text-primary-700 hover:underline">{t('patients.openVisit')} · {v.visitNumber}</Link>
        </div>
        <div className="space-y-3 text-sm">
          {(v.consultation?.chiefComplaint || v.chiefComplaint) && <p><b className="text-ink-soft">{t('patients.chiefComplaint')}:</b> {v.consultation?.chiefComplaint ?? v.chiefComplaint}</p>}
          {v.vitalSigns[0] && <Section icon={<HeartPulse className="h-3.5 w-3.5" />} title={t('patients.vitals')}><VitalsStrip v={v.vitalSigns[0]} /></Section>}
          {v.diagnoses.length > 0 && (
            <Section icon={<Stethoscope className="h-3.5 w-3.5" />} title={t('patients.diagnosis')}>
              <div className="flex flex-wrap gap-1.5">
                {v.diagnoses.map((d) => <Badge key={d.id} tone={d.type === 'PRIMARY' ? 'primary' : 'neutral'} dot={false}>{d.icd10Code && <span dir="ltr" className="font-mono">{d.icd10Code}</span>} {d.description}</Badge>)}
              </div>
            </Section>
          )}
          {v.consultation && (v.consultation.examination || v.consultation.clinicalNotes || v.consultation.treatmentPlan) && (
            <div className="grid gap-2 rounded-xl bg-surface-subtle p-3 text-xs leading-relaxed sm:grid-cols-3">
              {v.consultation.examination && <p><b>{t('visit.examination')}:</b> {v.consultation.examination}</p>}
              {v.consultation.clinicalNotes && <p><b>{t('visit.clinicalNotes')}:</b> {v.consultation.clinicalNotes}</p>}
              {v.consultation.treatmentPlan && <p><b>{t('visit.treatmentPlan')}:</b> {v.consultation.treatmentPlan}</p>}
            </div>
          )}
          {v.prescriptions.length > 0 && (
            <Section icon={<Pill className="h-3.5 w-3.5" />} title={t('patients.prescription')}>
              <ul className="space-y-1">
                {v.prescriptions.flatMap((p) => p.items).map((i, idx) => (
                  <li key={idx} className="text-xs"><b dir="ltr">{i.drugName}</b> — {[i.dose, i.frequency, i.duration, i.route].filter(Boolean).join(' · ')}</li>
                ))}
              </ul>
            </Section>
          )}
          {v.labOrders.length > 0 && (
            <Section icon={<FlaskConical className="h-3.5 w-3.5" />} title={t('patients.labs')}>
              <ul className="space-y-1.5">
                {v.labOrders.map((o) => (
                  <li key={o.id} className="text-xs">
                    <Link to={`/lab/${o.id}`} className="font-semibold text-primary-700 hover:underline">{o.orderNumber}</Link> <StatusBadge enumName="LabOrderStatus" value={o.status} />
                    <span className="ms-1 text-ink-soft">
                      {o.items.map((i) => `${i.testName}${i.results.length ? `: ${i.results.map((r) => `${r.parameterName} ${r.value}${r.unit ? ' ' + r.unit : ''}${r.flag && r.flag !== 'NORMAL' ? ` (${t(`enum.ResultFlag.${r.flag}`)})` : ''}`).join('، ')}` : ''}`).join(' | ')}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {v.nursingNotes.length > 0 && (
            <Section icon={<ClipboardList className="h-3.5 w-3.5" />} title={t('patients.procedures')}>
              <ul className="text-xs">{v.nursingNotes.map((n) => <li key={n.id}>• {n.procedure}{n.notes ? ` — ${n.notes}` : ''}</li>)}</ul>
            </Section>
          )}
          {v.medicalReports.length > 0 && (
            <Section icon={<FileText className="h-3.5 w-3.5" />} title={t('patients.report')}>
              <div className="flex flex-wrap gap-2">
                {v.medicalReports.map((r) => <a key={r.id} href={`/print/medical-report/${r.id}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-primary-700 hover:underline">{r.title}</a>)}
              </div>
            </Section>
          )}
        </div>
      </div>
    </li>
  );
}
