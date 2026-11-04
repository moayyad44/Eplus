import { Suspense, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ArrowRight, BookOpen, CalendarRange, Calculator, FileSpreadsheet, LayoutDashboard, ListTree, Menu, Scale, Settings, X, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { EmptyState, PageLoader } from '@/components/ui';

/** Separate workspace of EmergencyPlus Accounting (same sign-in as EmergencyPlus). */
const NAV: { label: string; items: { to: string; label: string; icon: LucideIcon; any: string[] }[] }[] = [
  { label: 'acc.nav.main', items: [{ to: '/accounting', label: 'acc.nav.dashboard', icon: LayoutDashboard, any: ['accounting.access'] }] },
  {
    label: 'acc.nav.books',
    items: [
      { to: '/accounting/journal', label: 'acc.nav.journal', icon: BookOpen, any: ['accounting.journal.view'] },
      { to: '/accounting/accounts', label: 'acc.nav.accounts', icon: ListTree, any: ['accounting.accounts.view', 'accounting.journal.view'] },
      { to: '/accounting/statement', label: 'acc.nav.statement', icon: FileSpreadsheet, any: ['accounting.reports.view', 'accounting.journal.view'] },
    ],
  },
  {
    label: 'acc.nav.reports',
    items: [
      { to: '/accounting/trial-balance', label: 'acc.nav.trialBalance', icon: Scale, any: ['accounting.reports.view'] },
      { to: '/accounting/income-statement', label: 'acc.nav.income', icon: Calculator, any: ['accounting.reports.view'] },
      { to: '/accounting/balance-sheet', label: 'acc.nav.balanceSheet', icon: Scale, any: ['accounting.reports.view'] },
    ],
  },
  {
    label: 'acc.nav.setup',
    items: [
      { to: '/accounting/periods', label: 'acc.nav.periods', icon: CalendarRange, any: ['accounting.access'] },
      { to: '/accounting/settings', label: 'acc.nav.settings', icon: Settings, any: ['accounting.settings'] },
    ],
  },
];

export default function AccountingLayout() {
  const { t } = useTranslation();
  const { me, loading, canAny, can } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => { document.title = t('acc.brand'); }, [t]);
  useEffect(() => setOpen(false), [loc.pathname]);
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (!can('accounting.access')) return <div className="p-10"><EmptyState title={t('common.permissionDenied')} /></div>;
  const sections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => canAny(...i.any)) })).filter((s) => s.items.length);
  return (
    <div className="flex min-h-screen bg-surface-subtle">
      <div className={clsx('fixed inset-0 z-30 bg-ink/30 lg:hidden', open ? 'block' : 'hidden')} onClick={() => setOpen(false)} />
      <aside className={clsx('fixed inset-y-0 start-0 z-40 w-64 flex-col border-e border-line bg-white print:hidden lg:sticky lg:top-0 lg:flex lg:h-screen', open ? 'flex' : 'hidden')}>
        <div className="flex h-16 items-center justify-between gap-2 border-b border-line bg-primary-50 px-4">
          <div className="leading-tight">
            <p className="text-sm font-extrabold text-primary-800" dir="ltr">EmergencyPlus</p>
            <p className="text-xs font-semibold text-primary-600" dir="ltr">Accounting</p>
          </div>
          <button className="rounded-lg p-1.5 text-ink-muted lg:hidden" onClick={() => setOpen(false)} aria-label={t('common.close')}><X className="h-5 w-5" /></button>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {sections.map((s) => (
            <div key={s.label}>
              <p className="mb-1.5 px-3 text-[11px] font-bold text-ink-muted/80">{t(s.label)}</p>
              <ul className="space-y-0.5">
                {s.items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to} end={i.to === '/accounting'} className={({ isActive }) => clsx('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium', isActive ? 'bg-primary-50 font-semibold text-primary-800 ring-1 ring-inset ring-primary-100' : 'text-ink-soft hover:bg-surface-subtle')}>
                      <i.icon className="h-[18px] w-[18px] text-primary-500" />{t(i.label)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <Link to="/" className="flex items-center gap-2 border-t border-line px-5 py-3 text-sm font-semibold text-primary-700 hover:bg-primary-50"><ArrowRight className="h-4 w-4 ltr:rotate-180" />{t('acc.backToClinic')}</Link>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-white/95 px-3 backdrop-blur print:hidden sm:px-6">
          <button className="rounded-lg p-2 text-ink-muted hover:bg-surface-sunken lg:hidden" onClick={() => setOpen(true)} aria-label="menu"><Menu className="h-5 w-5" /></button>
          <span className="font-bold text-primary-800">{t('acc.brand')}</span>
          <span className="ms-auto truncate text-sm text-ink-muted">{me.user.fullName}</span>
        </header>
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-5 sm:px-6 sm:py-6">
          <Suspense fallback={<PageLoader />}><Outlet /></Suspense>
        </main>
      </div>
    </div>
  );
}
