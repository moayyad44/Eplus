import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
  hidden?: boolean;
}

export function Tabs<K extends string>({ items, value, onChange, className }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void; className?: string }) {
  return (
    <div className={clsx('no-scrollbar -mx-1 flex gap-1 overflow-x-auto border-b border-line px-1 print:hidden', className)} role="tablist">
      {items
        .filter((i) => !i.hidden)
        .map((i) => (
          <button
            key={i.key}
            role="tab"
            aria-selected={value === i.key}
            onClick={() => onChange(i.key)}
            className={clsx(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors',
              value === i.key ? 'border-primary-500 text-primary-700' : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {i.icon}
            {i.label}
            {i.count !== undefined && (
              <span className={clsx('rounded-full px-1.5 text-[11px] tabular-nums', value === i.key ? 'bg-primary-100 text-primary-800' : 'bg-surface-sunken text-ink-muted')}>{i.count}</span>
            )}
          </button>
        ))}
    </div>
  );
}

/** Compact pill switcher (e.g. day/week/month). */
export function Segmented<K extends string>({ items, value, onChange }: { items: { key: K; label: ReactNode }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="inline-flex rounded-xl bg-surface-sunken p-1">
      {items.map((i) => (
        <button
          key={i.key}
          onClick={() => onChange(i.key)}
          className={clsx('rounded-lg px-3 py-1.5 text-xs font-semibold transition', value === i.key ? 'bg-white text-primary-700 shadow-sm' : 'text-ink-muted hover:text-ink')}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}
