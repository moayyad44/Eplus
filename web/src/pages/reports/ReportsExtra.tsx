import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Download, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { exportCsv } from '@/lib/export';
import { useCatalog } from '@/lib/catalogs';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, ErrorState, PageLoader, Segmented, Select, StatCard, type Range } from '@/components/ui';
import { BarsChart, ShareBars } from '@/components/shared/charts';
import { useDoctors } from '@/components/shared/VisitQueueForm';

function useR<T>(name: string, params: Record<string, string | undefined>) {
  return useQuery({ queryKey: ['report', name, params], queryFn: () => api.get<T>(`/reports/${name}`, params) });
}
function Bar({ onExport, children }: { onExport?: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      {children}
      <div className="ms-auto flex gap-2">
        {onExport && <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={onExport}>{t('common.exportCsv')}</Button>}
        <Button variant="outline" size="sm" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')} / {t('common.exportPdf')}</Button>
      </div>
    </div>
  );
}
function DoctorFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const doctors = useDoctors();
  return <Select value={value} onChange={(e) => onChange(e.target.value)} className="!h-9 w-44"><option value="">{t('common.doctor')}: {t('common.all')}</option>{doctors.data?.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</Select>;
}
const Wrap = ({ q, children }: { q: { error: unknown; data: unknown; refetch: () => void }; children: () => ReactNode }) => (q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <PageLoader /> : <>{children()}</>);
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
const mins = (v: number | null, t: (k: string) => string) => (v == null ? '—' : `${v} ${t('common.minutes')}`);

// ── Services ──
interface Svc { rows: { serviceId: string; code: string; name: string; category: string; quantity: number; invoices: number; gross: number; discount: number; net: number; insurance: number; patient: number; avgPrice: number; share: number }[]; totals: { quantity: number; net: number; discount: number; services: number }; byCategory: { category: string; amount: number }[] }
export function ServicesReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const [doctorId, setDoctorId] = useState('');
  const [category, setCategory] = useState('');
  const q = useR<Svc>('services', { ...range, doctorId: doctorId || undefined, category: category || undefined });
  const d = q.data;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('services-report', [
        { header: t('rx.code'), value: (x: Svc['rows'][number]) => x.code }, { header: t('rx.service'), value: (x) => x.name }, { header: t('rx.category'), value: (x) => t(`enum.ServiceCategory.${x.category}`) },
        { header: t('rx.qty'), value: (x) => x.quantity }, { header: t('rx.invoices'), value: (x) => x.invoices }, { header: t('rx.gross'), value: (x) => x.gross }, { header: t('common.discount'), value: (x) => x.discount },
        { header: t('rx.net'), value: (x) => x.net }, { header: t('rx.insuranceShare'), value: (x) => x.insurance }, { header: t('rx.patientShare'), value: (x) => x.patient }, { header: t('rx.avgPrice'), value: (x) => x.avgPrice },
      ], d.rows))}>
        <DoctorFilter value={doctorId} onChange={setDoctorId} />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="!h-9 w-44"><option value="">{t('rx.category')}: {t('common.all')}</option>{['EXAMINATION', 'CONSULTATION', 'PROCEDURE', 'LAB', 'NURSING', 'MEDICATION', 'OTHER'].map((c) => <option key={c} value={c}>{t(`enum.ServiceCategory.${c}`, { defaultValue: c })}</option>)}</Select>
      </Bar>
      <Wrap q={q}>{() => <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('rx.net')} value={money(d!.totals.net)} tone="success" />
          <StatCard label={t('rx.qty')} value={d!.totals.quantity} />
          <StatCard label={t('rx.servicesUsed')} value={d!.totals.services} tone="violet" />
          <StatCard label={t('common.discount')} value={money(d!.totals.discount)} tone="warning" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card><CardHeader title={t('rx.byCategory')} /><ShareBars rows={d!.byCategory.map((c) => ({ label: t(`enum.ServiceCategory.${c.category}`, { defaultValue: c.category }), value: c.amount }))} format={(v) => money(v)} /></Card>
          <Card className="lg:col-span-2"><CardHeader title={t('rx.top10')} />{d!.rows.length ? <BarsChart data={d!.rows.slice(0, 10)} x="name" series={[{ key: 'net', label: t('rx.net') }]} format={(v) => money(v, false)} height={260} /> : <EmptyState />}</Card>
        </div>
        <Card>
          <DataTable rows={d!.rows} rowKey={(x) => x.serviceId + x.category} dense columns={[
            { key: 'n', header: t('rx.service'), cell: (x) => <><b>{x.name}</b> <span className="font-mono text-[11px] text-ink-muted">{x.code}</span></> },
            { key: 'c', header: t('rx.category'), hideOnMobile: true, cell: (x) => t(`enum.ServiceCategory.${x.category}`, { defaultValue: x.category }) },
            { key: 'q', header: t('rx.qty'), cell: (x) => x.quantity },
            { key: 'a', header: t('rx.avgPrice'), hideOnMobile: true, cell: (x) => money(x.avgPrice) },
            { key: 'd', header: t('common.discount'), hideOnMobile: true, cell: (x) => (x.discount ? money(x.discount) : '—') },
            { key: 'i', header: t('rx.insuranceShare'), hideOnMobile: true, cell: (x) => (x.insurance ? money(x.insurance) : '—') },
            { key: 't', header: t('rx.net'), cell: (x) => <b>{money(x.net)}</b> },
            { key: 's', header: '%', cell: (x) => <span className="text-xs text-ink-muted">{x.share}%</span> },
          ]} />
        </Card>
      </>}</Wrap>
    </div>
  );
}

// ── Collections ──
interface Col { methods: string[]; byDay: (Record<string, number | string> & { day: string; total: number })[]; byCashier: { name: string; payments: number; refunds: number; net: number; count: number }[]; totals: { payments: number; refunds: number; count: number; voided: number }; refunds: { id: string; receiptNumber: string; paidAt: string; amount: number; method: string; invoiceNumber: string | null; patient: string; by: string; notes: string | null }[] }
export function CollectionsReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const q = useR<Col>('collections', { ...range });
  const d = q.data;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('collections-by-day', [{ header: t('common.date'), value: (x: Col['byDay'][number]) => x.day }, ...d.methods.map((m) => ({ header: m, value: (x: Col['byDay'][number]) => x[m] ?? 0 })), { header: t('common.total'), value: (x) => x.total }], d.byDay))} />
      <Wrap q={q}>{() => <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('rx.received')} value={money(d!.totals.payments)} tone="success" hint={`${t('rx.ops')}: ${d!.totals.count}`} />
          <StatCard label={t('rx.refunds')} value={money(d!.totals.refunds)} tone="warning" />
          <StatCard label={t('rx.netCollected')} value={money(d!.totals.payments - d!.totals.refunds)} tone="primary" />
          <StatCard label={t('rx.voidedPayments')} value={d!.totals.voided} tone={d!.totals.voided ? 'danger' : 'neutral'} />
        </div>
        <Card><CardHeader title={t('rx.dailyCollection')} />{d!.byDay.length ? <BarsChart data={d!.byDay} x="day" series={[{ key: 'total', label: t('rx.netCollected') }]} xFormat={(s) => s.slice(5)} format={(v) => money(v, false)} /> : <EmptyState />}</Card>
        <Card>
          <CardHeader title={t('rx.byDayMethod')} />
          <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-sm">
            <thead><tr className="border-b border-line text-xs text-ink-muted"><th className="p-2 text-start">{t('common.date')}</th>{d!.methods.map((m) => <th key={m} className="p-2 text-end">{m}</th>)}<th className="p-2 text-end">{t('common.total')}</th></tr></thead>
            <tbody>{d!.byDay.map((r) => <tr key={r.day} className="border-b border-line/60"><td className="p-2">{r.day}</td>{d!.methods.map((m) => <td key={m} className="p-2 text-end tabular-nums">{r[m] ? money(r[m], false) : '—'}</td>)}<td className="p-2 text-end font-bold tabular-nums">{money(r.total, false)}</td></tr>)}</tbody>
            <tfoot><tr className="bg-surface-subtle font-bold"><td className="p-2">{t('common.total')}</td>{d!.methods.map((m) => <td key={m} className="p-2 text-end tabular-nums">{money(d!.byDay.reduce((s, r) => s + Number(r[m] ?? 0), 0), false)}</td>)}<td className="p-2 text-end tabular-nums">{money(d!.byDay.reduce((s, r) => s + r.total, 0), false)}</td></tr></tfoot>
          </table></div>
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t('rx.byCashier')} />
            <DataTable rows={d!.byCashier} rowKey={(x) => x.name} dense columns={[
              { key: 'n', header: t('rx.employee'), cell: (x) => <b>{x.name}</b> }, { key: 'c', header: t('rx.ops'), cell: (x) => x.count },
              { key: 'p', header: t('rx.received'), cell: (x) => money(x.payments) }, { key: 'r', header: t('rx.refunds'), cell: (x) => (x.refunds ? money(x.refunds) : '—') }, { key: 't', header: t('rx.netCollected'), cell: (x) => <b>{money(x.net)}</b> },
            ]} />
          </Card>
          <Card>
            <CardHeader title={t('rx.refundsList')} />
            <DataTable rows={d!.refunds} rowKey={(x) => x.id} dense empty={<EmptyState className="!py-4" />} columns={[
              { key: 'd', header: t('common.date'), cell: (x) => <span className="text-xs">{fmtDateTime(x.paidAt)}</span> }, { key: 'p', header: t('common.patient'), cell: (x) => <>{x.patient}<span className="block text-xs text-ink-muted">{x.invoiceNumber}</span></> },
              { key: 'a', header: t('common.amount'), cell: (x) => <b>{money(x.amount)}</b> }, { key: 'b', header: t('rx.employee'), cell: (x) => <span className="text-xs">{x.by}</span> },
            ]} />
          </Card>
        </div>
      </>}</Wrap>
    </div>
  );
}

// ── Unpaid invoices ──
interface Rcv { rows: { id: string; invoiceNumber: string; issuedAt: string; total: number; paidAmount: number; balance: number; days: number; payerType: string; patient: { fullName: string; phone: string; fileNumber: string }; doctor: { fullName: string } | null }[]; buckets: Record<'b0_30' | 'b31_60' | 'b61_90' | 'b90', number>; total: number; byPatient: { patientId: string; name: string; phone: string; fileNumber: string; invoices: number; balance: number; oldest: number }[] }
export function ReceivablesReport() {
  const { t } = useTranslation();
  const [doctorId, setDoctorId] = useState('');
  const [view, setView] = useState<'patients' | 'invoices'>('patients');
  const q = useR<Rcv>('receivables', { doctorId: doctorId || undefined });
  const d = q.data;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('unpaid-invoices', [
        { header: t('billing.invoiceNumber'), value: (x: Rcv['rows'][number]) => x.invoiceNumber }, { header: t('common.date'), value: (x) => fmtDate(x.issuedAt) }, { header: t('common.patient'), value: (x) => x.patient.fullName },
        { header: t('common.phone'), value: (x) => x.patient.phone }, { header: t('common.doctor'), value: (x) => x.doctor?.fullName ?? '' }, { header: t('common.total'), value: (x) => x.total }, { header: t('common.paid'), value: (x) => x.paidAmount },
        { header: t('common.balance'), value: (x) => x.balance }, { header: t('rx.days'), value: (x) => x.days },
      ], d.rows))}>
        <Segmented value={view} onChange={setView} items={[{ key: 'patients', label: t('rx.byPatient') }, { key: 'invoices', label: t('rx.byInvoice') }]} />
        <DoctorFilter value={doctorId} onChange={setDoctorId} />
      </Bar>
      <Wrap q={q}>{() => <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label={t('rx.totalUnpaid')} value={money(d!.total)} tone="danger" hint={`${d!.rows.length} ${t('rx.invoices')}`} />
          {(['b0_30', 'b31_60', 'b61_90', 'b90'] as const).map((b) => <StatCard key={b} label={t(`rx.${b}`)} value={money(d!.buckets[b])} tone={b === 'b90' ? 'danger' : b === 'b0_30' ? 'neutral' : 'warning'} />)}
        </div>
        <p className="text-xs text-ink-muted">{t('rx.receivablesHint')}</p>
        <Card>
          {view === 'patients' ? <DataTable rows={d!.byPatient} rowKey={(x) => x.patientId} dense empty={<EmptyState />} columns={[
            { key: 'n', header: t('common.patient'), cell: (x) => <><b>{x.name}</b><span className="block text-xs text-ink-muted">{x.fileNumber}</span></> },
            { key: 'p', header: t('common.phone'), cell: (x) => <span dir="ltr">{x.phone}</span> },
            { key: 'i', header: t('rx.invoices'), cell: (x) => x.invoices },
            { key: 'o', header: t('rx.oldest'), cell: (x) => <span className={x.oldest > 60 ? 'font-bold text-danger-600' : ''}>{x.oldest} {t('rx.day')}</span> },
            { key: 'b', header: t('common.balance'), cell: (x) => <b>{money(x.balance)}</b> },
          ]} /> : <DataTable rows={d!.rows} rowKey={(x) => x.id} dense empty={<EmptyState />} columns={[
            { key: 'n', header: t('billing.invoiceNumber'), cell: (x) => <span className="font-mono text-xs">{x.invoiceNumber}</span> },
            { key: 'd', header: t('common.date'), cell: (x) => fmtDate(x.issuedAt) },
            { key: 'p', header: t('common.patient'), cell: (x) => <>{x.patient.fullName}<span className="block text-xs text-ink-muted" dir="ltr">{x.patient.phone}</span></> },
            { key: 'doc', header: t('common.doctor'), hideOnMobile: true, cell: (x) => x.doctor?.fullName ?? '—' },
            { key: 't', header: t('common.total'), hideOnMobile: true, cell: (x) => money(x.total) },
            { key: 'b', header: t('common.balance'), cell: (x) => <b>{money(x.balance)}</b> },
            { key: 'a', header: t('rx.days'), cell: (x) => <span className={x.days > 60 ? 'font-bold text-danger-600' : ''}>{x.days}</span> },
          ]} />}
        </Card>
      </>}</Wrap>
    </div>
  );
}

// ── Control ──
interface Ctl {
  cancelled: { id: string; invoiceNumber: string; cancelledAt: string; total: number; patient: string; cancelledBy: string; createdBy: string; cancelReason: string | null }[];
  voided: { id: string; receiptNumber: string; type: string; amount: number; paidAt: string; voidedAt: string; method: string; patient: string; invoiceNumber: string | null; voidedBy: string; receivedBy: string; voidReason: string | null }[];
  discountsByUser: { name: string; invoices: number; discount: number; subtotal: number; percent: number }[];
  discounts: { id: string; invoiceNumber: string; issuedAt: string; subtotal: number; discountTotal: number; patient: string; by: string }[];
  backdated: { id: string; invoiceNumber: string; issuedAt: string; issuedRecordedAt: string; total: number; patient: string; by: string; days: number }[];
  totals: { cancelled: number; cancelledAmount: number; voided: number; voidedAmount: number; discount: number; backdated: number };
}
export function ControlReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const q = useR<Ctl>('control', { ...range });
  const d = q.data;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('cancelled-invoices', [
        { header: t('billing.invoiceNumber'), value: (x: Ctl['cancelled'][number]) => x.invoiceNumber }, { header: t('rx.cancelledAt'), value: (x) => fmtDateTime(x.cancelledAt) }, { header: t('common.patient'), value: (x) => x.patient },
        { header: t('common.total'), value: (x) => x.total }, { header: t('rx.cancelledBy'), value: (x) => x.cancelledBy }, { header: t('rx.reason'), value: (x) => x.cancelReason ?? '' },
      ], d.cancelled))} />
      <Wrap q={q}>{() => <>
        <p className="text-xs text-ink-muted">{t('rx.controlHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('rx.cancelledInvoices')} value={d!.totals.cancelled} hint={money(d!.totals.cancelledAmount)} tone="danger" />
          <StatCard label={t('rx.voidedPayments')} value={d!.totals.voided} hint={money(d!.totals.voidedAmount)} tone="warning" />
          <StatCard label={t('rx.discounts')} value={money(d!.totals.discount)} tone="violet" />
          <StatCard label={t('rx.backdated')} value={d!.totals.backdated} tone="neutral" />
        </div>
        <Card>
          <CardHeader title={t('rx.discountsByUser')} />
          <DataTable rows={d!.discountsByUser} rowKey={(x) => x.name} dense empty={<EmptyState className="!py-4" />} columns={[
            { key: 'n', header: t('rx.employee'), cell: (x) => <b>{x.name}</b> }, { key: 'i', header: t('rx.invoices'), cell: (x) => x.invoices },
            { key: 's', header: t('rx.gross'), cell: (x) => money(x.subtotal) }, { key: 'd', header: t('rx.discounts'), cell: (x) => <b className="text-warning-700">{money(x.discount)}</b> }, { key: 'p', header: '%', cell: (x) => `${x.percent}%` },
          ]} />
        </Card>
        <Card>
          <CardHeader title={t('rx.cancelledInvoices')} />
          <DataTable rows={d!.cancelled} rowKey={(x) => x.id} dense empty={<EmptyState className="!py-4" />} columns={[
            { key: 'n', header: t('billing.invoiceNumber'), cell: (x) => <span className="font-mono text-xs">{x.invoiceNumber}</span> },
            { key: 'd', header: t('rx.cancelledAt'), cell: (x) => <span className="text-xs">{fmtDateTime(x.cancelledAt)}</span> },
            { key: 'p', header: t('common.patient'), cell: (x) => x.patient }, { key: 't', header: t('common.total'), cell: (x) => money(x.total) },
            { key: 'b', header: t('rx.cancelledBy'), cell: (x) => <span className="text-xs">{x.cancelledBy}<span className="block text-ink-muted">{t('rx.createdBy')}: {x.createdBy}</span></span> },
            { key: 'r', header: t('rx.reason'), cell: (x) => <span className="text-xs">{x.cancelReason}</span> },
          ]} />
        </Card>
        <Card>
          <CardHeader title={t('rx.voidedPayments')} />
          <DataTable rows={d!.voided} rowKey={(x) => x.id} dense empty={<EmptyState className="!py-4" />} columns={[
            { key: 'n', header: t('rx.receipt'), cell: (x) => <><span className="font-mono text-xs">{x.receiptNumber}</span> {x.type === 'REFUND' && <Badge dot={false}>{t('enum.PaymentType.REFUND')}</Badge>}</> },
            { key: 'p', header: t('common.patient'), cell: (x) => <>{x.patient}<span className="block text-xs text-ink-muted">{x.invoiceNumber}</span></> },
            { key: 'a', header: t('common.amount'), cell: (x) => <>{money(x.amount)}<span className="block text-xs text-ink-muted">{x.method}</span></> },
            { key: 'v', header: t('rx.voidedBy'), cell: (x) => <span className="text-xs">{x.voidedBy} · {fmtDateTime(x.voidedAt)}<span className="block text-ink-muted">{t('rx.receivedBy')}: {x.receivedBy}</span></span> },
            { key: 'r', header: t('rx.reason'), cell: (x) => <span className="text-xs">{x.voidReason}</span> },
          ]} />
        </Card>
        <Card>
          <CardHeader title={t('rx.backdated')} subtitle={t('rx.backdatedHint')} />
          <DataTable rows={d!.backdated} rowKey={(x) => x.id} dense empty={<EmptyState className="!py-4" />} columns={[
            { key: 'n', header: t('billing.invoiceNumber'), cell: (x) => <span className="font-mono text-xs">{x.invoiceNumber}</span> },
            { key: 'i', header: t('rx.invoiceDate'), cell: (x) => fmtDate(x.issuedAt) }, { key: 'r', header: t('rx.recordedAt'), cell: (x) => <span className="text-xs">{fmtDateTime(x.issuedRecordedAt)}</span> },
            { key: 'd', header: t('rx.days'), cell: (x) => <b>{x.days}</b> }, { key: 'p', header: t('common.patient'), cell: (x) => x.patient }, { key: 't', header: t('common.total'), cell: (x) => money(x.total) }, { key: 'b', header: t('rx.employee'), cell: (x) => <span className="text-xs">{x.by}</span> },
          ]} />
        </Card>
      </>}</Wrap>
    </div>
  );
}

// ── Appointments ──
interface Apt { total: number; byStatus: Record<string, number>; attendanceRate: number | null; noShowRate: number | null; byDoctor: { name: string; total: number; attended: number; noShow: number; cancelled: number }[]; byDay: { day: string; total: number; attended: number; noShow: number }[] }
export function AppointmentsReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const [doctorId, setDoctorId] = useState('');
  const q = useR<Apt>('appointments', { ...range, doctorId: doctorId || undefined });
  const d = q.data;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('appointments-by-doctor', [{ header: t('common.doctor'), value: (x: Apt['byDoctor'][number]) => x.name }, { header: t('rx.booked'), value: (x) => x.total }, { header: t('rx.attended'), value: (x) => x.attended }, { header: t('rx.noShow'), value: (x) => x.noShow }, { header: t('rx.cancelled'), value: (x) => x.cancelled }], d.byDoctor))}>
        <DoctorFilter value={doctorId} onChange={setDoctorId} />
      </Bar>
      <Wrap q={q}>{() => <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('rx.booked')} value={d!.total} />
          <StatCard label={t('rx.attendanceRate')} value={pct(d!.attendanceRate)} tone="success" />
          <StatCard label={t('rx.noShowRate')} value={pct(d!.noShowRate)} tone="danger" />
          <StatCard label={t('rx.cancelled')} value={d!.byStatus.CANCELLED ?? 0} tone="warning" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2"><CardHeader title={t('rx.apptByDay')} />{d!.byDay.length ? <BarsChart data={d!.byDay} x="day" series={[{ key: 'attended', label: t('rx.attended') }, { key: 'noShow', label: t('rx.noShow') }]} xFormat={(s) => s.slice(5)} /> : <EmptyState />}</Card>
          <Card><CardHeader title={t('rx.byStatus')} /><ShareBars rows={Object.entries(d!.byStatus).map(([k, v]) => ({ label: t(`enum.AppointmentStatus.${k}`), value: v }))} format={String} /></Card>
        </div>
        <Card>
          <DataTable rows={d!.byDoctor} rowKey={(x) => x.name} dense empty={<EmptyState />} columns={[
            { key: 'n', header: t('common.doctor'), cell: (x) => <b>{x.name}</b> }, { key: 't', header: t('rx.booked'), cell: (x) => x.total },
            { key: 'a', header: t('rx.attended'), cell: (x) => x.attended }, { key: 'ns', header: t('rx.noShow'), cell: (x) => <span className={x.noShow ? 'text-danger-600' : ''}>{x.noShow}</span> }, { key: 'c', header: t('rx.cancelled'), cell: (x) => x.cancelled },
          ]} />
        </Card>
      </>}</Wrap>
    </div>
  );
}

// ── Waiting times and busy hours ──
interface Ops { visits: number; avg: { toCall: number | null; toDoctor: number | null; withDoctor: number | null; total: number | null }; heat: { dow: number; hour: number; n: number }[]; byHour: { hour: string; n: number }[]; byWeekday: { dow: number; n: number }[]; byDoctor: { name: string; visits: number; toDoctor: number | null; withDoctor: number | null }[] }
export function OperationsReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const [doctorId, setDoctorId] = useState('');
  const q = useR<Ops>('operations', { ...range, doctorId: doctorId || undefined });
  const d = q.data;
  const hours = d ? [...new Set(d.heat.map((h) => h.hour))].sort((a, b) => a - b) : [];
  const max = d ? Math.max(1, ...d.heat.map((h) => h.n)) : 1;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('waiting-times', [{ header: t('common.doctor'), value: (x: Ops['byDoctor'][number]) => x.name }, { header: t('reports.visits'), value: (x) => x.visits }, { header: t('rx.toDoctor'), value: (x) => x.toDoctor ?? '' }, { header: t('rx.withDoctor'), value: (x) => x.withDoctor ?? '' }], d.byDoctor))}>
        <DoctorFilter value={doctorId} onChange={setDoctorId} />
      </Bar>
      <Wrap q={q}>{() => <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('rx.toCall')} value={mins(d!.avg.toCall, t)} tone="warning" />
          <StatCard label={t('rx.toDoctor')} value={mins(d!.avg.toDoctor, t)} tone="danger" />
          <StatCard label={t('rx.withDoctor')} value={mins(d!.avg.withDoctor, t)} tone="primary" />
          <StatCard label={t('rx.totalStay')} value={mins(d!.avg.total, t)} tone="violet" hint={`${t('reports.visits')}: ${d!.visits}`} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card><CardHeader title={t('rx.byHour')} />{d!.byHour.length ? <BarsChart data={d!.byHour} x="hour" series={[{ key: 'n', label: t('reports.visits') }]} /> : <EmptyState />}</Card>
          <Card><CardHeader title={t('rx.byWeekday')} /><ShareBars rows={d!.byWeekday.map((w) => ({ label: t(`rx.dow.${w.dow}`), value: w.n }))} format={String} /></Card>
        </div>
        {hours.length > 0 && <Card>
          <CardHeader title={t('rx.heat')} subtitle={t('rx.heatHint')} />
          <div className="overflow-x-auto"><table className="text-xs">
            <thead><tr><th className="p-1" />{hours.map((h) => <th key={h} className="p-1 font-normal text-ink-muted" dir="ltr">{h}</th>)}</tr></thead>
            <tbody>{[6, 0, 1, 2, 3, 4, 5].map((dw) => <tr key={dw}><td className="p-1 pe-2 font-semibold">{t(`rx.dow.${dw}`)}</td>{hours.map((h) => { const n = d!.heat.find((x) => x.dow === dw && x.hour === h)?.n ?? 0; return <td key={h} className="p-0.5"><div title={`${n}`} className={clsx('flex h-7 w-9 items-center justify-center rounded', n ? 'text-white' : 'bg-surface-subtle text-ink-muted')} style={n ? { background: `rgba(35,137,194,${0.2 + 0.8 * (n / max)})` } : undefined}>{n || ''}</div></td>; })}</tr>)}</tbody>
          </table></div>
        </Card>}
        <Card>
          <CardHeader title={t('rx.waitByDoctor')} />
          <DataTable rows={d!.byDoctor} rowKey={(x) => x.name} dense empty={<EmptyState />} columns={[
            { key: 'n', header: t('common.doctor'), cell: (x) => <b>{x.name}</b> }, { key: 'v', header: t('reports.visits'), cell: (x) => x.visits },
            { key: 'w', header: t('rx.toDoctor'), cell: (x) => mins(x.toDoctor, t) }, { key: 'd', header: t('rx.withDoctor'), cell: (x) => mins(x.withDoctor, t) },
          ]} />
        </Card>
      </>}</Wrap>
    </div>
  );
}

// ── Lab activity ──
interface Lab { orders: number; tests: number; byStatus: Record<string, number>; critical: number; urgent: number; turnaroundHours: { avg: number; median: number; max: number } | null; topTests: { name: string; count: number; abnormal: number }[]; byDoctor: { name: string; orders: number; tests: number }[] }
export function LabReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const [doctorId, setDoctorId] = useState('');
  const q = useR<Lab>('lab', { ...range, doctorId: doctorId || undefined });
  const d = q.data;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('lab-tests', [{ header: t('rx.test'), value: (x: Lab['topTests'][number]) => x.name }, { header: t('rx.count'), value: (x) => x.count }, { header: t('rx.abnormal'), value: (x) => x.abnormal }], d.topTests))}>
        <DoctorFilter value={doctorId} onChange={setDoctorId} />
      </Bar>
      <Wrap q={q}>{() => <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label={t('rx.labOrders')} value={d!.orders} hint={`${t('rx.tests')}: ${d!.tests}`} />
          <StatCard label={t('rx.pending')} value={(d!.byStatus.REQUESTED ?? 0) + (d!.byStatus.SAMPLE_COLLECTED ?? 0) + (d!.byStatus.PROCESSING ?? 0)} tone="warning" />
          <StatCard label={t('rx.tat')} value={d!.turnaroundHours ? `${d!.turnaroundHours.avg} ${t('rx.hours')}` : '—'} hint={d!.turnaroundHours ? `${t('rx.median')}: ${d!.turnaroundHours.median} · ${t('rx.max')}: ${d!.turnaroundHours.max}` : undefined} tone="primary" />
          <StatCard label={t('rx.urgent')} value={d!.urgent} tone="violet" />
          <StatCard label={t('rx.critical')} value={d!.critical} tone={d!.critical ? 'danger' : 'neutral'} />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title={t('rx.topTests')} />
            <DataTable rows={d!.topTests} rowKey={(x) => x.name} dense empty={<EmptyState />} columns={[
              { key: 'n', header: t('rx.test'), cell: (x) => <b dir="auto">{x.name}</b> }, { key: 'c', header: t('rx.count'), cell: (x) => x.count },
              { key: 'a', header: t('rx.abnormal'), cell: (x) => <span className={x.abnormal ? 'text-warning-700' : ''}>{x.abnormal} {x.count ? `(${Math.round((x.abnormal / x.count) * 100)}%)` : ''}</span> },
            ]} />
          </Card>
          <Card>
            <CardHeader title={t('rx.byStatus')} />
            <ShareBars rows={Object.entries(d!.byStatus).map(([k, v]) => ({ label: t(`enum.LabOrderStatus.${k}`), value: v }))} format={String} />
            <CardHeader className="mt-4" title={t('rx.labByDoctor')} />
            <ShareBars rows={d!.byDoctor.map((x) => ({ label: x.name, value: x.tests }))} format={String} />
          </Card>
        </div>
      </>}</Wrap>
    </div>
  );
}

// ── Expenses ──
interface Exp { rows: { id: string; date: string; category: string; description: string; amount: number; method: string; supplier: string | null; reference: string | null; by: string }[]; total: number; byCategory: { label: string; value: number }[]; byMethod: { label: string; value: number }[]; byMonth: { month: string; amount: number }[] }
export function ExpensesReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const cats = useCatalog('expense-categories');
  const [categoryId, setCategoryId] = useState('');
  const q = useR<Exp>('expenses', { ...range, categoryId: categoryId || undefined });
  const d = q.data;
  return (
    <div className="space-y-4">
      <Bar onExport={d && (() => exportCsv('expenses-report', [
        { header: t('common.date'), value: (x: Exp['rows'][number]) => x.date }, { header: t('rx.category'), value: (x) => x.category }, { header: t('rx.description'), value: (x) => x.description },
        { header: t('common.amount'), value: (x) => x.amount }, { header: t('rx.method'), value: (x) => x.method }, { header: t('rx.supplier'), value: (x) => x.supplier ?? '' }, { header: t('rx.reference'), value: (x) => x.reference ?? '' }, { header: t('rx.employee'), value: (x) => x.by },
      ], d.rows))}>
        <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="!h-9 w-48"><option value="">{t('rx.category')}: {t('common.all')}</option>{(cats.data ?? []).map((c: { id: string; name: string }) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      </Bar>
      <Wrap q={q}>{() => <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard label={t('rx.totalExpenses')} value={money(d!.total)} tone="warning" hint={`${d!.rows.length} ${t('rx.ops')}`} />
          <StatCard label={t('rx.biggestCategory')} value={d!.byCategory[0]?.label ?? '—'} hint={d!.byCategory[0] ? money(d!.byCategory[0].value) : undefined} tone="violet" />
          <StatCard label={t('rx.monthlyAvg')} value={money(d!.byMonth.length ? d!.total / d!.byMonth.length : 0)} tone="neutral" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card><CardHeader title={t('rx.byCategory')} /><ShareBars rows={d!.byCategory} format={(v) => money(v)} /></Card>
          <Card><CardHeader title={t('rx.byMethod')} /><ShareBars rows={d!.byMethod} format={(v) => money(v)} /></Card>
          <Card><CardHeader title={t('rx.byMonth')} />{d!.byMonth.length ? <BarsChart data={d!.byMonth} x="month" series={[{ key: 'amount', label: t('common.amount') }]} format={(v) => money(v, false)} /> : <EmptyState />}</Card>
        </div>
        <Card>
          <DataTable rows={d!.rows} rowKey={(x) => x.id} dense empty={<EmptyState />} columns={[
            { key: 'd', header: t('common.date'), cell: (x) => x.date }, { key: 'c', header: t('rx.category'), cell: (x) => x.category },
            { key: 's', header: t('rx.description'), cell: (x) => <>{x.description}{x.supplier && <span className="block text-xs text-ink-muted">{x.supplier}</span>}</> },
            { key: 'm', header: t('rx.method'), hideOnMobile: true, cell: (x) => x.method }, { key: 'a', header: t('common.amount'), cell: (x) => <b>{money(x.amount)}</b> },
            { key: 'b', header: t('rx.employee'), hideOnMobile: true, cell: (x) => <span className="text-xs">{x.by}</span> },
          ]} />
        </Card>
      </>}</Wrap>
    </div>
  );
}
