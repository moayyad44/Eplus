import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarClock, ClipboardList, FileClock, FlaskConical, PackageX, TrendingDown, TrendingUp, UserPlus, Users, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtTime, money, qty } from '@/lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, PageLoader, StatCard } from '@/components/ui';
import { BarsChart, ShareBars } from '@/components/shared/charts';
import type { FinanceSummary } from '../billing/Cashier';

interface Dash {
  patientsToday: number; newPatientsToday: number; visitsToday: number; waiting: number; completedToday: number; statusCounts: Record<string, number>;
  finance: FinanceSummary; pendingLabs: number; expiringCount: number;
  upcomingAppointments: { id: string; startAt: string; patient: { fullName: string }; doctor: { fullName: string } }[];
  lowStock: { id: string; name: string; quantity: number; minQuantity: number }[];
  doctorsOnShift: { id: string; fullName: string; specialty: string | null; startTime: string; endTime: string; checkedIn: boolean }[];
  visitsByDoctor: { doctorId: string | null; name: string; count: number }[];
  series: { day: string; visits: number; revenue: number; expenses: number }[];
}

export default function Dashboard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dash>('/dashboard/admin'), refetchInterval: 60_000 });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoader />;
  const d = q.data;
  const f = d.finance;
  return (
    <div>
      <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.subtitle')} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('dashboard.patientsToday')} value={d.patientsToday} hint={`${t('dashboard.newPatients')}: ${d.newPatientsToday}`} icon={<Users className="h-5 w-5" />} onClick={() => nav('/queue')} />
        <StatCard label={t('dashboard.waiting')} value={d.waiting} hint={`${t('dashboard.visitsToday')}: ${d.visitsToday} · ${t('dashboard.completed')}: ${d.completedToday}`} tone="warning" icon={<ClipboardList className="h-5 w-5" />} onClick={() => nav('/queue')} />
        <StatCard label={t('dashboard.revenueToday')} value={money(f.netReceipts)} hint={`${t('billing.grossSales')}: ${money(f.netSales)}`} tone="success" icon={<Wallet className="h-5 w-5" />} onClick={() => nav('/billing/cashier')} />
        <StatCard label={t('dashboard.netToday')} value={money(f.netIncome)} hint={`${t('dashboard.expensesToday')}: ${money(f.expenses)}`} tone={f.netIncome >= 0 ? 'primary' : 'danger'} icon={f.netIncome >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />} />
        <StatCard label={t('dashboard.outstanding')} value={money(f.outstandingTotal)} hint={`${f.outstandingCount}`} tone="danger" icon={<FileClock className="h-5 w-5" />} onClick={() => nav('/billing/outstanding')} />
        <StatCard label={t('dashboard.pendingLabs')} value={d.pendingLabs} tone="violet" icon={<FlaskConical className="h-5 w-5" />} onClick={() => nav('/lab')} />
        <StatCard label={t('dashboard.lowStock')} value={d.lowStock.length} tone={d.lowStock.length ? 'danger' : 'neutral'} icon={<PackageX className="h-5 w-5" />} onClick={() => nav('/inventory/items')} />
        <StatCard label={t('dashboard.expiring')} value={d.expiringCount} tone={d.expiringCount ? 'warning' : 'neutral'} icon={<AlertTriangle className="h-5 w-5" />} onClick={() => nav('/inventory/items')} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={t('dashboard.revenue14')} />
          <BarsChart data={d.series} x="day" series={[{ key: 'revenue', label: t('billing.collected') }, { key: 'expenses', label: t('billing.expenses') }]} format={(v) => money(v, false)} xFormat={(s) => s.slice(5)} />
        </Card>
        <Card>
          <CardHeader title={t('dashboard.byMethod')} />
          {f.byMethod.length ? <ShareBars rows={f.byMethod.map((m) => ({ label: m.name, value: m.collected - m.refunded }))} format={(v) => money(v)} /> : <EmptyState />}
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader title={t('dashboard.visits14')} />
          <BarsChart data={d.series} x="day" series={[{ key: 'visits', label: t('dashboard.visitsToday') }]} xFormat={(s) => s.slice(5)} height={200} />
        </Card>
        <Card>
          <CardHeader title={t('dashboard.doctorsOnShift')} />
          {d.doctorsOnShift.length ? (
            <ul className="space-y-2">
              {d.doctorsOnShift.map((doc) => (
                <li key={doc.id + doc.startTime} className="flex items-center justify-between gap-2 text-sm">
                  <span><b>{doc.fullName}</b><span className="block text-xs text-ink-muted" dir="ltr">{doc.startTime} – {doc.endTime}</span></span>
                  <Badge tone={doc.checkedIn ? 'success' : 'neutral'}>{doc.checkedIn ? t('dashboard.checkedIn') : t('dashboard.notCheckedIn')}</Badge>
                </li>
              ))}
            </ul>
          ) : <EmptyState title={t('dashboard.noDoctors')} className="!py-4" />}
          {d.visitsByDoctor.length > 0 && (
            <>
              <p className="mb-2 mt-5 text-xs font-bold text-ink-muted">{t('dashboard.byDoctor')}</p>
              <ShareBars rows={d.visitsByDoctor.map((v) => ({ label: v.name, value: v.count }))} format={(v) => String(v)} />
            </>
          )}
        </Card>
        <Card>
          <CardHeader title={t('dashboard.queueStatus')} />
          <div className="grid grid-cols-2 gap-2">
            {['WAITING', 'CALLED', 'WITH_NURSE', 'WITH_DOCTOR', 'IN_LAB', 'WAITING_PAYMENT', 'COMPLETED', 'NO_SHOW'].map((s) => (
              <div key={s} className="rounded-xl bg-surface-subtle p-2.5"><p className="text-[11px] text-ink-muted">{t(`enum.VisitStatus.${s}`)}</p><p className="text-lg font-bold tabular-nums">{d.statusCounts[s] ?? 0}</p></div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title={t('dashboard.upcoming')} icon={<CalendarClock className="h-5 w-5" />} />
          {d.upcomingAppointments.length ? (
            <ul className="divide-y divide-line">
              {d.upcomingAppointments.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-14 font-bold tabular-nums text-primary-700" title={fmtDateTime(a.startAt)}>{fmtTime(a.startAt)}</span>
                  <span className="min-w-0 flex-1"><b className="block truncate">{a.patient.fullName}</b><span className="text-xs text-ink-muted">{a.doctor.fullName}</span></span>
                </li>
              ))}
            </ul>
          ) : <EmptyState className="!py-4" />}
        </Card>
        <Card>
          <CardHeader title={t('dashboard.lowStockList')} icon={<PackageX className="h-5 w-5" />} />
          {d.lowStock.length ? (
            <ul className="divide-y divide-line">
              {d.lowStock.map((i) => (
                <li key={i.id}>
                  <button onClick={() => nav(`/inventory/items/${i.id}`)} className="flex w-full items-center justify-between py-2 text-sm hover:text-primary-700">
                    <span className="font-semibold">{i.name}</span>
                    <span className="tabular-nums"><b className="text-danger-600">{qty(i.quantity)}</b> <span className="text-xs text-ink-muted">/ {qty(i.minQuantity)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <EmptyState title={t('dashboard.noLowStock')} className="!py-4" icon={<UserPlus className="h-6 w-6" />} />}
        </Card>
      </div>
    </div>
  );
}
