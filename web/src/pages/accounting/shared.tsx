import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAccounts } from '@/lib/accounting';
import { Button, Select } from '@/components/ui';
import { AccountCombo } from './AccountCombo';

export interface Treasury { id: string; kind: 'CASH' | 'BANK'; name: string; accountId: string; account?: { code: string; name: string }; custodianId: string | null; custodian: string | null; bankName: string | null; branch: string | null; accountNumber: string | null; iban: string | null; holderName: string | null; notes: string | null; isActive: boolean; balance: number }
export const useTreasuries = () => useQuery({ queryKey: ['acc', 'treasuries'], queryFn: () => api.get<Treasury[]>('/accounting/treasuries'), staleTime: 15_000 });

/** Leaf (posting) accounts, optionally limited to some types — searchable by code or name. */
export function AccountSelect({ value, onChange, types, placeholder, className, invalid }: { value: string; onChange: (v: string) => void; types?: string[]; placeholder?: string; className?: string; invalid?: boolean }) {
  const q = useAccounts();
  const rows = (q.data ?? []).filter((a) => !a.isGroup && (a.isActive || a.id === value) && (!types || types.includes(a.type)));
  return <AccountCombo value={value} onChange={onChange} rows={rows} placeholder={placeholder} className={className} invalid={invalid} openOnFocus />;
}

export function TreasurySelect({ value, onChange, kind, placeholder, className }: { value: string; onChange: (v: string) => void; kind?: 'CASH' | 'BANK'; placeholder?: string; className?: string }) {
  const { t } = useTranslation();
  const q = useTreasuries();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{placeholder ?? t('ao.pickTreasury')}</option>
      {(q.data ?? []).filter((x) => x.isActive && (!kind || x.kind === kind)).map((x) => <option key={x.id} value={x.id}>{x.kind === 'BANK' ? '🏦' : '💵'} {x.name}</option>)}
    </Select>
  );
}

/** Every row of a paged list (for exporting what the filters show, not just the current page). */
export async function fetchAll<T>(url: string, q: Record<string, string | number | boolean | undefined>) {
  const out: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const r = await api.get<{ items: T[]; pageCount: number }>(url, { ...q, page, pageSize: 200 });
    out.push(...r.items);
    if (page >= r.pageCount) break;
  }
  return out;
}

export interface XCol { header: string; key: string; money?: boolean; date?: boolean }
/** Real .xlsx made by the server (Arabic, right to left, totals) from the rows on screen. */
export async function exportXlsx(title: string, columns: XCol[], rows: Record<string, unknown>[], totals?: string[]) {
  const res = await fetch('/api/accounting/export/xlsx', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'EmergencyPlus' },
    body: JSON.stringify({ title, fileName: title.replace(/\s+/g, '-'), columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, (r[c.key] ?? null) as never]))), totals }),
  });
  if (!res.ok) { toast.error((await res.json().catch(() => null))?.error?.message ?? 'تعذر التصدير'); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = `${title}.xlsx`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Excel + print buttons for a report (Excel only with the export permission). */
export function ReportActions({ onExcel, extra }: { onExcel?: () => void; extra?: ReactNode }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      {extra}
      {onExcel && can('accounting.export') && <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={onExcel}>Excel</Button>}
      <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('common.print')} / PDF</Button>
    </div>
  );
}

export const Money = ({ v, className }: { v: number | string | null | undefined; className?: string }) => (
  <span dir="ltr" className={`tabular-nums ${Number(v) < 0 ? 'text-danger-700' : ''} ${className ?? ''}`}>{Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</span>
);
