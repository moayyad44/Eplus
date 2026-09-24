import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Printer, X } from 'lucide-react';
import clsx from 'clsx';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, money, num, qty } from '@/lib/format';
import type { Invoice } from '@/lib/billing';
import type { Patient } from '@/lib/types';
import { bp, type LabOrder, type RxItem, type TimelineVisit } from '@/lib/clinical';
import { ErrorState, PageLoader } from '@/components/ui';

type Settings = { clinic: { name: string; nameEn: string; address: string; phone: string; email: string; taxNumber: string; reportFooter: string; logoKey: string | null }; financial: { invoiceFooter: string }; medical: { prescriptionFooter: string } };
const useSettings = () => useQuery({ queryKey: ['settings-public'], queryFn: () => api.get<Settings>('/settings/public'), staleTime: 5 * 60_000 });

/** Common A4 / thermal shell: clinic header, title, body, footer; opens the print dialog once data is ready. */
function Shell({ title, ready, children, thermal, footer }: { title: string; ready: boolean; children: ReactNode; thermal?: boolean; footer?: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const s = useSettings();
  useEffect(() => {
    if (!ready || !s.data) return;
    document.title = title;
    const id = setTimeout(() => window.print(), 400);
    return () => clearTimeout(id);
  }, [ready, s.data, title]);
  if (!s.data) return <PageLoader />;
  const c = s.data.clinic;
  return (
    <div className="min-h-screen bg-surface-sunken py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] justify-end gap-2 px-4">
        <button onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white"><Printer className="h-4 w-4" />{t('print.print')}</button>
        <button onClick={() => window.close()} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold"><X className="h-4 w-4" />{t('print.close')}</button>
      </div>
      <div className={clsx('print-page mx-auto bg-white text-[13px] leading-relaxed text-black shadow-pop', thermal ? 'print-thermal p-3 text-[11px]' : 'w-full max-w-[210mm] p-[12mm]')}>
        <header className={clsx('flex items-start justify-between gap-4 border-b-2 border-primary-400 pb-3', thermal && 'flex-col items-center text-center')}>
          <div className={clsx('flex items-center gap-3', thermal && 'flex-col')}>
            {c.logoKey ? <img src="/api/public/logo" alt="" className={thermal ? 'h-10' : 'h-14'} /> : (
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-400"><svg viewBox="0 0 24 24" className="h-7 w-7" fill="white"><path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z" /></svg></span>
            )}
            <div>
              <p className={clsx('font-extrabold', thermal ? 'text-sm' : 'text-lg')}>{c.name}</p>
              {!thermal && c.nameEn && <p className="text-xs text-gray-600" dir="ltr">{c.nameEn}</p>}
            </div>
          </div>
          <div className={clsx('text-xs text-gray-700', thermal ? 'text-center' : 'text-end')}>
            {c.address && <p>{c.address}</p>}
            {c.phone && <p dir="ltr">{c.phone}</p>}
            {c.email && <p dir="ltr">{c.email}</p>}
            {c.taxNumber && <p>TAX: {c.taxNumber}</p>}
          </div>
        </header>
        <h1 className={clsx('my-4 text-center font-bold', thermal ? 'text-sm' : 'text-xl')}>{title}</h1>
        {children}
        <footer className="mt-8 border-t border-gray-300 pt-2 text-center text-[10px] text-gray-500">
          {footer && <p className="mb-1 text-xs text-gray-700">{footer}</p>}
          <p>{c.reportFooter} {t('common.generatedAt')}: {fmtDateTime(new Date())} · {t('common.printedBy')}: {me?.user.fullName}</p>
        </footer>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }) => <div><span className="text-gray-500">{k}: </span><b>{v || '—'}</b></div>;

function InvoicePrint() {
  const { id } = useParams();
  const [p] = useSearchParams();
  const { t } = useTranslation();
  const s = useSettings();
  const thermal = !!p.get('thermal');
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/billing/invoices/${id}`) });
  if (q.error) return <ErrorState error={q.error} />;
  const inv = q.data;
  return (
    <Shell title={`${t('print.invoice')} ${inv?.invoiceNumber ?? ''}`} ready={!!inv} thermal={thermal} footer={s.data?.financial.invoiceFooter}>
      {inv && (
        <>
          <div className={clsx('mb-4 grid gap-1', thermal ? 'grid-cols-1' : 'grid-cols-2')}>
            <Row k={t('billing.invoiceNumber')} v={inv.invoiceNumber} />
            <Row k={t('common.date')} v={fmtDateTime(inv.issuedAt)} />
            <Row k={t('print.patientName')} v={inv.patient.fullName} />
            <Row k={t('patients.fileNumber')} v={inv.patient.fileNumber} />
            {inv.doctor && <Row k={t('common.doctor')} v={inv.doctor.fullName} />}
            <Row k={t('common.status')} v={t(`enum.InvoiceStatus.${inv.status}`)} />
          </div>
          <table className="w-full border-collapse">
            <thead><tr className="bg-primary-50 text-xs"><th className="border border-gray-300 p-1.5 text-start">{t('billing.service')}</th><th className="border border-gray-300 p-1.5">{t('common.quantity')}</th>{!thermal && <th className="border border-gray-300 p-1.5">{t('billing.unitPrice')}</th>}{!thermal && <th className="border border-gray-300 p-1.5">{t('common.discount')}</th>}<th className="border border-gray-300 p-1.5 text-end">{t('billing.lineTotal')}</th></tr></thead>
            <tbody>
              {inv.items.map((i) => (
                <tr key={i.id}><td className="border border-gray-300 p-1.5">{i.description}</td><td className="border border-gray-300 p-1.5 text-center">{qty(i.quantity)}</td>{!thermal && <td className="border border-gray-300 p-1.5 text-center">{money(i.unitPrice)}</td>}{!thermal && <td className="border border-gray-300 p-1.5 text-center">{num(i.discount) ? money(i.discount) : '—'}</td>}<td className="border border-gray-300 p-1.5 text-end">{money(i.lineTotal)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className={clsx('mt-3 space-y-1', thermal ? '' : 'ms-auto w-72')}>
            <div className="flex justify-between"><span>{t('common.subtotal')}</span><span>{money(inv.subtotal)}</span></div>
            {num(inv.discountTotal) > 0 && <div className="flex justify-between"><span>{t('common.discount')}</span><span>-{money(inv.discountTotal)}</span></div>}
            {num(inv.taxTotal) > 0 && <div className="flex justify-between"><span>{t('common.tax')}</span><span>{money(inv.taxTotal)}</span></div>}
            <div className="flex justify-between border-t border-gray-400 pt-1 text-base font-bold"><span>{t('billing.total')}</span><span>{money(inv.total)}</span></div>
            <div className="flex justify-between"><span>{t('common.paid')}</span><span>{money(num(inv.paidAmount) - num(inv.refundedAmount))}</span></div>
            <div className="flex justify-between font-bold"><span>{t('common.balance')}</span><span>{money(inv.balance)}</span></div>
          </div>
          {inv.payments.filter((x) => !x.voidedAt).length > 0 && (
            <div className="mt-4 text-xs">
              <p className="mb-1 font-bold">{t('billing.payments')}</p>
              {inv.payments.filter((x) => !x.voidedAt).map((x) => <p key={x.id}>{x.receiptNumber} · {fmtDate(x.paidAt)} · {x.method.name} · {x.type === 'REFUND' ? '-' : ''}{money(x.amount)}</p>)}
            </div>
          )}
          {!thermal && <div className="mt-12 flex justify-between text-xs"><span>{t('print.signature')}: ____________</span><span>{t('print.stamp')}: ____________</span></div>}
        </>
      )}
    </Shell>
  );
}

function ReceiptPrint() {
  const { id } = useParams();
  const { t } = useTranslation();
  const s = useSettings();
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => api.get<{ receiptNumber: string; type: string; amount: number; paidAt: string; reference: string | null; notes: string | null; receivedBy: string | null; method: { name: string }; patient: { fullName: string; fileNumber: string }; invoice: { invoiceNumber: string; total: number; balance: number } }>(`/billing/payments/${id}`) });
  const r = q.data;
  const thermal = (s.data as unknown as { financial: { thermalReceipt?: boolean } })?.financial?.thermalReceipt;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Shell title={r?.type === 'REFUND' ? t('print.refundReceipt') : t('print.receipt')} ready={!!r} thermal={thermal}>
      {r && (
        <div className="space-y-2">
          <Row k={t('billing.receiptNumber')} v={r.receiptNumber} />
          <Row k={t('common.date')} v={fmtDateTime(r.paidAt)} />
          <Row k={t('print.receivedFrom')} v={`${r.patient.fullName} (#${r.patient.fileNumber})`} />
          <div className="my-3 rounded-lg border-2 border-primary-300 p-3 text-center text-xl font-extrabold">{money(r.amount)}</div>
          <Row k={t('billing.method')} v={r.method.name} />
          {r.reference && <Row k={t('billing.reference')} v={<span dir="ltr">{r.reference}</span>} />}
          <Row k={t('print.forInvoice')} v={r.invoice.invoiceNumber} />
          <Row k={t('print.remainingOnInvoice')} v={money(r.invoice.balance)} />
          {r.notes && <Row k={t('common.notes')} v={r.notes} />}
          <Row k={t('billing.receivedBy')} v={r.receivedBy} />
          <p className="pt-8 text-xs">{t('print.signature')}: ____________</p>
        </div>
      )}
    </Shell>
  );
}

function PrescriptionPrint() {
  const { id } = useParams();
  const { t } = useTranslation();
  const s = useSettings();
  const q = useQuery({ queryKey: ['rx', id], queryFn: () => api.get<{ createdAt: string; notes: string | null; items: RxItem[]; doctor: { fullName: string; specialty: string | null; licenseNumber: string | null }; patient: { fullName: string; fileNumber: string; gender: string; age: number | null; allergies: { allergen: string }[] }; visit: { visitNumber: string; diagnoses: { description: string; icd10Code: string | null }[] } }>(`/prescriptions/${id}`) });
  const rx = q.data;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Shell title={t('print.prescription')} ready={!!rx} footer={s.data?.medical.prescriptionFooter}>
      {rx && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-1">
            <Row k={t('print.patientName')} v={rx.patient.fullName} />
            <Row k={t('common.date')} v={fmtDate(rx.createdAt)} />
            <Row k={t('patients.fileNumber')} v={rx.patient.fileNumber} />
            <Row k={t('patients.age')} v={`${rx.patient.age ?? '—'} · ${t(`enum.Gender.${rx.patient.gender}`)}`} />
            <Row k={t('print.diagnosis')} v={rx.visit.diagnoses.map((d) => d.description).join('، ')} />
            <Row k={t('print.allergies')} v={rx.patient.allergies.map((a) => a.allergen).join('، ') || t('print.none')} />
          </div>
          <p className="mb-2 text-3xl font-bold text-primary-600" dir="ltr">℞</p>
          <ol className="space-y-3">
            {rx.items.map((i, idx) => (
              <li key={idx} className="border-b border-dashed border-gray-300 pb-2">
                <p className="font-bold" dir="ltr">{idx + 1}. {i.drugName}</p>
                <p>{[i.dose, i.frequency, i.duration && `${t('visit.rx.duration')}: ${i.duration}`, i.route].filter(Boolean).join(' — ')}</p>
                {i.instructions && <p className="text-gray-600">{i.instructions}</p>}
              </li>
            ))}
          </ol>
          {rx.notes && <p className="mt-3">{rx.notes}</p>}
          <div className="mt-12 text-end">
            <p className="font-bold">{rx.doctor.fullName}</p>
            <p className="text-xs text-gray-600">{rx.doctor.specialty}{rx.doctor.licenseNumber && ` · ${t('print.licensed')}: ${rx.doctor.licenseNumber}`}</p>
            <p className="mt-6 text-xs">{t('print.doctorSignature')}: ____________</p>
          </div>
        </>
      )}
    </Shell>
  );
}

function MedicalReportPrint() {
  const { id } = useParams();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['medical-report', id], queryFn: () => api.get<{ title: string; content: string; createdAt: string; doctor: { fullName: string; specialty: string | null; licenseNumber: string | null }; patient: { fullName: string; fileNumber: string; gender: string; age: number | null; nationalId: string | null }; visit: { visitNumber: string; arrivedAt: string } | null }>(`/medical-reports/${id}`) });
  const r = q.data;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Shell title={r?.title ?? t('print.medicalReport')} ready={!!r}>
      {r && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-1">
            <Row k={t('print.patientName')} v={r.patient.fullName} />
            <Row k={t('common.date')} v={fmtDate(r.createdAt)} />
            <Row k={t('patients.fileNumber')} v={r.patient.fileNumber} />
            <Row k={t('patients.nationalId')} v={r.patient.nationalId} />
            <Row k={t('patients.age')} v={`${r.patient.age ?? '—'} · ${t(`enum.Gender.${r.patient.gender}`)}`} />
            {r.visit && <Row k={t('billing.visit')} v={`${r.visit.visitNumber} · ${fmtDate(r.visit.arrivedAt)}`} />}
          </div>
          <p className="min-h-[40mm] whitespace-pre-wrap text-[14px] leading-loose">{r.content}</p>
          <div className="mt-12 text-end">
            <p className="font-bold">{r.doctor.fullName}</p>
            <p className="text-xs text-gray-600">{r.doctor.specialty}{r.doctor.licenseNumber && ` · ${t('print.licensed')}: ${r.doctor.licenseNumber}`}</p>
            <p className="mt-6 text-xs">{t('print.doctorSignature')}: ____________</p>
          </div>
        </>
      )}
    </Shell>
  );
}

function LabPrint() {
  const { id } = useParams();
  const [p] = useSearchParams();
  const { t } = useTranslation();
  const result = p.get('mode') === 'result';
  const q = useQuery({ queryKey: ['lab', id], queryFn: () => api.get<LabOrder & { patient: { fullName: string; fileNumber: string; gender: string; age: number | null }; doctor: { fullName: string }; collectedAt: string | null }>(`/lab/orders/${id}`) });
  const o = q.data;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Shell title={result ? t('print.labResult') : t('print.labRequest')} ready={!!o}>
      {o && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-1">
            <Row k={t('lab.orderNumber')} v={o.orderNumber} />
            <Row k={t('lab.requestedAt')} v={fmtDateTime(o.requestedAt)} />
            <Row k={t('print.patientName')} v={o.patient.fullName} />
            <Row k={t('patients.age')} v={`${o.patient.age ?? '—'} · ${t(`enum.Gender.${o.patient.gender}`)}`} />
            <Row k={t('lab.requestedBy')} v={o.doctor.fullName} />
            {result ? <Row k={t('lab.completedAt')} v={fmtDateTime(o.completedAt)} /> : <Row k={t('reception.priority')} v={t(`enum.Priority.${o.priority}`)} />}
          </div>
          {!result && o.clinicalNotes && <p className="mb-3"><b>{t('lab.clinicalNotes')}:</b> {o.clinicalNotes}</p>}
          {result ? o.items.map((i) => (
            <div key={i.id} className="mb-4">
              <p className="mb-1 font-bold">{i.testName}</p>
              <table className="w-full border-collapse text-xs" dir="ltr">
                <thead><tr className="bg-primary-50"><th className="border border-gray-300 p-1 text-left">Test</th><th className="border border-gray-300 p-1">Result</th><th className="border border-gray-300 p-1">Unit</th><th className="border border-gray-300 p-1">Reference</th><th className="border border-gray-300 p-1">Flag</th></tr></thead>
                <tbody>{i.results.map((r) => <tr key={r.id} className={r.flag && r.flag !== 'NORMAL' ? 'font-bold' : ''}><td className="border border-gray-300 p-1">{r.parameterName}</td><td className="border border-gray-300 p-1 text-center">{r.value}</td><td className="border border-gray-300 p-1 text-center">{r.unit}</td><td className="border border-gray-300 p-1 text-center">{r.referenceRange}</td><td className="border border-gray-300 p-1 text-center">{r.flag && r.flag !== 'NORMAL' ? r.flag : ''}</td></tr>)}</tbody>
              </table>
              {i.notes && <p className="text-xs">{i.notes}</p>}
            </div>
          )) : (
            <ol className="list-inside list-decimal space-y-1">{o.items.map((i) => <li key={i.id}><b>{i.testName}</b> {i.labTest?.sampleType && <span className="text-gray-600">({i.labTest.sampleType})</span>}</li>)}</ol>
          )}
          <p className="mt-12 text-xs">{t('print.signature')}: ____________</p>
        </>
      )}
    </Shell>
  );
}

function PatientPrint() {
  const { id } = useParams();
  const { t } = useTranslation();
  const p = useQuery({ queryKey: ['patient', id], queryFn: () => api.get<Patient>(`/patients/${id}`) });
  const tl = useQuery({ queryKey: ['timeline', id, 'print'], queryFn: () => api.get<Paged<TimelineVisit>>(`/patients/${id}/timeline`, { pageSize: 50 }) });
  const pt = p.data;
  if (p.error) return <ErrorState error={p.error} />;
  return (
    <Shell title={t('print.patientReport')} ready={!!pt && !!tl.data}>
      {pt && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-1">
            <Row k={t('print.patientName')} v={pt.fullName} /><Row k={t('patients.fileNumber')} v={pt.fileNumber} /><Row k={t('patients.phone')} v={<span dir="ltr">{pt.phone}</span>} />
            <Row k={t('patients.gender')} v={t(`enum.Gender.${pt.gender}`)} /><Row k={t('patients.dateOfBirth')} v={fmtDate(pt.dateOfBirth)} /><Row k={t('patients.bloodType')} v={pt.bloodType} />
          </div>
          <p><b>{t('patients.allergies')}:</b> {pt.allergies?.map((a) => `${a.allergen} (${t(`enum.AllergySeverity.${a.severity}`)})`).join('، ') || t('print.none')}</p>
          <p><b>{t('patients.histories')}:</b> {pt.histories?.filter((h) => h.isActive).map((h) => `${h.name} (${t(`enum.HistoryType.${h.type}`)})`).join('، ') || t('print.none')}</p>
          <p className="mb-4"><b>{t('patients.medications')}:</b> {pt.medications?.filter((m) => m.isActive).map((m) => `${m.name} ${m.dose ?? ''}`).join('، ') || t('print.none')}</p>
          <h2 className="mb-2 border-b border-gray-300 pb-1 font-bold">{t('patients.visitsTimeline')}</h2>
          {tl.data?.items.map((v) => (
            <div key={v.id} className="mb-3 border-b border-dashed border-gray-300 pb-2 text-xs" style={{ breakInside: 'avoid' }}>
              <p className="font-bold">{fmtDateTime(v.arrivedAt)} — {v.doctor?.fullName ?? ''} — {v.visitNumber}</p>
              {(v.consultation?.chiefComplaint || v.chiefComplaint) && <p>{t('patients.chiefComplaint')}: {v.consultation?.chiefComplaint ?? v.chiefComplaint}</p>}
              {v.vitalSigns[0] && <p>{t('patients.vitals')}: BP {bp(v.vitalSigns[0])} · HR {v.vitalSigns[0].heartRate ?? '—'} · T {v.vitalSigns[0].temperature ?? '—'} · SpO2 {v.vitalSigns[0].oxygenSaturation ?? '—'}</p>}
              {v.diagnoses.length > 0 && <p>{t('patients.diagnosis')}: {v.diagnoses.map((d) => `${d.description}${d.icd10Code ? ` (${d.icd10Code})` : ''}`).join('، ')}</p>}
              {v.prescriptions.length > 0 && <p>{t('patients.prescription')}: <span dir="ltr">{v.prescriptions.flatMap((x) => x.items).map((i) => `${i.drugName} ${i.dose ?? ''}`).join(', ')}</span></p>}
              {v.labOrders.length > 0 && <p>{t('patients.labs')}: {v.labOrders.flatMap((o) => o.items).map((i) => `${i.testName}${i.results.length ? `: ${i.results.map((r) => `${r.parameterName} ${r.value}`).join(', ')}` : ''}`).join(' | ')}</p>}
            </div>
          ))}
        </>
      )}
    </Shell>
  );
}

export default function PrintRoutes() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return (
    <Routes>
      <Route path="invoice/:id" element={<InvoicePrint />} />
      <Route path="receipt/:id" element={<ReceiptPrint />} />
      <Route path="prescription/:id" element={<PrescriptionPrint />} />
      <Route path="medical-report/:id" element={<MedicalReportPrint />} />
      <Route path="lab/:id" element={<LabPrint />} />
      <Route path="patient/:id" element={<PatientPrint />} />
    </Routes>
  );
}
