import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { NamedItem } from './types';

const stale = 5 * 60_000;
export const useCatalog = <T = NamedItem>(path: string) => useQuery({ queryKey: ['catalog', path], queryFn: () => api.get<T[]>(`/settings/${path}`), staleTime: stale });
export interface Warehouse { id: string; code: string; name: string; location: string | null; notes: string | null; isDefault: boolean; isActive: boolean; items: number; value: number; isSaleWarehouse: boolean }
export const useWarehouses = () => useQuery({ queryKey: ['inventory', 'warehouses'], queryFn: () => api.get<Warehouse[]>('/inventory/warehouses'), staleTime: 60_000 });
export const useSuppliersLookup = () => useQuery({ queryKey: ['suppliers', 'lookup'], queryFn: () => api.get<{ items: { id: string; name: string }[] }>('/suppliers', { pageSize: 200 }).then((r) => r.items), staleTime: stale });
