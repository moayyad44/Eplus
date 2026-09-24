import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { exportCsv } from '@/lib/export';
import { fmtDate, fmtDateTime, fmtDay, money, num, qty } from '@/lib/format';
import { Badge, Button, Card, CardHeader, DataTable, DateRangePicker, EmptyState, ErrorState, PageHeader, PageLoader, SearchInput, Select, StatCard, Tabs, presetRange, type Range } from '@/components/ui';
import { BarsChart, ShareBars } from '@/components/shared/charts';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { useDoctors } from '@/components/shared/VisitQueueForm';
import type { FinanceSummary } from '../billing/Cashier';

type Tab = 'patients' | 'doctors' | 'financial' | 'inventory' | 'attendance';

function useReport<T>(name: Tab, params: Record<string, string | undefined>, enabled: boolean) {
  return useQuery({ queryKey: ['report', name, params], queryFn: () => api.get<T>(`/reports/${name}`, params), enabled });
}

function Toolbar({ onExport, children }: { onExport?: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      {children}
      <div className="ms-auto flex gap-2">
        {onExport && <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={onExport}>{t('common.exportCsv')}</Button>}
        <Button variant="outline" size="sm" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()} title={t('reports.pdfHint')}>{t('common.print')} / {t('common.exportPdf')}</Button>
      </div>
    </div>
  );
}

export default function Reports() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const tabs = [
    { key: 'patients' as Tab, label: t('reports.tabs.patients'), hidden: !can('reports.patients') },
    { key: 'doctors' as Tab, label: t('reports.tabs.doctors'), hidden: !can('reports.doctors') },
    { key: 'financial' as Tab, label: t('reports.tabs.financial'), hidden: !can('reports.financial') },
    { key: 'inventory' as Tab, label: t('reports.tabs.inventory'), hidden: !can('reports.inventory') },
    { key: 'attendance' as Tab, label: t('reports.tabs.attendance'), hidden: !can('reports.attendance') },
  ];
  const [tab, setTab] = useState<Tab>(tabs.find((x) => !x.hidden)!.key);
  const [range, setRange] = useState<Range>(presetRange('month'));
  return (
    <div>
      <PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')} />
      <div className="mb-2 hidden print:block">
        <h1 className="text-xl font-bold">{me?.clinic.name} — {t(`reports.tabs.${tab}`)}</h1>
        <p className="text-sm">{t('common.from')} {range.from} {t('common.to')} {range.to} · {t('common.generatedAt')}: {fmtDateTime(new Date())} · {t('common.printedBy')}: {me?.user.fullName}</p>
      </div>
      <Tabs items={tabs} value={tab} onChange={setTab} className="mb-4" />
      <div className="mb-4"><DateRangePicker value={range} onChange={setRange} /></div>
      {tab === 'patients' && <PatientsReport range={range} />}
      {tab === 'doctors' && <DoctorsReport range={range} />}
      {tab === 'financial' && <FinancialReport range={range} />}
      {tab === 'inventory' && <InventoryReport range={range} />}
      {tab === 'attendance' && <AttendanceReport range={range} />}
    </div>
  );
}

function PatientsReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const doctors = useDoctors();
  const [doctorId, setDoctorId] = useState('');
  const [q, setQ] = useState('');
  const r = useReport<{
    summary: { visits: number; uniquePatients: number; newPatientsRegistered: number; newPatientsSeen: number; returningPatients: number };
    byDay: { day: string; count: number }[]; byGender: Record<string, number>; ageGroups: Record<string, number>; byVisitType: { name: string; count: number }[];
    topDiagnoses: { description: string; icd10Code: string | null; count: number }[];
    rows: { id: string; visitNumber: string; arrivedAt: string; status: string; isNew: boolean; patient: { fullName: string; phone: string; fileNumber: string; gender: string }; doctor: { fullName: string } | null; visitType: { name: string } | null }[];
    truncated: boolean;
  }>('patients', { ...range, doctorId: doctorId || undefined, q: q || undefined }, true);
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  return (
    <div className="space-y-4">
      <Toolbar onExport={d && (() => exportCsv('patients-report', [
        { header: t('common.date'), value: (x: (typeof d.rows)[number]) => fmtDateTime(x.arrivedAt) }, { header: t('patients.fileNumber'), value: (x) => x.patient.fileNumber },
        { header: t('common.patient'), value: (x) => x.patient.fullName }, { header: t('common.phone'), value: (x) => x.patient.phone }, { header: t('common.doctor'), value: (x) => x.doctor?.fullName ?? '' },
        { header: t('common.type'), value: (x) => x.visitType?.name ?? '' }, { header: t('reports.isNew'), value: (x) => (x.isNew ? t('common.yes') : t('common.no')) }, { header: t('common.status'), value: (x) => t(`enum.VisitStatus.${x.status}`) },
      ], d.rows))}>
        <SearchInput value={q} onChange={setQ} placeholder={t('common.searchPlaceholder')} className="w-56" />
        <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="!h-9 w-44"><option value="">{t('common.doctor')}: {t('common.all')}</option>{doctors.data?.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</Select>
      </Toolbar>
      {!d ? <PageLoader /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label={t('reports.visits')} value={d.summary.visits} />
            <StatCard label={t('reports.uniquePatients')} value={d.summary.uniquePatients} tone="violet" />
            <StatCard label={t('reports.newPatients')} value={d.summary.newPatientsSeen} tone="success" />
            <StatCard label={t('reports.returning')} value={d.summary.returningPatients} tone="warning" />
            <StatCard label={t('reports.registered')} value={d.summary.newPatientsRegistered} tone="neutral" />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2"><CardHeader title={t('reports.byDay')} />{d.byDay.length ? <BarsChart data={d.byDay} x="day" series={[{ key: 'count', label: t('reports.visits') }]} xFormat={(s) => s.slice(5)} /> : <EmptyState />}</Card>
            <Card>
              <CardHeader title={t('reports.byGender')} />
              <ShareBars rows={Object.entries(d.byGender).map(([k, v]) => ({ label: t(`enum.Gender.${k}`), value: v }))} format={String} />
              <p className="mb-2 mt-5 text-xs font-bold text-ink-muted">{t('reports.byAge')}</p>
              <ShareBars rows={Object.entries(d.ageGroups).map(([k, v]) => ({ label: k, value: v }))} format={String} />
            </Card>
            <Card><CardHeader title={t('reports.byType')} /><ShareBars rows={d.byVisitType.map((x) => ({ label: x.name, value: x.count }))} format={String} /></Card>
            <Card className="lg:col-span-2">
              <CardHeader title={t('reports.topDx')} />
              <DataTable rows={d.topDiagnoses} rowKey={(x) => x.description} dense columns={[
                { key: 'c', header: 'ICD-10', cell: (x) => <span className="font-mono text-xs" dir="ltr">{x.icd10Code ?? '—'}</span> },
                { key: 'd', header: t('visit.diagnosisText'), cell: (x) => x.description },
                { key: 'n', header: t('reports.count'), cell: (x) => <b>{x.count}</b> },
              ]} />
            </Card>
          </div>
          <Card>
            {d.truncated && <p className="mb-2 text-xs text-warning-700">{t('reports.truncated')}</p>}
            <DataTable rows={d.rows} rowKey={(x) => x.id} dense columns={[
              { key: 'd', header: t('common.date'), cell: (x) => <span className="text-xs tabular-nums">{fmtDateTime(x.arrivedAt)}</span> },
              { key: 'p', header: t('common.patient'), cell: (x) => <><b>{x.patient.fullName}</b> {x.isNew && <Badge tone="success" dot={false}>{t('reports.isNew')}</Badge>}</> },
              { key: 'ph', header: t('common.phone'), cell: (x) => <span dir="ltr">{x.patient.phone}</span> },
              { key: 'doc', header: t('common.doctor'), cell: (x) => x.doctor?.fullName ?? '—' },
              { key: 't', header: t('common.type'), cell: (x) => x.visitType?.name ?? '—' },
              { key: 's', header: t('common.status'), cell: (x) => <StatusBadge enumName="VisitStatus" value={x.status} /> },
            ]} />
          </Card>
        </>
      )}
    </div>
  );
}

function DoctorsReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const r = useReport<{ rows: { doctorId: string; fullName: string; specialty: string | null; visits: number; patients: number; completed: number; avgMinutes: number | null; invoices: number; revenue: number; collected: number; outstanding: number }[] }>('doctors', { ...range }, true);
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const rows = r.data?.rows;
  return (
    <div className="space-y-4">
      <Toolbar onExport={rows && (() => exportCsv('doctors-report', [
        { header: t('common.doctor'), value: (x: NonNullable<typeof rows>[number]) => x.fullName }, { header: t('reports.visits'), value: (x) => x.visits }, { header: t('reports.patients'), value: (x) => x.patients },
        { header: t('reports.completed'), value: (x) => x.completed }, { header: t('reports.avgMinutes'), value: (x) => x.avgMinutes ?? '' }, { header: t('reports.invoices'), value: (x) => x.invoices },
        { header: t('reports.revenue'), value: (x) => x.revenue }, { header: t('reports.collected'), value: (x) => x.collected }, { header: t('reports.outstanding'), value: (x) => x.outstanding },
      ], rows))} />
      {!rows ? <PageLoader /> : (
        <>
          <Card><CardHeader title={t('reports.revenue')} /><BarsChart data={rows} x="fullName" series={[{ key: 'revenue', label: t('reports.revenue') }, { key: 'collected', label: t('reports.collected') }]} format={(v) => money(v, false)} /></Card>
          <Card>
            <DataTable rows={rows} rowKey={(x) => x.doctorId} columns={[
              { key: 'n', header: t('common.doctor'), cell: (x) => <><b>{x.fullName}</b><span className="block text-xs text-ink-muted">{x.specialty}</span></> },
              { key: 'v', header: t('reports.visits'), cell: (x) => x.visits },
              { key: 'p', header: t('reports.patients'), cell: (x) => x.patients },
              { key: 'c', header: t('reports.completed'), hideOnMobile: true, cell: (x) => x.completed },
              { key: 'a', header: t('reports.avgMinutes'), hideOnMobile: true, cell: (x) => x.avgMinutes ?? '—' },
              { key: 'r', header: t('reports.revenue'), cell: (x) => <b>{money(x.revenue)}</b> },
              { key: 'co', header: t('reports.collected'), cell: (x) => money(x.collected) },
              { key: 'o', header: t('reports.outstanding'), cell: (x) => <span className={x.outstanding > 0 ? 'text-danger-600' : ''}>{money(x.outstanding)}</span> },
            ]} />
          </Card>
        </>
      )}
    </div>
  );
}

function FinancialReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const r = useReport<{
    summary: FinanceSummary; revenueByCategory: { category: string; amount: number; quantity: number }[]; expensesByCategory: { name: string; amount: number; count: number }[];
    invoices: { id: string; invoiceNumber: string; issuedAt: string; status: string; subtotal: number; discountTotal: number; total: number; paidAmount: number; refundedAmount: number; balance: number; patient: { fullName: string }; doctor: { fullName: string } | null }[];
    discounts: { id: string; invoiceNumber: string; issuedAt: string; discountTotal: number; subtotal: number; patient: { fullName: string } }[];
  }>('financial', { ...range }, true);
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  return (
    <div className="space-y-4">
      <Toolbar onExport={d && (() => exportCsv('financial-report', [
        { header: t('billing.invoiceNumber'), value: (x: (typeof d.invoices)[number]) => x.invoiceNumber }, { header: t('common.date'), value: (x) => fmtDate(x.issuedAt) },
        { header: t('common.patient'), value: (x) => x.patient.fullName }, { header: t('common.doctor'), value: (x) => x.doctor?.fullName ?? '' }, { header: t('common.subtotal'), value: (x) => num(x.subtotal) },
        { header: t('common.discount'), value: (x) => num(x.discountTotal) }, { header: t('common.total'), value: (x) => num(x.total) }, { header: t('common.paid'), value: (x) => num(x.paidAmount) },
        { header: t('billing.refunded'), value: (x) => num(x.refundedAmount) }, { header: t('common.balance'), value: (x) => num(x.balance) }, { header: t('common.status'), value: (x) => t(`enum.InvoiceStatus.${x.status}`) },
      ], d.invoices))} />
      {!d ? <PageLoader /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('billing.grossSales')} value={money(d.summary.grossSales)} hint={`${t('billing.invoiceCount')}: ${d.summary.invoiceCount}`} />
            <StatCard label={t('billing.discounts')} value={money(d.summary.discounts)} tone="warning" />
            <StatCard label={t('billing.netSales')} value={money(d.summary.netSales)} tone="violet" />
            <StatCard label={t('billing.collected')} value={money(d.summary.collected)} tone="success" />
            <StatCard label={t('billing.refunds')} value={money(d.summary.refunded)} tone="neutral" />
            <StatCard label={t('billing.unpaid')} value={money(d.summary.unpaidFromPeriod)} tone="danger" />
            <StatCard label={t('billing.expenses')} value={money(d.summary.expenses)} tone="warning" />
            <StatCard label={t('billing.netIncome')} value={money(d.summary.netIncome)} tone={d.summary.netIncome >= 0 ? 'success' : 'danger'} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card><CardHeader title={t('billing.byMethod')} /><ShareBars rows={d.summary.byMethod.map((m) => ({ label: m.name, value: m.collected - m.refunded }))} format={(v) => money(v)} /></Card>
            <Card><CardHeader title={t('reports.revenueByCategory')} /><ShareBars rows={d.revenueByCategory.map((c) => ({ label: t(`enum.ServiceCategory.${c.category}`), value: c.amount }))} format={(v) => money(v)} /></Card>
            <Card><CardHeader title={t('reports.expensesByCategory')} /><ShareBars rows={d.expensesByCategory.map((c) => ({ label: c.name, value: c.amount }))} format={(v) => money(v)} /></Card>
          </div>
          <Card>
            <CardHeader title={t('reports.invoicesList')} />
            <DataTable rows={d.invoices} rowKey={(x) => x.id} dense columns={[
              { key: 'n', header: t('billing.invoiceNumber'), cell: (x) => <span className="font-mono text-xs">{x.invoiceNumber}</span> },
              { key: 'd', header: t('common.date'), cell: (x) => fmtDate(x.issuedAt) },
              { key: 'p', header: t('common.patient'), cell: (x) => x.patient.fullName },
              { key: 'doc', header: t('common.doctor'), hideOnMobile: true, cell: (x) => x.doctor?.fullName ?? '—' },
              { key: 't', header: t('common.total'), cell: (x) => money(x.total) },
              { key: 'pa', header: t('common.paid'), cell: (x) => money(x.paidAmount) },
              { key: 'b', header: t('common.balance'), cell: (x) => money(x.balance) },
              { key: 's', header: t('common.status'), cell: (x) => <StatusBadge enumName="InvoiceStatus" value={x.status} /> },
            ]} />
          </Card>
          {d.discounts.length > 0 && (
            <Card>
              <CardHeader title={t('reports.discountsList')} />
              <DataTable rows={d.discounts} rowKey={(x) => x.id} dense columns={[
                { key: 'n', header: t('billing.invoiceNumber'), cell: (x) => <span className="font-mono text-xs">{x.invoiceNumber}</span> },
                { key: 'd', header: t('common.date'), cell: (x) => fmtDate(x.issuedAt) },
                { key: 'p', header: t('common.patient'), cell: (x) => x.patient.fullName },
                { key: 's', header: t('common.subtotal'), cell: (x) => money(x.subtotal) },
                { key: 'di', header: t('common.discount'), cell: (x) => <b className="text-warning-700">{money(x.discountTotal)}</b> },
              ]} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function InventoryReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const r = useReport<{
    summary: { items: number; stockValue: number; low: number; expired: number; expiring: number };
    rows: { id: string; name: string; sku: string; quantity: number; minQuantity: number; purchasePrice: number; value: number; expiryDate: string | null; batchNumber: string | null; isLow: boolean; isExpired: boolean; isExpiring: boolean; category: { name: string } | null; unit: { symbol: string | null } | null; supplier: { name: string } | null }[];
    movements: { type: string; count: number; quantity: number }[];
    stockCounts: { id: string; countNumber: string; status: string; createdAt: string; differences: { name: string; system: number; counted: number; difference: number; value: number }[] }[];
  }>('inventory', { ...range, q: q || undefined }, true);
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const rows = d?.rows.filter((x) => (filter === 'low' ? x.isLow : filter === 'expired' ? x.isExpired : filter === 'expiring' ? x.isExpiring : true));
  return (
    <div className="space-y-4">
      <Toolbar onExport={rows && (() => exportCsv('inventory-report', [
        { header: t('inventory.sku'), value: (x: NonNullable<typeof rows>[number]) => x.sku }, { header: t('inventory.name'), value: (x) => x.name }, { header: t('inventory.category'), value: (x) => x.category?.name ?? '' },
        { header: t('inventory.quantity'), value: (x) => num(x.quantity) }, { header: t('inventory.minQuantity'), value: (x) => num(x.minQuantity) }, { header: t('inventory.purchasePrice'), value: (x) => num(x.purchasePrice) },
        { header: t('reports.stockValue'), value: (x) => x.value.toFixed(3) }, { header: t('inventory.expiryDate'), value: (x) => fmtDay(x.expiryDate) }, { header: t('inventory.batch'), value: (x) => x.batchNumber ?? '' },
      ], rows))}>
        <SearchInput value={q} onChange={setQ} placeholder={t('common.searchPlaceholder')} className="w-56" />
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="!h-9 w-40">
          <option value="">{t('common.all')}</option><option value="low">{t('reports.low')}</option><option value="expiring">{t('reports.expiring')}</option><option value="expired">{t('reports.expired')}</option>
        </Select>
      </Toolbar>
      {!d ? <PageLoader /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label={t('reports.items')} value={d.summary.items} />
            <StatCard label={t('reports.stockValue')} value={money(d.summary.stockValue)} tone="violet" />
            <StatCard label={t('reports.low')} value={d.summary.low} tone="danger" />
            <StatCard label={t('reports.expiring')} value={d.summary.expiring} tone="warning" />
            <StatCard label={t('reports.expired')} value={d.summary.expired} tone="danger" />
          </div>
          <Card>
            <CardHeader title={t('reports.currentStock')} />
            <DataTable rows={rows} rowKey={(x) => x.id} dense columns={[
              { key: 's', header: t('inventory.sku'), cell: (x) => <span className="font-mono text-xs">{x.sku}</span> },
              { key: 'n', header: t('inventory.name'), cell: (x) => <b>{x.name}</b> },
              { key: 'q', header: t('inventory.quantity'), cell: (x) => <span className={x.isLow ? 'font-bold text-danger-600' : ''}>{qty(x.quantity)} {x.unit?.symbol}</span> },
              { key: 'm', header: t('inventory.minQuantity'), cell: (x) => qty(x.minQuantity) },
              { key: 'v', header: t('reports.stockValue'), cell: (x) => money(x.value) },
              { key: 'e', header: t('inventory.expiryDate'), cell: (x) => <span className={x.isExpired ? 'font-bold text-danger-600' : x.isExpiring ? 'text-warning-700' : ''}>{fmtDay(x.expiryDate)}</span> },
            ]} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title={t('reports.movementsSummary')} />
              <DataTable rows={d.movements} rowKey={(x) => x.type} dense columns={[
                { key: 't', header: t('inventory.movementType'), cell: (x) => <StatusBadge enumName="InventoryTxnType" value={x.type} /> },
                { key: 'c', header: t('reports.count'), cell: (x) => x.count },
                { key: 'q', header: t('inventory.movementQty'), cell: (x) => <span dir="ltr">{qty(x.quantity)}</span> },
              ]} />
            </Card>
            <Card>
              <CardHeader title={t('reports.stockCounts')} />
              {!d.stockCounts.length ? <EmptyState className="!py-4" /> : d.stockCounts.map((sc) => (
                <div key={sc.id} className="mb-3">
                  <p className="mb-1 text-sm font-bold">{sc.countNumber} <StatusBadge enumName="StockCountStatus" value={sc.status} /> <span className="text-xs font-normal text-ink-muted">{fmtDate(sc.createdAt)}</span></p>
                  <ul className="text-xs">{sc.differences.map((x) => <li key={x.name}>{x.name}: {qty(x.system)} → {qty(x.counted)} (<b className={x.difference < 0 ? 'text-danger-600' : 'text-success-700'} dir="ltr">{x.difference > 0 ? '+' : ''}{qty(x.difference)}</b>, {money(x.value)})</li>)}</ul>
                </div>
              ))}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function AttendanceReport({ range }: { range: Range }) {
  const { t } = useTranslation();
  const r = useReport<{ rows: { userId: string; fullName: string; staffType: string; scheduled: number; present: number; late: number; lateMinutes: number; earlyLeave: number; earlyLeaveMinutes: number; absent: number; leaveDays: number; workedHours: number }[] }>('attendance', { ...range }, true);
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const rows = r.data?.rows;
  return (
    <div className="space-y-4">
      <Toolbar onExport={rows && (() => exportCsv('attendance-report', [
        { header: t('staff.employee'), value: (x: NonNullable<typeof rows>[number]) => x.fullName }, { header: t('reports.scheduled'), value: (x) => x.scheduled }, { header: t('reports.present'), value: (x) => x.present },
        { header: t('reports.lateTimes'), value: (x) => x.late }, { header: t('reports.lateMinutes'), value: (x) => x.lateMinutes }, { header: t('reports.earlyTimes'), value: (x) => x.earlyLeave },
        { header: t('reports.earlyMinutes'), value: (x) => x.earlyLeaveMinutes }, { header: t('reports.absent'), value: (x) => x.absent }, { header: t('reports.leaveDays'), value: (x) => x.leaveDays }, { header: t('reports.workedHours'), value: (x) => x.workedHours },
      ], rows))} />
      {!rows ? <PageLoader /> : (
        <Card>
          <DataTable rows={rows} rowKey={(x) => x.userId} columns={[
            { key: 'n', header: t('staff.employee'), cell: (x) => <><b>{x.fullName}</b><span className="block text-xs text-ink-muted">{t(`enum.StaffType.${x.staffType}`)}</span></> },
            { key: 's', header: t('reports.scheduled'), cell: (x) => x.scheduled },
            { key: 'p', header: t('reports.present'), cell: (x) => x.present },
            { key: 'l', header: t('reports.lateTimes'), cell: (x) => <span className={x.late ? 'text-warning-700' : ''}>{x.late} ({x.lateMinutes} {t('common.minutes')})</span> },
            { key: 'e', header: t('reports.earlyTimes'), cell: (x) => `${x.earlyLeave} (${x.earlyLeaveMinutes} ${t('common.minutes')})` },
            { key: 'a', header: t('reports.absent'), cell: (x) => <span className={x.absent ? 'font-bold text-danger-600' : ''}>{x.absent}</span> },
            { key: 'lv', header: t('reports.leaveDays'), cell: (x) => x.leaveDays },
            { key: 'w', header: t('reports.workedHours'), cell: (x) => x.workedHours },
          ]} />
        </Card>
      )}
    </div>
  );
}
