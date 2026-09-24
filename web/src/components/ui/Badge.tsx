import type { ReactNode } from 'react';
import clsx from 'clsx';

export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral' | 'violet' | 'info';

const tones: Record<Tone, string> = {
  primary: 'bg-primary-100 text-primary-800 ring-primary-200',
  info: 'bg-primary-50 text-primary-700 ring-primary-100',
  success: 'bg-success-50 text-success-700 ring-success-100',
  warning: 'bg-warning-50 text-warning-700 ring-warning-100',
  danger: 'bg-danger-50 text-danger-700 ring-danger-100',
  violet: 'bg-violet-50 text-violet-700 ring-violet-100',
  neutral: 'bg-surface-sunken text-ink-soft ring-line',
};

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
