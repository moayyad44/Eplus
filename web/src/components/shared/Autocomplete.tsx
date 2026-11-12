import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebounced } from '@/lib/hooks';
import { Input } from '@/components/ui';

/** Free-text input with async suggestions (value is always the typed text; picking fills it). */
export function Autocomplete<T>({
  value, onChange, onPick, fetcher, queryKey, render, placeholder, minChars = 1, dir,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (item: T) => void;
  fetcher: (q: string) => Promise<T[]>;
  queryKey: string;
  render: (item: T) => ReactNode;
  placeholder?: string;
  minChars?: number;
  dir?: 'ltr' | 'rtl' | 'auto';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(value.trim(), 200);
  const box = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['ac', queryKey, dq], queryFn: () => fetcher(dq), enabled: open && dq.length >= minChars, staleTime: 60_000 });
  const items = q.data ?? [];
  useEffect(() => {
    const f = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, []);
  useEffect(() => setActive(0), [dq]);
  return (
    <div ref={box} className="relative">
      <Input
        value={value}
        dir={dir}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !items.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); onPick(items[active]); setOpen(false); }
        }}
      />
      {open && items.length > 0 && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-xl border border-line bg-white p-1 shadow-pop">
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(it); setOpen(false); }}
              className={`block w-full rounded-lg px-3 py-2 text-start text-sm ${i === active ? 'bg-primary-50' : 'hover:bg-surface-subtle'}`}
            >
              {render(it)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
