import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import type { Patient, PatientLite } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';

type Values = {
  fullName: string; phone: string; altPhone: string; gender: string; dateOfBirth: string; nationality: string; nationalId: string; address: string;
  bloodType: string; emergencyContactName: string; emergencyContactPhone: string; emergencyContactRelation: string; notes: string; familyHistory: string;
};

const toValues = (p?: Partial<Patient>, phone?: string): Values => ({
  fullName: p?.fullName ?? '', phone: p?.phone ?? phone ?? '', altPhone: p?.altPhone ?? '', gender: p?.gender ?? '', dateOfBirth: p?.dateOfBirth?.slice(0, 10) ?? '',
  nationality: p?.nationality ?? 'أردني', nationalId: p?.nationalId ?? '', address: p?.address ?? '', bloodType: p?.bloodType ?? '',
  emergencyContactName: p?.emergencyContactName ?? '', emergencyContactPhone: p?.emergencyContactPhone ?? '', emergencyContactRelation: p?.emergencyContactRelation ?? '',
  notes: p?.notes ?? '', familyHistory: p?.familyHistory ?? '',
});

/** Create / edit patient. Handles the duplicate-patient response from the API. */
export function PatientFormDialog({ open, onClose, patient, initialPhone, onSaved }: { open: boolean; onClose: () => void; patient?: Patient; initialPhone?: string; onSaved?: (p: PatientLite) => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useAuth();
  const [v, setV] = useState<Values>(() => toValues(patient, initialPhone));
  const [dups, setDups] = useState<{ list: PatientLite[]; hard: boolean } | null>(null);
  const [showMore, setShowMore] = useState(!!patient);
  const set = (k: keyof Values) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));

  const save = useApiMutation(
    (force: boolean) => {
      const body = { ...v, dateOfBirth: v.dateOfBirth || null, ...(patient ? {} : { force }) };
      if (!can('medical.history.manage')) delete (body as Partial<Values>).familyHistory;
      return patient ? api.put<PatientLite>(`/patients/${patient.id}`, body) : api.post<PatientLite>('/patients', body);
    },
    {
      invalidate: [['patients'], ['patient']],
      success: patient ? t('common.updated') : false,
      onSuccess: (p) => {
        if (!patient) toast.success(t('patients.created', { file: p.fileNumber }));
        onSaved?.(p);
        onClose();
      },
      onError: (e: ApiError) => {
        if (e.code === 'DUPLICATE_PATIENT' && e.details) {
          const d = e.details as { duplicates: PatientLite[]; hard?: boolean };
          setDups({ list: d.duplicates ?? [], hard: !!d.hard });
        } else if (e.code !== 'VALIDATION') toast.error(e.message);
      },
    },
  );
  const fe = save.fieldErrors;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        size="lg"
        title={patient ? t('patients.edit') : t('patients.new')}
        subtitle={patient ? `${t('patients.fileNumber')}: ${patient.fileNumber}` : undefined}
        footer={
          <>
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button loading={save.isPending} onClick={() => save.mutate(false)}>{t('common.save')}</Button>
          </>
        }
      >
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(false); }}>
          <Field label={t('patients.fullName')} required error={fe.fullName} className="sm:col-span-2">
            <Input value={v.fullName} onChange={set('fullName')} invalid={!!fe.fullName} autoComplete="off" />
          </Field>
          <Field label={t('patients.phone')} required error={fe.phone}>
            <Input value={v.phone} onChange={set('phone')} inputMode="tel" dir="ltr" className="text-end" invalid={!!fe.phone} placeholder="07XXXXXXXX" />
          </Field>
          <Field label={t('patients.gender')} required error={fe.gender}>
            <Select value={v.gender} onChange={set('gender')} placeholder={t('common.select')} invalid={!!fe.gender}>
              <option value="MALE">{t('enum.Gender.MALE')}</option>
              <option value="FEMALE">{t('enum.Gender.FEMALE')}</option>
            </Select>
          </Field>
          <Field label={t('patients.dateOfBirth')} error={fe.dateOfBirth}>
            <Input type="date" value={v.dateOfBirth} onChange={set('dateOfBirth')} max={new Date().toISOString().slice(0, 10)} />
          </Field>
          <Field label={t('patients.nationalId')} error={fe.nationalId}>
            <Input value={v.nationalId} onChange={set('nationalId')} inputMode="numeric" dir="ltr" className="text-end" />
          </Field>
          {!showMore && (
            <button type="button" className="text-start text-xs font-semibold text-primary-700 hover:underline sm:col-span-2" onClick={() => setShowMore(true)}>
              + {t('common.more')}
            </button>
          )}
          {showMore && (
            <>
              <Field label={t('patients.altPhone')} error={fe.altPhone}><Input value={v.altPhone} onChange={set('altPhone')} dir="ltr" className="text-end" /></Field>
              <Field label={t('patients.nationality')}><Input value={v.nationality} onChange={set('nationality')} /></Field>
              <Field label={t('patients.bloodType')}>
                <Select value={v.bloodType} onChange={set('bloodType')} placeholder={t('common.unknown')}>
                  {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </Field>
              <Field label={t('patients.address')}><Input value={v.address} onChange={set('address')} /></Field>
              <Field label={t('patients.emergencyContactName')}><Input value={v.emergencyContactName} onChange={set('emergencyContactName')} /></Field>
              <Field label={t('patients.emergencyContactPhone')} error={fe.emergencyContactPhone}><Input value={v.emergencyContactPhone} onChange={set('emergencyContactPhone')} dir="ltr" className="text-end" /></Field>
              <Field label={t('patients.emergencyContactRelation')}><Input value={v.emergencyContactRelation} onChange={set('emergencyContactRelation')} /></Field>
              <Field label={t('patients.notes')} className="sm:col-span-2"><Textarea value={v.notes} onChange={set('notes')} rows={2} /></Field>
              {can('medical.history.manage') && (
                <Field label={t('patients.familyHistory')} className="sm:col-span-2"><Textarea value={v.familyHistory} onChange={set('familyHistory')} rows={2} /></Field>
              )}
            </>
          )}
          <button type="submit" className="hidden" />
        </form>
      </Dialog>

      <Dialog
        open={!!dups}
        onClose={() => setDups(null)}
        size="sm"
        title={t('patients.duplicateTitle')}
        footer={
          !dups?.hard && (
            <Button variant="outline" loading={save.isPending} onClick={() => { setDups(null); save.mutate(true); }}>
              {t('patients.createAnyway')}
            </Button>
          )
        }
      >
        <p className="mb-3 text-sm text-ink-soft">{dups?.hard ? (save.error as Error | null)?.message : t('patients.duplicateMessage')}</p>
        <div className="space-y-2">
          {dups?.list.map((p) => (
            <button key={p.id} onClick={() => { setDups(null); onClose(); nav(`/patients/${p.id}`); }} className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-start hover:border-primary-300 hover:bg-primary-50/50">
              <UserRound className="h-5 w-5 text-primary-600" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{p.fullName}</span>
                <span className="block text-xs text-ink-muted" dir="ltr">{p.phone} · #{p.fileNumber}</span>
              </span>
              <span className="text-xs font-semibold text-primary-700">{t('patients.openExisting')}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </>
  );
}
