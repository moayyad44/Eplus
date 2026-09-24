import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, ChevronDown, Globe, KeyRound, LogIn, LogOut, Menu, Search, UserRound } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtTime } from '@/lib/format';
import { LANGS } from '@/i18n';
import { GlobalSearch } from './GlobalSearch';

function useOutside(ref: React.RefObject<HTMLElement>, onOut: () => void) {
  useEffect(() => {
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onOut();
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, [ref, onOut]);
}

interface Notification { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

function NotificationBell() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const count = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => api.get<{ count: number }>('/notifications/unread-count'), refetchInterval: 30_000 });
  const list = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => api.get<Paged<Notification>>('/notifications', { pageSize: 8 }), enabled: open });
  const open1 = async (n: Notification) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`);
    qc.invalidateQueries({ queryKey: ['notifications'] });
    setOpen(false);
    if (n.link) nav(n.link);
  };
  const readAll = async () => {
    await api.post('/notifications/read-all');
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const c = count.data?.count ?? 0;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative grid h-10 w-10 place-items-center rounded-xl text-ink-soft hover:bg-surface-sunken" aria-label={t('nav.notifications')}>
        <Bell className="h-5 w-5" />
        {c > 0 && <span className="absolute end-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger-600 px-1 text-[10px] font-bold text-white">{c > 99 ? '99+' : c}</span>}
      </button>
      {open && (
        <div className="absolute end-0 top-full z-40 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] animate-pop-in overflow-hidden rounded-2xl border border-line bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-bold">{t('nav.notifications')}</span>
            {c > 0 && <button onClick={readAll} className="text-xs font-semibold text-primary-700 hover:underline">{t('topbar.markAllRead')}</button>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {list.data?.items.length ? (
              list.data.items.map((n) => (
                <button key={n.id} onClick={() => open1(n)} className={clsx('flex w-full gap-3 border-b border-line px-4 py-3 text-start last:border-0 hover:bg-surface-subtle', !n.readAt && 'bg-primary-50/50')}>
                  <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary-500')} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{n.title}</span>
                    {n.body && <span className="block truncate text-xs text-ink-muted">{n.body}</span>}
                    <span className="mt-0.5 block text-[11px] text-ink-muted">{t(`enum.NotificationType.${n.type}`)} · {fmtDateTime(n.createdAt)}</span>
                  </span>
                </button>
              ))
            ) : (
              <p className="p-6 text-center text-sm text-ink-muted">{list.isLoading ? t('common.loading') : t('topbar.noNotifications')}</p>
            )}
          </div>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-line bg-surface-subtle px-4 py-2.5 text-center text-xs font-semibold text-primary-700 hover:underline">
            {t('common.viewAll')}
          </Link>
        </div>
      )}
    </div>
  );
}

function AttendanceButton() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['attendance', 'me'], queryFn: () => api.get<{ record: { checkIn: string | null; checkOut: string | null } | null }>('/staff/attendance/me') });
  const [busy, setBusy] = useState(false);
  const rec = q.data?.record;
  const checkedIn = !!rec?.checkIn && !rec.checkOut;
  const act = async () => {
    setBusy(true);
    try {
      await api.post(checkedIn ? '/staff/attendance/check-out' : '/staff/attendance/check-in');
      toast.success(checkedIn ? t('topbar.checkedOutOk') : t('topbar.checkedInOk'));
      qc.invalidateQueries({ queryKey: ['attendance'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (q.isLoading || rec?.checkOut) return null;
  return (
    <button
      onClick={act}
      disabled={busy}
      title={checkedIn ? t('topbar.checkedInAt', { time: fmtTime(rec!.checkIn) }) : undefined}
      className={clsx(
        'hidden h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition sm:inline-flex',
        checkedIn ? 'bg-success-50 text-success-700 hover:bg-success-100' : 'bg-primary-50 text-primary-700 hover:bg-primary-100',
      )}
    >
      {checkedIn ? <LogOut className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
      {checkedIn ? t('topbar.checkOut') : t('topbar.checkIn')}
    </button>
  );
}

function UserMenu() {
  const { t, i18n } = useTranslation();
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  if (!me) return null;
  const initials = me.user.fullName.replace(/^د\.\s*/, '').split(' ').slice(0, 2).map((w) => w[0]).join('');
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-xl p-1 pe-2 hover:bg-surface-sunken">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-100 text-xs font-bold text-primary-800">{initials}</span>
        <span className="hidden text-start leading-tight md:block">
          <span className="block max-w-[10rem] truncate text-sm font-semibold">{me.user.fullName}</span>
          <span className="block text-[11px] text-ink-muted">{me.user.role.name}</span>
        </span>
        <ChevronDown className="hidden h-4 w-4 text-ink-muted md:block" />
      </button>
      {open && (
        <div className="absolute end-0 top-full z-40 mt-2 w-56 animate-pop-in rounded-2xl border border-line bg-white p-1.5 shadow-pop">
          <Link to="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-subtle">
            <UserRound className="h-4 w-4 text-ink-muted" /> {t('nav.account')}
          </Link>
          <Link to="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-subtle">
            <KeyRound className="h-4 w-4 text-ink-muted" /> {t('auth.changePassword')}
          </Link>
          <div className="my-1 border-t border-line" />
          <div className="flex items-center gap-2 px-3 py-2 text-sm">
            <Globe className="h-4 w-4 text-ink-muted" />
            {LANGS.map((l) => (
              <button key={l.code} onClick={() => i18n.changeLanguage(l.code)} className={clsx('rounded-md px-2 py-0.5 text-xs font-semibold', i18n.language === l.code ? 'bg-primary-100 text-primary-800' : 'text-ink-muted hover:text-ink')}>
                {l.label}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-line" />
          <button onClick={async () => { await logout(); nav('/login'); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger-700 hover:bg-danger-50">
            <LogOut className="h-4 w-4" /> {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  }, []);
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-line bg-white/85 px-3 backdrop-blur print:hidden sm:px-5">
      <button onClick={onMenu} className="grid h-10 w-10 place-items-center rounded-xl text-ink-soft hover:bg-surface-sunken lg:hidden" aria-label={t('nav.menu')}>
        <Menu className="h-5 w-5" />
      </button>
      <button onClick={() => setSearchOpen(true)} className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface-subtle px-3 text-sm text-ink-muted transition hover:border-primary-300 sm:max-w-md">
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">{t('topbar.search')}</span>
        <kbd className="ms-auto hidden rounded-md border border-line bg-white px-1.5 py-0.5 text-[10px] font-semibold sm:block" dir="ltr">{t('topbar.searchHint')}</kbd>
      </button>
      <div className="ms-auto flex items-center gap-1">
        <AttendanceButton />
        <NotificationBell />
        <UserMenu />
      </div>
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
