import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ListPlus } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import type { NamedItem, PatientLite, Priority, UserLite } from '@/lib/types';
import { Button, Field, Input, Select } from '@/components/ui';

export const useDoctors = () => useQuery({ queryKey: ['users', 'lookup', 'DOCTOR'], queryFn: () => api.get<UserLite[]>('/users/lookup', { staffType: 'DOCTOR' }), staleTime: 5 * 60_000 });
export const useVisitTypes = () => useQuery({ queryKey: ['catalog', 'visit-types'], queryFn: () => api.get<(NamedItem & { durationMin: number; color: string | null })[]>('/settings/visit-types'), staleTime: 5 * 60_000 });

/** Adds a registered patient to today's queue (creates the visit). */
export function VisitQueueForm({ patient, onDone }: { patient: PatientLite; onDone?: () => void }) {
  const { t } = useTranslation();
  const doctors = useDoctors();
  const types = useVisitTypes();
  const [v, setV] = useState({ doctorId: '', visitTypeId: '', priority: 'NORMAL' as Priority, chiefComplaint: '' });
  const create = useApiMutation(
    () => api.post<{ queueNumber: number }>('/visits', { patientId: patient.id, doctorId: v.doctorId || null, visitTypeId: v.visitTypeId || null, priority: v.priority, chiefComplaint: v.chiefComplaint || null }),
    {
      invalidate: [['queue'], ['dashboard']],
      success: false,
      onSuccess: (r) => {
        toast.success(t('reception.addedToQueue', { name: patient.fullName, number: r.queueNumber }));
        setV({ doctorId: '', visitTypeId: '', priority: 'NORMAL', chiefComplaint: '' });
        onDone?.();
      },
    },
  );
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
      <Field label={t('reception.doctor')}>
        <Select value={v.doctorId} onChange={(e) => setV({ ...v, doctorId: e.target.value })}>
          <option value="">{t('reception.anyDoctor')}</option>
          {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}{d.specialty ? ` — ${d.specialty}` : ''}</option>)}
        </Select>
      </Field>
      <Field label={t('reception.visitType')}>
        <Select value={v.visitTypeId} onChange={(e) => setV({ ...v, visitTypeId: e.target.value })} placeholder={t('common.select')}>
          {types.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <Field label={t('reception.priority')} className="sm:col-span-2">
        <div className="grid grid-cols-3 gap-2">
          {(['NORMAL', 'URGENT', 'EMERGENCY'] as Priority[]).map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => setV({ ...v, priority: p })}
              className={clsx(
                'h-10 rounded-xl border text-sm font-semibold transition',
                v.priority === p
                  ? p === 'EMERGENCY' ? 'border-danger-600 bg-danger-50 text-danger-700' : p === 'URGENT' ? 'border-warning-600 bg-warning-50 text-warning-700' : 'border-primary-500 bg-primary-50 text-primary-800'
                  : 'border-line-strong bg-white text-ink-soft hover:bg-surface-subtle',
              )}
            >
              {t(`enum.Priority.${p}`)}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('reception.complaint')} className="sm:col-span-2">
        <Input value={v.chiefComplaint} onChange={(e) => setV({ ...v, chiefComplaint: e.target.value })} />
      </Field>
      <Button type="submit" size="lg" className="sm:col-span-2" loading={create.isPending} icon={<ListPlus className="h-5 w-5" />}>
        {t('reception.addToQueue')}
      </Button>
    </form>
  );
}
