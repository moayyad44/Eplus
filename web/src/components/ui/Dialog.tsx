import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Field, Textarea } from './form';

const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

export function Dialog({
  open, onClose, title, subtitle, children, footer, size = 'md', dismissable = true,
}: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; size?: keyof typeof sizes; dismissable?: boolean }) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismissable && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setTimeout(() => panel.current?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-ink/40 backdrop-blur-[2px]" onClick={() => dismissable && onClose()} />
      <div ref={panel} className={clsx('relative flex max-h-[92vh] w-full animate-pop-in flex-col rounded-t-2xl bg-white shadow-pop sm:rounded-2xl', sizes[size])}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-subtle px-5 py-3 sm:rounded-b-2xl">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ── Promise-based confirmation dialog ──
interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Ask for a free-text reason (returned as the resolved string). */
  reason?: { label: string; required?: boolean; minLength?: number };
}
type ConfirmFn = (o: ConfirmOptions) => Promise<string | false>;
const ConfirmCtx = createContext<ConfirmFn>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: string | false) => void }) | null>(null);
  const [reason, setReason] = useState('');
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => { setReason(''); setState({ ...o, resolve }); }), []);
  const close = (v: string | false) => {
    state?.resolve(v);
    setState(null);
  };
  const reasonInvalid = !!state?.reason?.required && reason.trim().length < (state.reason.minLength ?? 3);
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        size="sm"
        title={state?.title ?? t('common.confirmTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => close(false)}>{t('common.cancel')}</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} disabled={reasonInvalid} onClick={() => close(reason.trim() || 'ok')}>
              {state?.confirmLabel ?? t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-relaxed text-ink-soft">{state?.message}</div>
        {state?.reason && (
          <Field label={state.reason.label} required={state.reason.required} className="mt-4">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
        )}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);
