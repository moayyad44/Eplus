import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { money } from '@/lib/format';
import { Button, Card, CardHeader, Dialog, IconButton, Input, Select } from '@/components/ui';

export interface NursingPreset { name: string; serviceId: string | null }
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
  const save = useApiMutation(() => api.put('/settings/medical', { nursingProcedures: rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), serviceId: r.serviceId || null })) }), { invalidate: [['settings-public'], ['settings']], onSuccess: onSaved });
  const set = (i: number, p: Partial<NursingPreset>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const move = (i: number, d: number) => { const r = [...rows]; [r[i], r[i + d]] = [r[i + d], r[i]]; setRows(r); };
  const active = (services.data ?? []).filter((s) => s.isActive);
  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">{t('visit.nursing.editorHint')}</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid items-center gap-2 sm:grid-cols-[1fr_1.3fr_auto]">
            <Input value={r.name} placeholder={t('visit.nursing.procedure')} onChange={(e) => set(i, { name: e.target.value })} />
            <Select value={r.serviceId ?? ''} onChange={(e) => set(i, { serviceId: e.target.value || null })}>
              <option value="">{t('visit.nursing.noService')}</option>
              {active.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price)}</option>)}
            </Select>
            <div className="flex">
              <IconButton size="sm" label={t('visit.nursing.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
              <IconButton size="sm" label={t('visit.nursing.moveDown')} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
              <IconButton size="sm" label={t('common.delete')} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-between gap-2">
        <Button variant="outline" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setRows([...rows, { name: '', serviceId: null }])}>{t('visit.nursing.addPreset')}</Button>
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
