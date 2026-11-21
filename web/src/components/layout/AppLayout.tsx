import { Suspense, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LifeBuoy, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PageLoader } from '@/components/ui';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** One-time hint (per user, per browser) that the user guide exists. */
function WelcomeHint({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const key = `ep.helpHint.${userId}`;
  const [show, setShow] = useState(() => {
    try { return !localStorage.getItem(key); } catch { return false; }
  });
  if (!show) return null;
  const close = () => { try { localStorage.setItem(key, '1'); } catch { /* storage unavailable */ } setShow(false); };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900 print:hidden">
      <LifeBuoy className="h-5 w-5 shrink-0 text-primary-600" />
      <span className="min-w-0 flex-1">{t('help.welcome')}</span>
      <Link to="/help" onClick={close} className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700">{t('help.openGuide')}</Link>
      <button onClick={close} className="rounded-lg p-1 text-primary-700 hover:bg-primary-100" aria-label={t('help.dismiss')}><X className="h-4 w-4" /></button>
    </div>
  );
}

export function AppLayout() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (me.user.mustChangePassword && loc.pathname !== '/account') return <Navigate to="/account?force=1" replace />;
  return (
    <div className="flex min-h-screen bg-surface-subtle">
      <Sidebar open={menu} onClose={() => setMenu(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setMenu(true)} />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-5 sm:px-6 sm:py-6">
          {loc.pathname !== '/help' && !me.user.mustChangePassword && <WelcomeHint userId={me.user.id} />}
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
