import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface AccountRow {
  id: string; code: string; name: string; type: string; nature: string; parentId: string | null; isGroup: boolean; isActive: boolean; systemKey: string | null;
  level: number; opening: number; debit: number; credit: number; closing: number; lines: number;
}
export const useAccounts = () => useQuery({ queryKey: ['acc', 'accounts'], queryFn: () => api.get<AccountRow[]>('/accounting/accounts'), staleTime: 30_000 });
export const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export const JTYPES = ['GENERAL', 'OPENING', 'ADJUSTMENT', 'CLOSING', 'EXPENSE', 'REVENUE', 'RECEIPT', 'PAYMENT', 'PAYROLL', 'PURCHASE', 'CHEQUE', 'BANK_RECONCILIATION', 'DEPRECIATION', 'CORRECTION'] as const;
export const today = () => new Date().toLocaleDateString('en-CA');
export const monthStart = () => `${today().slice(0, 7)}-01`;
export const yearStart = () => `${today().slice(0, 4)}-01-01`;
/** Amount with 3 decimals, no currency sign (accounting tables). */
export const amt = (v: number | string | null | undefined) => (v == null || Number(v) === 0 ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
export const amt0 = (v: number | string | null | undefined) => Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = { POSTED: 'success', DRAFT: 'warning', DELETED: 'neutral' };
