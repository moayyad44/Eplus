import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { NAV } from './nav';
import { Logo } from './Logo';

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { canAny } = useAuth();
  const sections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => canAny(...i.any)) })).filter((s) => s.items.length);
  return (
    <>
      <div className={clsx('fixed inset-0 z-30 bg-ink/30 lg:hidden', open ? 'block' : 'hidden')} onClick={onClose} />
      <aside
        className={clsx(
          'fixed inset-y-0 start-0 z-40 flex w-64 flex-col border-e border-line bg-white transition-transform duration-200 print:hidden lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          open ? 'translate-x-0' : 'ltr:-translate-x-full rtl:translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-line px-4">
          <Logo />
          <button className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-sunken lg:hidden" onClick={onClose} aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {sections.map((s) => (
            <div key={s.label}>
              <p className="mb-1.5 px-3 text-[11px] font-bold uppercase tracking-wide text-ink-muted/80">{t(s.label)}</p>
              <ul className="space-y-0.5">
                {s.items.map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      onClick={onClose}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                          isActive ? 'bg-primary-50 font-semibold text-primary-800 ring-1 ring-inset ring-primary-100' : 'text-ink-soft hover:bg-surface-subtle hover:text-ink',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <span className={isActive ? 'text-primary-600' : 'text-ink-muted'}>{i.icon}</span>
                          {t(i.label)}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
