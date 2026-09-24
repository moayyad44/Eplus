import type { ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={clsx('h-5 w-5 animate-spin text-primary-600', className)} />;

export const Skeleton = ({ className }: { className?: string }) => <div className={clsx('animate-pulse rounded-lg bg-surface-sunken', className)} />;

export function PageLoader() {
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

export function EmptyState({ title, description, icon, action, className }: { title?: ReactNode; description?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={clsx('flex flex-col items-center justify-center px-4 py-10 text-center', className)}>
      <span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-primary-50 text-primary-600">{icon ?? <Inbox className="h-6 w-6" />}</span>
      <p className="text-sm font-semibold text-ink">{title ?? t('common.noData')}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const msg = error instanceof Error ? error.message : undefined;
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-danger-50 text-danger-600">
        <AlertTriangle className="h-6 w-6" />
      </span>
      <p className="text-sm font-semibold text-ink">{t('common.errorTitle')}</p>
      {msg && <p className="mt-1 text-xs text-ink-muted">{msg}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}
