import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Boxes, CalendarDays, FileText, Search, Truck, UserCog, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { fmtDateTime, money, qty } from '@/lib/format';
import { Spinner } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Results {
  patients: { id: string; fullName: string; phone: string; fileNumber: string }[];
  invoices: { id: string; invoiceNumber: string | null; status: string; total: number; patient: { fullName: string } }[];
  appointments: { id: string; startAt: string; status: string; patient: { fullName: string }; doctor: { fullName: string } }[];
  staff: { id: string; fullName: string; staffType: string; role: { name: string } }[];
  inventory: { id: string; name: string; sku: string; quantity: number }[];
  suppliers: { id: string; name: string; phone: string | null }[];
}

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ['search', dq], queryFn: () => api.get<Results>('/search', { q: dq }), enabled: open && dq.length >= 2 });
  useEffect(() => {
    if (!open) return setQ('');
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  }, [open, onClose]);
  if (!open) return null;
  const go = (to: string) => { onClose(); nav(to); };
  const d = res.data;
  const groups = d
    ? [
        { key: 'patients', icon: <UserRound className="h-4 w-4" />, rows: d.patients.map((p) => ({ id: p.id, title: p.fullName, meta: <span dir="ltr">{p.phone} · #{p.fileNumber}</span>, to: `/patients/${p.id}` })) },
        { key: 'invoices', icon: <FileText className="h-4 w-4" />, rows: d.invoices.map((i) => ({ id: i.id, title: `${i.invoiceNumber ?? t('enum.InvoiceStatus.DRAFT')} — ${i.patient.fullName}`, meta: <span className="flex items-center gap-2">{money(i.total)} <StatusBadge enumName="InvoiceStatus" value={i.status} /></span>, to: `/billing/invoices/${i.id}` })) },
        { key: 'appointments', icon: <CalendarDays className="h-4 w-4" />, rows: d.appointments.map((a) => ({ id: a.id, title: a.patient.fullName, meta: `${fmtDateTime(a.startAt)} · ${a.doctor.fullName}`, to: `/appointments?date=${a.startAt.slice(0, 10)}` })) },
        { key: 'staff', icon: <UserCog className="h-4 w-4" />, rows: d.staff.map((s) => ({ id: s.id, title: s.fullName, meta: s.role.name, to: `/staff/users?focus=${s.id}` })) },
        { key: 'inventory', icon: <Boxes className="h-4 w-4" />, rows: d.inventory.map((i) => ({ id: i.id, title: i.name, meta: `${i.sku} · ${qty(i.quantity)}`, to: `/inventory/items/${i.id}` })) },
        { key: 'suppliers', icon: <Truck className="h-4 w-4" />, rows: d.suppliers.map((s) => ({ id: s.id, title: s.name, meta: s.phone ?? '', to: `/suppliers/${s.id}` })) },
      ].filter((g) => g.rows.length)
    : [];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh]">
      <div className="absolute inset-0 animate-fade-in bg-ink/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-2xl animate-pop-in overflow-hidden rounded-2xl bg-white shadow-pop">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="h-5 w-5 text-ink-muted" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search.placeholder')} className="h-14 flex-1 bg-transparent text-base outline-none" />
          {res.isFetching && <Spinner className="h-4 w-4" />}
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {dq.length < 2 ? (
            <p className="p-6 text-center text-sm text-ink-muted">{t('search.minChars')}</p>
          ) : groups.length ? (
            groups.map((g) => (
              <div key={g.key} className="mb-2">
                <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-bold text-ink-muted">{g.icon}{t(`search.${g.key}`)}</p>
                {g.rows.map((r) => (
                  <button key={r.id} onClick={() => go(r.to)} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-primary-50">
                    <span className="truncate text-sm font-semibold">{r.title}</span>
                    <span className="shrink-0 text-xs text-ink-muted">{r.meta}</span>
                  </button>
                ))}
              </div>
            ))
          ) : (
            !res.isFetching && <p className="p-6 text-center text-sm text-ink-muted">{t('common.noResults')}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
