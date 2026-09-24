import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorState, Skeleton } from './feedback';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  /** Hide on small screens (the row still shows the essentials). */
  hideOnMobile?: boolean;
  align?: 'start' | 'end' | 'center';
}

export interface SortState {
  sort?: string;
  order: 'asc' | 'desc';
}

export function DataTable<T>({
  columns, rows, rowKey, loading, error, onRetry, onRowClick, sort, onSort, empty, rowClassName, footer, dense,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (r: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (r: T) => void;
  sort?: SortState;
  onSort?: (s: SortState) => void;
  empty?: ReactNode;
  rowClassName?: (r: T) => string | undefined;
  footer?: ReactNode;
  dense?: boolean;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  const align = (a?: string) => (a === 'end' ? 'text-end' : a === 'center' ? 'text-center' : 'text-start');
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.sort === c.key;
              return (
                <th
                  key={c.key}
                  className={clsx(
                    'sticky top-0 z-[1] border-b border-line bg-surface-subtle px-3 py-2.5 text-xs font-semibold text-ink-muted first:rounded-ts-xl last:rounded-te-xl',
                    align(c.align),
                    c.hideOnMobile && 'hidden md:table-cell',
                    c.className,
                  )}
                >
                  {c.sortable && onSort ? (
                    <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => onSort({ sort: c.key, order: active && sort?.order === 'desc' ? 'asc' : 'desc' })}>
                      {c.header}
                      {active && (sort?.order === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && !rows
            ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('border-b border-line px-3 py-3', c.hideOnMobile && 'hidden md:table-cell')}>
                      <Skeleton className="h-4 w-3/4" />
                    </td>
                  ))}
                </tr>
              ))
            : rows?.map((r) => (
                <tr
                  key={rowKey(r)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={clsx('group transition-colors', onRowClick && 'cursor-pointer hover:bg-primary-50/60', loading && 'opacity-60', rowClassName?.(r))}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('border-b border-line px-3 align-middle text-ink', dense ? 'py-2' : 'py-3', align(c.align), c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
      {!loading && rows && rows.length === 0 && (empty ?? <EmptyState />)}
    </div>
  );
}

export function Pagination({ page, pageCount, total, pageSize, onPage }: { page: number; pageCount: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  if (!total) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-3 text-xs text-ink-muted print:hidden">
      <span>{t('common.showing', { from, to, total })}</span>
      <div className="flex items-center gap-1">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-lg border border-line bg-white p-1.5 hover:bg-surface-subtle disabled:opacity-40" aria-label={t('common.previous')}>
          <ChevronRight className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" />
        </button>
        <span className="px-2 tabular-nums">{t('common.page', { page, count: pageCount })}</span>
        <button disabled={page >= pageCount} onClick={() => onPage(page + 1)} className="rounded-lg border border-line bg-white p-1.5 hover:bg-surface-subtle disabled:opacity-40" aria-label={t('common.next')}>
          <ChevronLeft className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" />
        </button>
      </div>
    </div>
  );
}
