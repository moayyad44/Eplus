import { useCallback, useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Paged } from './api';

/** List state (page / search / sort / filters) + the paged query. */
export function usePagedList<T, F extends Record<string, string | number | boolean | undefined> = Record<string, never>>(
  key: string,
  url: string,
  initial: { pageSize?: number; sort?: string; order?: 'asc' | 'desc'; filters?: F } = {},
) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSortState] = useState<{ sort?: string; order: 'asc' | 'desc' }>({ sort: initial.sort, order: initial.order ?? 'desc' });
  const [filters, setFiltersState] = useState<F>((initial.filters ?? {}) as F);
  const pageSize = initial.pageSize ?? 20;
  const params = { page, pageSize, q, ...sort, ...filters };
  const query = useQuery({
    queryKey: [key, params],
    queryFn: () => api.get<Paged<T> & Record<string, unknown>>(url, params as never),
    placeholderData: keepPreviousData,
  });
  const setSearch = useCallback((v: string) => { setQ(v); setPage(1); }, []);
  const setSort = useCallback((s: { sort?: string; order: 'asc' | 'desc' }) => { setSortState(s); setPage(1); }, []);
  const setFilters = useCallback((f: Partial<F>) => { setFiltersState((prev) => ({ ...prev, ...f })); setPage(1); }, []);
  return { query, data: query.data, page, setPage, q, setSearch, sort, setSort, filters, setFilters, pageSize };
}

/** Mutation with standard toasts and cache invalidation. Field errors are exposed for forms. */
export function useApiMutation<TVars, TRes = unknown>(
  fn: (v: TVars) => Promise<TRes>,
  opts: { invalidate?: QueryKey[]; success?: string | false; onSuccess?: (r: TRes, v: TVars) => void; onError?: (e: ApiError) => void } = {},
) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: fn,
    onMutate: () => setFieldErrors({}),
    onSuccess: (r, v) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      if (opts.success !== false) toast.success(opts.success ?? t('common.saved'));
      opts.onSuccess?.(r, v);
    },
    onError: (e: unknown) => {
      const err = e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e));
      setFieldErrors(err.fields);
      if (opts.onError) opts.onError(err);
      else toast.error(err.message);
    },
  });
  return { ...m, fieldErrors, setFieldErrors };
}

export function useDebounced<T>(value: T, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}

/** Generic form state helper. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => setValues((p) => ({ ...p, [k]: v })), []);
  const bind = (k: keyof T & string) => ({
    value: (values[k] ?? '') as string,
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as T[typeof k]),
  });
  return { values, setValues, set, bind, reset: () => setValues(initial) };
}
