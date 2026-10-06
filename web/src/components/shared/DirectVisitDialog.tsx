import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Stethoscope } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { toLocalInput } from '@/lib/format';
import { Button, Checkbox, Dialog, Field, Input, Select } from '@/components/ui';
import { useDoctors, useVisitTypes } from './VisitQueueForm';

/** Opens a visit straight with the doctor (no queue number), optionally dated in the past. */
export function DirectVisitDialog({ patient, onClose }: { patient: { id: string; fullName: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const nav = useNavigate();
  const doctors = useDoctors();
  const types = useVisitTypes();
  const isDoctor = me?.user.staffType === 'DOCTOR';
  const [v, setV] = useState({ doctorId: isDoctor ? me!.user.id : '', visitTypeId: '', chiefComplaint: '', past: false, visitedAt: toLocalInput(new Date()) });
  const save = useApiMutation(
    () => api.post<{ id: string }>('/visits/direct', {
      patientId: patient.id,
      doctorId: v.doctorId || null,
      visitTypeId: v.visitTypeId || null,
      chiefComplaint: v.chiefComplaint || null,
      visitedAt: v.past && v.visitedAt ? new Date(v.visitedAt).toISOString() : null,
    }),
    { invalidate: [['queue'], ['patient'], ['timeline']], success: t('visit.direct.opened'), onSuccess: (r) => { onClose(); nav(`/visits/${r.id}`); } },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('visit.direct.title')}
      subtitle={patient.fullName}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button icon={<Stethoscope className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('visit.direct.open')}</Button></>}
    >
      <p className="mb-4 rounded-xl bg-primary-50 px-3 py-2 text-xs leading-relaxed text-primary-800">{t('visit.direct.hint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('reception.doctor')} required error={save.fieldErrors.doctorId}>
          <Select value={v.doctorId} onChange={(e) => setV({ ...v, doctorId: e.target.value })} placeholder={t('visit.direct.chooseDoctor')}>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.fullName}{d.specialty ? ` — ${d.specialty}` : ''}</option>)}
          </Select>
        </Field>
        <Field label={t('reception.visitType')}>
          <Select value={v.visitTypeId} onChange={(e) => setV({ ...v, visitTypeId: e.target.value })} placeholder={t('common.select')}>
            {types.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label={t('reception.complaint')} className="sm:col-span-2">
          <Input value={v.chiefComplaint} onChange={(e) => setV({ ...v, chiefComplaint: e.target.value })} />
        </Field>
        <Checkbox className="sm:col-span-2" label={t('visit.direct.past')} checked={v.past} onChange={(e) => setV({ ...v, past: e.target.checked })} />
        {v.past && (
          <Field label={t('visit.direct.when')} error={save.fieldErrors.visitedAt}>
            <Input type="datetime-local" value={v.visitedAt} max={toLocalInput(new Date())} onChange={(e) => setV({ ...v, visitedAt: e.target.value })} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
