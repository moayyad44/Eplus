import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { money } from '@/lib/format';
import { Button, Card, CardHeader, Dialog, IconButton, Input, Select } from '@/components/ui';

export interface PresetService { serviceId: string; quantity: number }
export interface NursingPreset { name: string; services: PresetService[] }
interface Svc { id: string; name: string; code: string; price: string | number; category: string; isActive: boolean }

export const useNursingPresets = () => useQuery({ queryKey: ['settings-public'], queryFn: () => api.get<{ medical: { nursingProcedures: NursingPreset[] } }>('/settings/public'), staleTime: 60_000, select: (s) => s.medical.nursingProcedures ?? [] });
export const useServiceList = () => useQuery({ queryKey: ['catalog', 'services'], queryFn: () => api.get<Svc[]>('/settings/services'), staleTime: 60_000 });

/** The list of quick nursing procedures; each can be linked to a service so it is added to the visit's invoice. */
export function NursingPresetsEditor({ onSaved }: { onSaved?: () => void }) {
  const { t } = useTranslation();
  const q = useNursingPresets();
  const services = useServiceList();
  const [rows, setRows] = useState<NursingPreset[]>([]);
  useEffect(() => { if (q.data) setRows(q.data); }, [q.data]);
  const save = useApiMutation(() => api.put('/settings/medical', { nursingProcedures: rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), services: r.services })) }), { invalidate: [['settings-public'], ['settings']], onSuccess: onSaved });
  const set = (i: number, p: Partial<NursingPreset>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const move = (i: number, d: number) => { const r = [...rows]; [r[i], r[i + d]] = [r[i + d], r[i]]; setRows(r); };
  const active = (services.data ?? []).filter((s) => s.isActive);
  const byId = new Map((services.data ?? []).map((s) => [s.id, s]));
  const addSvc = (i: number, serviceId: string) => { if (!serviceId) return; const r = rows[i]; const ex = r.services.find((x) => x.serviceId === serviceId); set(i, { services: ex ? r.services.map((x) => (x.serviceId === serviceId ? { ...x, quantity: x.quantity + 1 } : x)) : [...r.services, { serviceId, quantity: 1 }] }); };
  const qty = (i: number, serviceId: string, d: number) => set(i, { services: rows[i].services.map((x) => (x.serviceId === serviceId ? { ...x, quantity: Math.max(1, Math.min(100, x.quantity + d)) } : x)) });
  const drop = (i: number, serviceId: string) => set(i, { services: rows[i].services.filter((x) => x.serviceId !== serviceId) });
  const price = (r: NursingPreset) => r.services.reduce((t, x) => t + Number(byId.get(x.serviceId)?.price ?? 0) * x.quantity, 0);
  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">{t('visit.nursing.editorHint')}</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="rounded-xl border border-line p-2.5">
            <div className="grid items-center gap-2 sm:grid-cols-[1fr_1.3fr_auto]">
              <Input value={r.name} placeholder={t('visit.nursing.procedure')} onChange={(e) => set(i, { name: e.target.value })} />
              <Select value="" onChange={(e) => addSvc(i, e.target.value)}>
                <option value="">{t('visit.nursing.addService')}</option>
                {active.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price)}</option>)}
              </Select>
              <div className="flex">
                <IconButton size="sm" label={t('visit.nursing.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton size="sm" label={t('visit.nursing.moveDown')} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton size="sm" label={t('common.delete')} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {!r.services.length && <span className="text-xs text-ink-muted">{t('visit.nursing.noService')}</span>}
              {r.services.map((x) => (
                <span key={x.serviceId} className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-800">
                  {byId.get(x.serviceId)?.name ?? '…'}
                  <button type="button" className="rounded px-1 hover:bg-primary-100" aria-label="-" onClick={() => qty(i, x.serviceId, -1)}>−</button>
                  <b className="tabular-nums">×{x.quantity}</b>
                  <button type="button" className="rounded px-1 hover:bg-primary-100" aria-label="+" onClick={() => qty(i, x.serviceId, 1)}>+</button>
                  <button type="button" aria-label={t('common.delete')} onClick={() => drop(i, x.serviceId)}><X className="h-3 w-3" /></button>
                </span>
              ))}
              {r.services.length > 0 && <span className="ms-auto text-xs text-ink-muted">{t('visit.nursing.onBill', { v: money(price(r)) })}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-between gap-2">
        <Button variant="outline" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setRows([...rows, { name: '', services: [] }])}>{t('visit.nursing.addPreset')}</Button>
        <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button>
      </div>
    </div>
  );
}

export function NursingPresetsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return <Dialog open onClose={onClose} size="lg" title={t('visit.nursing.editList')}><NursingPresetsEditor onSaved={onClose} /></Dialog>;
}

export function NursingPresetsCard() {
  const { t } = useTranslation();
  return <Card><CardHeader title={t('visit.nursing.editList')} /><NursingPresetsEditor /></Card>;
}
