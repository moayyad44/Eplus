import { forwardRef, useEffect, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Search, X } from 'lucide-react';

const control =
  'w-full rounded-xl border bg-white px-3 text-sm text-ink placeholder:text-ink-muted/70 transition focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400 disabled:bg-surface-sunken disabled:text-ink-muted';

export function Field({ label, error, hint, required, children, className }: { label?: ReactNode; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      {label && (
        <span className="mb-1.5 block text-xs font-semibold text-ink-soft">
          {label}
          {required && <span className="ms-0.5 text-danger-600">*</span>}
        </span>
      )}
      {children}
      {error ? <span className="mt-1 block text-xs text-danger-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={clsx(control, 'h-10', invalid ? 'border-danger-600' : 'border-line-strong', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, rows = 3, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={clsx(control, 'py-2 leading-relaxed', invalid ? 'border-danger-600' : 'border-line-strong', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; placeholder?: string }>(function Select(
  { className, invalid, placeholder, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={clsx(control, 'h-10 pe-8', invalid ? 'border-danger-600' : 'border-line-strong', className)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {children}
    </select>
  );
});

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 text-sm text-ink', className)}>
      <input type="checkbox" className="h-4 w-4 rounded border-line-strong text-primary-600 accent-primary-600" {...rest} />
      {label}
    </label>
  );
}

/** Debounced search box. */
export function SearchInput({ value, onChange, placeholder, delay = 300, className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; delay?: number; className?: string; autoFocus?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v === value) return;
    const id = setTimeout(() => onChange(v), delay);
    return () => clearTimeout(id);
  }, [v, value, onChange, delay]);
  return (
    <div className={clsx('relative', className)}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
      <input value={v} autoFocus={autoFocus} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className={clsx(control, 'h-10 border-line-strong ps-9 pe-8')} />
      {v && (
        <button type="button" onClick={() => { setV(''); onChange(''); }} className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-muted hover:text-ink" aria-label="clear">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
