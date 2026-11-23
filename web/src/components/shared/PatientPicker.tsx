import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, UserRound, X } from 'lucide-react';
import clsx from 'clsx';
import { api, type Paged } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { PatientLite } from '@/lib/types';
import { Spinner } from '@/components/ui';

/** Async patient search (phone / name / file number) used in forms. */
export function PatientPicker({ value, onChange, invalid, autoFocus }: { value: PatientLite | null; onChange: (p: PatientLite | null) => void; invalid?: boolean; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 250);
  const box = useRef<HTMLDivElement>(null);
  const res = useQuery({
    queryKey: ['patients', 'picker', dq],
    queryFn: () => api.get<Paged<PatientLite>>('/patients', { q: dq, pageSize: 8 }),
    enabled: dq.trim().length >= 2,
  });
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (value) {
    return (
      <div className="flex h-10 items-center gap-2 rounded-xl border border-primary-200 bg-primary-50/60 px-3 text-sm">
        <UserRound className="h-4 w-4 text-primary-700" />
        <span className="min-w-0 flex-1 truncate font-semibold">{value.fullName}</span>
        <span className="text-xs text-ink-muted" dir="ltr">{value.phone}</span>
        <button type="button" onClick={() => onChange(null)} className="rounded p-0.5 text-ink-muted hover:text-danger-600" aria-label={t('common.clear')}>
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div ref={box} className="relative">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
      <input
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={t('patients.searchPlaceholder')}
        className={clsx('h-10 w-full rounded-xl border bg-white ps-9 pe-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300', invalid ? 'border-danger-600' : 'border-line-strong')}
      />
      {open && dq.trim().length >= 2 && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-xl border border-line bg-white p-1 shadow-pop">
          {res.isFetching && !res.data ? (
            <div className="grid place-items-center p-4"><Spinner /></div>
          ) : res.data?.items.length ? (
            res.data.items.map((p) => (
              <button key={p.id} type="button" onClick={() => { onChange(p); setQ(''); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start hover:bg-primary-50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{p.fullName}</span>
                  <span className="block text-xs text-ink-muted">#{p.fileNumber}{p.age != null && ` · ${t('common.yearsOld', { age: p.age })}`}</span>
                </span>
                <span className="text-xs text-ink-muted" dir="ltr">{p.phone}</span>
              </button>
            ))
          ) : (
            <p className="p-3 text-center text-xs text-ink-muted">{t('common.noResults')}</p>
          )}
        </div>
      )}
    </div>
  );
}
