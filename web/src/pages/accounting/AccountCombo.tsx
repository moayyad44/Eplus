import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { AccountRow } from '@/lib/accounting';

/** Arabic-insensitive search text: أ/إ/آ → ا, ة → ه, ى → ي, no tashkeel, lower case. */
export const norm = (s: string) => s.toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();

/** Accounts matching what was typed: code start, or every typed word inside the name. Exact code first. */
export function searchAccounts(rows: AccountRow[], q: string) {
  const s = norm(q);
  if (!s) return rows;
  const words = s.split(/\s+/);
  const hit = rows.filter((a) => a.code.toLowerCase().startsWith(s) || words.every((w) => norm(a.name).includes(w) || a.code.toLowerCase().startsWith(w)));
  return hit.sort((a, b) => Number(b.code.toLowerCase() === s) - Number(a.code.toLowerCase() === s) || Number(b.code.toLowerCase().startsWith(s)) - Number(a.code.toLowerCase().startsWith(s)));
}

/** The account a pasted / typed text means: exact code, exact name, or the only match. */
export function resolveAccount(rows: AccountRow[], text: string) {
  const s = norm(text);
  if (!s) return undefined;
  const code = s.split(/\s|—|-/)[0];
  return rows.find((a) => a.code.toLowerCase() === s || a.code.toLowerCase() === code) ?? rows.find((a) => norm(a.name) === s || norm(`${a.code} — ${a.name}`) === s)
    ?? (() => { const r = searchAccounts(rows, text); return r.length === 1 ? r[0] : undefined; })();
}

export const accountLabel = (a: AccountRow | undefined) => (a ? `${a.code} — ${a.name}` : '');

interface Props {
  value: string;
  onChange: (id: string) => void;
  /** The accounts that may be picked (already filtered by the caller). */
  rows: AccountRow[];
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  /** Show the list as soon as the box gets focus (forms); in a grid it opens on typing so the arrows move between rows. */
  openOnFocus?: boolean;
  /** Keys the list does not use (arrows / Enter while closed…), for grid navigation. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onPaste?: React.ClipboardEventHandler<HTMLInputElement>;
  onFocus?: () => void;
  disabled?: boolean;
  /** Indent groups by level (tree look) — for pickers that also list groups. */
  tree?: boolean;
}

/** Type a code or part of a name and pick the account (keyboard: ↑ ↓ Enter Esc). */
export const AccountCombo = forwardRef<HTMLInputElement, Props>(function AccountCombo({ value, onChange, rows, placeholder, invalid, className, openOnFocus, onKeyDown, onPaste, onFocus, disabled, tree }, ref) {
  const { t } = useTranslation();
  const selected = rows.find((a) => a.id === value);
  const [text, setText] = useState<string | null>(null); // null = not typing: show the selected account
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const inner = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(() => searchAccounts(rows, text ?? '').slice(0, 80), [rows, text]);
  useEffect(() => setActive(0), [text]);
  const place = () => {
    const r = inner.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + 300 > window.innerHeight && r.top > 320;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: Math.max(r.width, 300), up });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const h = () => place();
    window.addEventListener('scroll', h, true); window.addEventListener('resize', h);
    return () => { window.removeEventListener('scroll', h, true); window.removeEventListener('resize', h); };
  }, [open]);
  useEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const pick = (a: AccountRow | undefined) => { if (a) onChange(a.id); setText(null); setOpen(false); };
  const close = () => { setText(null); setOpen(false); };
  return (
    <>
      <input
        ref={(el) => { inner.current = el; if (typeof ref === 'function') ref(el); else if (ref) ref.current = el; }}
        value={text ?? accountLabel(selected)}
        placeholder={placeholder ?? t('acc.journal.pickAccount')}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        className={clsx('h-10 w-full rounded-xl border bg-white px-3 text-sm text-ink placeholder:text-ink-muted/70 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-300 disabled:bg-surface-sunken', invalid ? 'border-danger-600' : 'border-line-strong', className)}
        onFocus={(e) => { e.target.select(); onFocus?.(); if (openOnFocus) setOpen(true); }}
        onBlur={() => setTimeout(close, 120)}
        onChange={(e) => { setText(e.target.value); setOpen(true); if (!e.target.value) onChange(''); }}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (open && items.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
            if (e.key === 'Enter' || (e.key === 'Tab' && text)) { if (e.key === 'Enter') e.preventDefault(); pick(items[active]); if (e.key === 'Enter') onKeyDown?.(e); return; }
          }
          if (e.key === 'Escape' && open) { e.preventDefault(); close(); return; }
          if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); return; }
          onKeyDown?.(e);
        }}
      />
      {open && pos && createPortal(
        <div
          ref={list}
          style={{ position: 'fixed', left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
          className="z-[60] max-h-72 overflow-auto rounded-xl border border-line bg-white p-1 text-sm shadow-pop"
          dir="rtl"
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.length ? items.map((a, i) => (
            <button
              key={a.id}
              type="button"
              data-i={i}
              onClick={() => pick(a)}
              onMouseEnter={() => setActive(i)}
              className={clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start', i === active ? 'bg-primary-50' : 'hover:bg-surface-subtle', a.isGroup && 'font-semibold', a.id === value && 'text-primary-700')}
              style={tree && !text ? { paddingInlineStart: `${10 + a.level * 14}px` } : undefined}
            >
              <span className="font-mono text-xs text-ink-muted" dir="ltr">{a.code}</span>
              <span className="truncate">{a.name}</span>
            </button>
          )) : <p className="px-3 py-2 text-ink-muted">{t('acc.journal.noAccount')}</p>}
        </div>,
        document.body,
      )}
    </>
  );
});
