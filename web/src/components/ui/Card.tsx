import type { ReactNode } from 'react';
import clsx from 'clsx';

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={clsx('rounded-2xl border border-line bg-white shadow-card', padded && 'p-4 sm:p-5', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions, icon, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-4 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-700">{icon}</span>}
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const tones = {
  primary: 'bg-primary-50 text-primary-700',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
  danger: 'bg-danger-50 text-danger-700',
  violet: 'bg-violet-50 text-violet-700',
  neutral: 'bg-surface-sunken text-ink-soft',
};

export function StatCard({ label, value, icon, tone = 'primary', hint, onClick }: { label: ReactNode; value: ReactNode; icon?: ReactNode; tone?: keyof typeof tones; hint?: ReactNode; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={clsx('flex w-full items-center gap-3 rounded-2xl border border-line bg-white p-4 text-start shadow-card', onClick && 'transition hover:border-primary-300 hover:shadow-pop')}
    >
      {icon && <span className={clsx('grid h-11 w-11 shrink-0 place-items-center rounded-xl', tones[tone])}>{icon}</span>}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-ink-muted">{label}</span>
        <span className="mt-0.5 block truncate text-xl font-bold tabular-nums text-ink">{value}</span>
        {hint && <span className="block truncate text-[11px] text-ink-muted">{hint}</span>}
      </span>
    </Comp>
  );
}
