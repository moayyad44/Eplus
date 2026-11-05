import { Fragment, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ChevronDown, Download, Printer } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { fmtDateTime, money } from '@/lib/format';
import { useInsuranceCompanies } from '@/lib/insurance';
import { Badge, Button, Card, EmptyState, ErrorState, PageLoader, SearchInput, Select, StatCard, type Range } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { useDoctors } from '@/components/shared/VisitQueueForm';

interface Pay { date: string; method: string; amount: number; reference: string | null; receipt?: string; by?: string | null; notes?: string | null }
interface Row {
  id: string; invoiceNumber: string; issuedAt: string; status: string; payer: string; payerLabel: string;
  patient: { id: string; name: string; phone: string; fileNumber: string; gender: string; dateOfBirth: string | null; age: number | null; nationalId: string | null };
  visitNumber: string | null; visitType: string | null; chiefComplaint: string | null; doctor: string | null; nurses: string[]; createdBy: string | null;
  services: string[]; procedures: string[]; labTests: string[]; orderedTests: string[]; materials: string[]; materialsFromStock: string[];
  items: { description: string; category: string; quantity: number; unitPrice: number; discount: number; total: number; insurance: number; patient: number }[];
  subtotal: number; discount: number; tax: number; total: number; insuranceShare: number; patientShare: number; paid: number; refunded: number; balance: number;
  payments: Pay[]; refunds: Pay[]; methods: string[]; references: string[];
  insurance: { company: string; program: string | null; memberId: string | null; cardNumber: string | null; policyNumber: string | null } | null;
  claim: { number: string; status: string; approved: number; paid: number } | null;
  diagnoses: string[]; prescription: string[]; reports: { title: string; content: string }[]; examination: string | null; treatmentPlan: string | null; vitals: string | null;
  labRevenue: number; labCost: number; materialsCost: number; einvoice: string | null; notes: string | null; cancelReason: string | null;
}
interface Res { rows: Row[]; totals: { invoices: number; cancelled: number; total: number; discount: number; insuranceShare: number; patientShare: number; paid: number; balance: number; labRevenue: number; labCost: number; materialsCost: number }; truncated: boolean }

const L = ({ label, children }: { label: string; children: ReactNode }) => (children == null || children === '' || (Array.isArray(children) && !children.length) ? null : <div className="flex gap-2 text-xs"><span className="w-28 shrink-0 text-ink-muted">{label}</span><span className="font-medium text-ink">{children}</span></div>);
const list = (a: string[]) => (a.length ? a.join('، ') : null);

/** One row per invoice with everything around it; details open under each row; full Excel from the server. */
export function InvoiceDetailsReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const doctors = useDoctors();
  const companies = useInsuranceCompanies();
  const [f, setF] = useState({ doctorId: '', companyId: '', payer: '', status: '', q: '' });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const params = { ...range, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) };
  const q = useQuery({ queryKey: ['report', 'invoice-details', params], queryFn: () => api.get<Res>('/reports/invoice-details', params) });
  const d = q.data;
  const toggle = (id: string) => { const s = new Set(open); s.has(id) ? s.delete(id) : s.add(id); setOpen(s); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <SearchInput value={f.q} onChange={(x) => setF({ ...f, q: x })} placeholder={t('rd.search')} className="w-56" />
        <Select value={f.doctorId} onChange={(e) => setF({ ...f, doctorId: e.target.value })} className="!h-9 w-40"><option value="">{t('common.doctor')}: {t('common.all')}</option>{doctors.data?.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</Select>
        <Select value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })} className="!h-9 w-36"><option value="">{t('rd.payer')}: {t('common.all')}</option><option value="SELF_PAY">{t('enum.PayerType.SELF_PAY')}</option><option value="INSURANCE">{t('enum.PayerType.INSURANCE')}</option></Select>
        {!!companies.data?.length && <Select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })} className="!h-9 w-44"><option value="">{t('rd.company')}: {t('common.all')}</option>{companies.data.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}</Select>}
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className="!h-9 w-36"><option value="">{t('common.status')}: {t('common.all')}</option>{['open', 'paid', 'cancelled'].map((s) => <option key={s} value={s}>{t(`rd.st.${s}`)}</option>)}</Select>
        <div className="ms-auto flex gap-2">
          <a href={`/api/reports/invoice-details${qs({ ...params, format: 'xlsx' })}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3 text-xs font-semibold hover:bg-surface-subtle"><Download className="h-4 w-4" />Excel ({t('rd.allColumns')})</a>
          <Button variant="outline" size="sm" onClick={() => setOpen(open.size ? new Set() : new Set((d?.rows ?? []).map((r) => r.id)))}>{open.size ? t('rd.collapse') : t('rd.expand')}</Button>
          <Button variant="outline" size="sm" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')} / {t('common.exportPdf')}</Button>
        </div>
      </div>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <PageLoader /> : <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label={t('rd.invoices')} value={d.totals.invoices} hint={d.totals.cancelled ? t('rd.ofCancelled', { n: d.totals.cancelled }) : undefined} />
          <StatCard label={t('rd.total')} value={money(d.totals.total)} tone="primary" hint={`${t('common.discount')}: ${money(d.totals.discount)}`} />
          <StatCard label={t('rd.insuranceShare')} value={money(d.totals.insuranceShare)} tone="violet" hint={`${t('rd.patientShare')}: ${money(d.totals.patientShare)}`} />
          <StatCard label={t('common.paid')} value={money(d.totals.paid)} tone="success" hint={`${t('common.balance')}: ${money(d.totals.balance)}`} />
          <StatCard label={t('rd.labRevenue')} value={money(d.totals.labRevenue)} tone="warning" hint={`${t('rd.labCost')}: ${money(d.totals.labCost)} · ${t('rd.materialsCost')}: ${money(d.totals.materialsCost)}`} />
        </div>
        {d.truncated && <p className="text-xs text-warning-700">{t('rd.truncated')}</p>}
        <Card padded={false}>
          {!d.rows.length ? <EmptyState /> : <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-sm">
            <thead><tr className="border-b border-line bg-surface-subtle text-xs text-ink-muted">
              {['', 'rd.invoice', 'rd.dateTime', 'rd.patient', 'common.phone', 'common.doctor', 'rd.nurse', 'rd.methodRef', 'common.discount', 'rd.insuranceShare', 'rd.patientShare', 'rd.total', 'common.status'].map((k) => <th key={k} className="p-2 text-start font-semibold">{k && t(k)}</th>)}
            </tr></thead>
            <tbody>{d.rows.map((r) => (
              <Fragment key={r.id}>
                <tr className={clsx('cursor-pointer border-b border-line/60 hover:bg-surface-subtle', r.status === 'CANCELLED' && 'text-ink-muted line-through decoration-danger-400')} onClick={() => toggle(r.id)}>
                  <td className="p-2 print:hidden"><ChevronDown className={clsx('h-4 w-4 transition', open.has(r.id) && 'rotate-180')} /></td>
                  <td className="p-2"><span className="font-mono text-xs">{r.invoiceNumber}</span>{r.visitNumber && <span className="block text-[11px] text-ink-muted">{t('rd.visit')} {r.visitNumber}</span>}</td>
                  <td className="p-2 text-xs tabular-nums">{fmtDateTime(r.issuedAt)}</td>
                  <td className="p-2"><b>{r.patient.name}</b><span className="block text-[11px] text-ink-muted">{r.patient.fileNumber} · {r.patient.gender}{r.patient.age != null && ` · ${r.patient.age} ${t('rd.years')}`}</span></td>
                  <td className="p-2 text-xs" dir="ltr">{r.patient.phone}</td>
                  <td className="p-2 text-xs">{r.doctor ?? '—'}</td>
                  <td className="p-2 text-xs">{list(r.nurses) ?? '—'}</td>
                  <td className="p-2 text-xs">{list(r.methods) ?? '—'}{r.references.length > 0 && <span className="block text-ink-muted" dir="ltr">{r.references.join(', ')}</span>}</td>
                  <td className="p-2 text-xs tabular-nums">{r.discount ? money(r.discount) : '—'}</td>
                  <td className="p-2 text-xs tabular-nums">{r.insuranceShare ? money(r.insuranceShare) : '—'}{r.insurance && <span className="block text-ink-muted">{r.insurance.company}</span>}</td>
                  <td className="p-2 text-xs tabular-nums">{money(r.patientShare)}</td>
                  <td className="p-2 font-bold tabular-nums">{money(r.total)}</td>
                  <td className="p-2"><StatusBadge enumName="InvoiceStatus" value={r.status} /></td>
                </tr>
                {open.has(r.id) && <tr className="border-b border-line bg-surface-subtle/60"><td colSpan={13} className="p-3">
                  <div className="grid gap-4 lg:grid-cols-3">
                    <div className="space-y-1">
                      <p className="mb-1 text-xs font-bold text-primary-700">{t('rd.sec.patient')}</p>
                      <L label={t('rd.dob')}>{r.patient.dateOfBirth}</L><L label={t('rd.gender')}>{r.patient.gender}</L><L label={t('rd.nationalId')}>{r.patient.nationalId}</L>
                      <L label={t('rd.visitType')}>{r.visitType}</L><L label={t('rd.complaint')}>{r.chiefComplaint}</L><L label={t('rd.vitals')}>{r.vitals}</L>
                      <L label={t('rd.diagnosis')}>{list(r.diagnoses)}</L><L label={t('rd.examination')}>{r.examination}</L><L label={t('rd.plan')}>{r.treatmentPlan}</L>
                      <L label={t('rd.prescription')}>{r.prescription.length ? <ul className="list-disc ps-4">{r.prescription.map((p) => <li key={p} dir="auto">{p}</li>)}</ul> : null}</L>
                      {r.reports.map((rep) => <L key={rep.title} label={t('rd.report')}><b>{rep.title}</b><span className="block whitespace-pre-line font-normal">{rep.content}</span></L>)}
                    </div>
                    <div className="space-y-1">
                      <p className="mb-1 text-xs font-bold text-primary-700">{t('rd.sec.services')}</p>
                      <L label={t('rd.services')}>{list(r.services)}</L><L label={t('rd.procedures')}>{list(r.procedures)}</L><L label={t('rd.tests')}>{list(r.labTests)}</L>
                      <L label={t('rd.orderedTests')}>{list(r.orderedTests)}</L><L label={t('rd.materials')}>{list(r.materials)}</L><L label={t('rd.fromStock')}>{list(r.materialsFromStock)}</L>
                      <L label={t('rd.labRevenue')}>{r.labRevenue ? money(r.labRevenue) : null}</L><L label={t('rd.labCost')}>{r.labCost ? money(r.labCost) : null}</L><L label={t('rd.materialsCost')}>{r.materialsCost ? money(r.materialsCost) : null}</L>
                      <table className="mt-2 w-full text-xs"><tbody>{r.items.map((it, i) => <tr key={i} className="border-t border-line/60"><td className="py-1">{it.description}</td><td className="py-1 text-center">×{it.quantity}</td><td className="py-1 text-end tabular-nums">{money(it.unitPrice, false)}</td><td className="py-1 text-end tabular-nums text-warning-700">{it.discount ? `−${money(it.discount, false)}` : ''}</td><td className="py-1 text-end font-semibold tabular-nums">{money(it.total, false)}</td></tr>)}</tbody></table>
                    </div>
                    <div className="space-y-1">
                      <p className="mb-1 text-xs font-bold text-primary-700">{t('rd.sec.money')}</p>
                      <L label={t('rd.subtotal')}>{money(r.subtotal)}</L><L label={t('common.discount')}>{r.discount ? money(r.discount) : null}</L><L label={t('rd.tax')}>{r.tax ? money(r.tax) : null}</L>
                      <L label={t('rd.total')}>{money(r.total)}</L><L label={t('common.paid')}>{money(r.paid)}</L><L label={t('rd.refunded')}>{r.refunded ? money(r.refunded) : null}</L><L label={t('common.balance')}>{money(r.balance)}</L>
                      {r.payments.map((p, i) => <L key={i} label={`${t('rd.payment')} ${i + 1}`}>{p.method} · {money(p.amount)}{p.reference && <> · <span dir="ltr">{p.reference}</span></>}<span className="block font-normal text-ink-muted">{fmtDateTime(p.date)} · {p.receipt} · {p.by}</span></L>)}
                      {r.refunds.map((p, i) => <L key={`r${i}`} label={t('rd.refund')}>{p.method} · {money(p.amount)}{p.notes && <span className="block font-normal text-ink-muted">{p.notes}</span>}</L>)}
                      <L label={t('rd.payer')}>{r.payerLabel}</L>
                      {r.insurance && <><L label={t('rd.company')}>{r.insurance.company}</L><L label={t('rd.program')}>{r.insurance.program}</L><L label={t('rd.member')}>{r.insurance.memberId}</L><L label={t('rd.card')}>{r.insurance.cardNumber}</L></>}
                      {r.claim && <L label={t('rd.claim')}>{r.claim.number} · <Badge dot={false}>{t(`enum.ClaimStatus.${r.claim.status}`, { defaultValue: r.claim.status })}</Badge></L>}
                      <L label={t('rd.einvoice')}>{r.einvoice && t(`enum.EInvoiceStatus.${r.einvoice}`, { defaultValue: r.einvoice })}</L>
                      <L label={t('rd.createdBy')}>{r.createdBy}</L><L label={t('rd.cancelReason')}>{r.cancelReason}</L><L label={t('rd.notes')}>{r.notes}</L>
                    </div>
                  </div>
                </td></tr>}
              </Fragment>
            ))}</tbody>
          </table></div>}
        </Card>
      </>}
    </div>
  );
}
