import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Printer, Trash2, X } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import type { RxItem, TimelineVisit } from '@/lib/clinical';
import { Badge, Button, Card, CardHeader, Checkbox, DataTable, Dialog, EmptyState, Field, IconButton, Input, PageLoader, Pagination, Select, Textarea, useConfirm } from '@/components/ui';
import { Autocomplete } from '@/components/shared/Autocomplete';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { VitalsStrip } from '@/components/shared/VitalsStrip';
import { VisitTimelineItem } from '@/components/shared/VisitTimeline';
import type { VisitDetail } from './VisitWorkspace';

interface TabProps { visit: VisitDetail; onSaved: () => void; readOnly: boolean }

// ── Consultation + diagnoses ──
export function ConsultationTab({ visit, onSaved, readOnly }: TabProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const c = visit.consultation;
  const [v, setV] = useState({
    chiefComplaint: c?.chiefComplaint ?? visit.chiefComplaint ?? '', presentIllness: c?.presentIllness ?? '', examination: c?.examination ?? '',
    clinicalNotes: c?.clinicalNotes ?? '', treatmentPlan: c?.treatmentPlan ?? '', followUpDate: c?.followUpDate?.slice(0, 10) ?? '',
  });
  const save = useApiMutation(() => api.put(`/visits/${visit.id}/consultation`, { ...v, followUpDate: v.followUpDate || null }), { onSuccess: onSaved });
  const [dx, setDx] = useState({ icd10Code: '', description: '', type: 'PRIMARY' });
  const addDx = useApiMutation(() => api.post(`/visits/${visit.id}/diagnoses`, dx), { success: t('common.created'), onSuccess: () => { setDx({ icd10Code: '', description: '', type: 'SECONDARY' }); onSaved(); } });
  const delDx = useApiMutation((id: string) => api.del(`/diagnoses/${id}`), { success: t('common.done'), onSuccess: onSaved });
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }), disabled: readOnly });

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('visit.chiefComplaint')} className="md:col-span-2"><Input {...f('chiefComplaint')} /></Field>
          <Field label={t('visit.presentIllness')}><Textarea rows={4} {...f('presentIllness')} /></Field>
          <Field label={t('visit.examination')}><Textarea rows={4} {...f('examination')} /></Field>
          <Field label={t('visit.clinicalNotes')}><Textarea rows={4} {...f('clinicalNotes')} /></Field>
          <Field label={t('visit.treatmentPlan')}><Textarea rows={4} {...f('treatmentPlan')} /></Field>
          <Field label={t('visit.followUpDate')}><Input type="date" {...f('followUpDate')} /></Field>
        </div>
        {!readOnly && <div className="mt-4 flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('visit.saveConsultation')}</Button></div>}
      </Card>
      <Card>
        <CardHeader title={t('visit.diagnoses')} />
        {visit.diagnoses?.length ? (
          <ul className="mb-4 space-y-2">
            {visit.diagnoses.map((d) => (
              <li key={d.id} className="flex items-center gap-2 rounded-xl border border-line p-2.5">
                <Badge tone={d.type === 'PRIMARY' ? 'primary' : 'neutral'} dot={false}>{t(`enum.DiagnosisType.${d.type}`)}</Badge>
                {d.icd10Code && <span className="font-mono text-xs font-bold text-primary-700" dir="ltr">{d.icd10Code}</span>}
                <span className="flex-1 text-sm font-semibold">{d.description}</span>
                {!readOnly && <IconButton size="sm" label={t('common.remove')} onClick={async () => (await confirm({ message: d.description, danger: true })) && delDx.mutate(d.id)}><X className="h-4 w-4 text-danger-600" /></IconButton>}
              </li>
            ))}
          </ul>
        ) : <p className="mb-4 text-sm text-ink-muted">{t('visit.noDiagnoses')}</p>}
        {!readOnly && (
          <div className="grid gap-2 md:grid-cols-[1fr_140px_auto]">
            <Autocomplete<{ code: string; name: string; nameAr: string | null }>
              value={dx.description}
              onChange={(s) => setDx({ ...dx, description: s, icd10Code: '' })}
              onPick={(d) => setDx({ ...dx, icd10Code: d.code, description: d.nameAr ? `${d.nameAr} (${d.name})` : d.name })}
              fetcher={(q) => api.get('/settings/diagnosis-codes', { q, limit: 15 })}
              queryKey="icd"
              placeholder={t('visit.icdSearch')}
              render={(d) => <span className="flex gap-2"><b className="font-mono text-primary-700" dir="ltr">{d.code}</b><span>{d.nameAr ?? ''}</span><span className="text-ink-muted" dir="ltr">{d.name}</span></span>}
            />
            <Select value={dx.type} onChange={(e) => setDx({ ...dx, type: e.target.value })}>
              {['PRIMARY', 'SECONDARY', 'DIFFERENTIAL'].map((x) => <option key={x} value={x}>{t(`enum.DiagnosisType.${x}`)}</option>)}
            </Select>
            <Button icon={<Plus className="h-4 w-4" />} loading={addDx.isPending} disabled={dx.description.trim().length < 2} onClick={() => addDx.mutate(undefined)}>{t('visit.addDiagnosis')}</Button>
            {dx.icd10Code && <span className="text-xs text-ink-muted md:col-span-3">ICD-10: <b dir="ltr">{dx.icd10Code}</b></span>}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Vital signs ──
const VITAL_FIELDS = [
  ['bpSystolic', 'visit.vitals.systolic', 'mmHg'], ['bpDiastolic', 'visit.vitals.diastolic', 'mmHg'], ['heartRate', 'visit.vitals.hr', 'bpm'],
  ['temperature', 'visit.vitals.temp', '°C'], ['oxygenSaturation', 'visit.vitals.spo2', '%'], ['respiratoryRate', 'visit.vitals.rr', '/min'],
  ['weightKg', 'visit.vitals.weight', 'kg'], ['heightCm', 'visit.vitals.height', 'cm'], ['bloodGlucose', 'visit.vitals.glucose', 'mg/dL'], ['painScore', 'visit.vitals.pain', '0-10'],
] as const;

export function VitalsTab({ visit, onSaved, readOnly }: TabProps) {
  const { t } = useTranslation();
  const empty = Object.fromEntries([...VITAL_FIELDS.map(([k]) => [k, '']), ['notes', '']]) as Record<string, string>;
  const [v, setV] = useState(empty);
  const bmi = Number(v.weightKg) > 0 && Number(v.heightCm) > 0 ? (Number(v.weightKg) / (Number(v.heightCm) / 100) ** 2).toFixed(1) : null;
  const save = useApiMutation(() => api.post(`/visits/${visit.id}/vitals`, v), { success: t('visit.vitals.recorded'), onSuccess: () => { setV(empty); onSaved(); } });
  return (
    <div className="space-y-4">
      {!readOnly && (
        <Card>
          <CardHeader title={t('visit.vitals.record')} />
          <form onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {VITAL_FIELDS.map(([k, label, unit]) => (
                <Field key={k} label={<>{t(label)} <span className="font-normal text-ink-muted" dir="ltr">({unit})</span></>} error={save.fieldErrors[k]}>
                  <Input type="number" step="any" inputMode="decimal" dir="ltr" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} invalid={!!save.fieldErrors[k]} />
                </Field>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label={t('common.notes')} className="min-w-[200px] flex-1"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
              {bmi && <Badge tone="info" className="h-10 !px-4 !text-sm">BMI {bmi}</Badge>}
              <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
            </div>
            {save.fieldErrors._ && <p className="mt-2 text-xs text-danger-600">{save.fieldErrors._}</p>}
          </form>
        </Card>
      )}
      <Card>
        <CardHeader title={t('visit.vitals.history')} />
        {!visit.vitalSigns?.length ? <EmptyState title={t('visit.vitals.none')} className="!py-4" /> : (
          <ul className="space-y-3">
            {visit.vitalSigns.map((x) => (
              <li key={x.id}>
                <p className="mb-1.5 text-xs text-ink-muted">{fmtDateTime(x.recordedAt)}{x.notes && ` — ${x.notes}`}</p>
                <VitalsStrip v={x} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ── Nursing procedures ──
const NURSING_PRESETS = ['حقنة عضل', 'حقنة وريد', 'تركيب كانيولا', 'تركيب محلول وريدي', 'جلسة بخار', 'غيار جرح', 'قياس سكر', 'تخطيط قلب ECG', 'سحب عينة دم'];

export function NursingTab({ visit, onSaved, readOnly }: TabProps) {
  const { t } = useTranslation();
  const [v, setV] = useState({ procedure: '', notes: '' });
  const save = useApiMutation(() => api.post(`/visits/${visit.id}/nursing-notes`, v), { success: t('common.created'), onSuccess: () => { setV({ procedure: '', notes: '' }); onSaved(); } });
  return (
    <Card>
      {!readOnly && (
        <div className="mb-5 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-ink-muted">{t('visit.nursing.presets')}:</span>
            {NURSING_PRESETS.map((p) => <button key={p} onClick={() => setV({ ...v, procedure: p })} className="rounded-full bg-surface-sunken px-2.5 py-1 text-xs hover:bg-primary-100">{p}</button>)}
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
            <Input placeholder={t('visit.nursing.procedure')} value={v.procedure} onChange={(e) => setV({ ...v, procedure: e.target.value })} />
            <Input placeholder={t('common.notes')} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
            <Button loading={save.isPending} disabled={v.procedure.trim().length < 2} onClick={() => save.mutate(undefined)}>{t('visit.nursing.add')}</Button>
          </div>
        </div>
      )}
      {!visit.nursingNotes?.length ? <EmptyState title={t('visit.nursing.none')} className="!py-4" /> : (
        <ul className="divide-y divide-line">
          {visit.nursingNotes.map((n) => (
            <li key={n.id} className="flex gap-3 py-2.5 text-sm">
              <span className="w-32 shrink-0 text-xs tabular-nums text-ink-muted">{fmtDateTime(n.performedAt)}</span>
              <span><b>{n.procedure}</b>{n.notes && <span className="text-ink-soft"> — {n.notes}</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Prescriptions ──
interface Drug { id: string; name: string; genericName: string | null; strength: string | null; defaultDose: string | null; defaultFrequency: string | null; defaultRoute: string | null }
const emptyItem = (): RxItem => ({ drugName: '', dose: '', frequency: '', duration: '', route: '', instructions: '', drugId: null });

export function PrescriptionTab({ visit, onSaved, readOnly }: TabProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ id?: string; notes: string; items: RxItem[] } | null>(null);
  const allergies = visit.patient.allergies ?? [];
  const save = useApiMutation(
    () => {
      const body = { notes: editing!.notes || null, items: editing!.items.filter((i) => i.drugName.trim()) };
      return editing!.id ? api.put(`/prescriptions/${editing!.id}`, body) : api.post(`/visits/${visit.id}/prescriptions`, body);
    },
    { onSuccess: () => { setEditing(null); onSaved(); } },
  );
  const setItem = (i: number, patch: Partial<RxItem>) => setEditing((e) => e && { ...e, items: e.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const allergyHit = (name: string) => allergies.find((a) => name && name.toLowerCase().includes(a.allergen.toLowerCase()));

  return (
    <div className="space-y-4">
      {!readOnly && !editing && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ notes: '', items: [emptyItem()] })}>{t('visit.rx.new')}</Button>}
      {editing && (
        <Card>
          <CardHeader title={editing.id ? t('common.edit') : t('visit.rx.new')} />
          <div className="space-y-3">
            {editing.items.map((it, i) => (
              <div key={i} className="rounded-xl border border-line p-3">
                <div className="grid gap-2 md:grid-cols-6">
                  <div className="md:col-span-2">
                    <Autocomplete<Drug>
                      value={it.drugName}
                      dir="ltr"
                      onChange={(s) => setItem(i, { drugName: s, drugId: null })}
                      onPick={(d) => setItem(i, { drugName: d.name, drugId: d.id, dose: it.dose || d.defaultDose, frequency: it.frequency || d.defaultFrequency, route: it.route || d.defaultRoute })}
                      fetcher={(q) => api.get('/settings/drugs', { q, limit: 12 })}
                      queryKey="drugs"
                      placeholder={t('visit.rx.drugSearch')}
                      render={(d) => <span dir="ltr"><b>{d.name}</b> <span className="text-ink-muted">{d.genericName}</span></span>}
                    />
                  </div>
                  <Input placeholder={t('visit.rx.dose')} value={it.dose ?? ''} onChange={(e) => setItem(i, { dose: e.target.value })} />
                  <Input placeholder={t('visit.rx.frequency')} value={it.frequency ?? ''} onChange={(e) => setItem(i, { frequency: e.target.value })} />
                  <Input placeholder={t('visit.rx.duration')} value={it.duration ?? ''} onChange={(e) => setItem(i, { duration: e.target.value })} />
                  <Input placeholder={t('visit.rx.route')} value={it.route ?? ''} onChange={(e) => setItem(i, { route: e.target.value })} />
                  <Input placeholder={t('visit.rx.instructions')} value={it.instructions ?? ''} onChange={(e) => setItem(i, { instructions: e.target.value })} className="md:col-span-5" />
                  <Button variant="ghost" icon={<Trash2 className="h-4 w-4 text-danger-600" />} disabled={editing.items.length === 1} onClick={() => setEditing({ ...editing, items: editing.items.filter((_, j) => j !== i) })}>{t('common.remove')}</Button>
                </div>
                {allergyHit(it.drugName) && <p className="mt-2 text-xs font-semibold text-danger-700">⚠ {t('visit.rx.allergyWarning')} {allergyHit(it.drugName)!.allergen}</p>}
              </div>
            ))}
            <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ ...editing, items: [...editing.items, emptyItem()] })}>{t('visit.rx.addDrug')}</Button>
            <Field label={t('common.notes')}><Textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
            {save.fieldErrors.items && <p className="text-xs text-danger-600">{save.fieldErrors.items}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
              <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('visit.rx.save')}</Button>
            </div>
          </div>
        </Card>
      )}
      {!visit.prescriptions?.length && !editing ? <Card><EmptyState title={t('visit.rx.none')} /></Card> : visit.prescriptions?.map((rx) => (
        <Card key={rx.id}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-ink-muted">{fmtDateTime(rx.createdAt)}</span>
            <div className="flex gap-1">
              {!readOnly && <IconButton label={t('common.edit')} onClick={() => setEditing({ id: rx.id, notes: rx.notes ?? '', items: rx.items.map((i) => ({ ...i })) })}><Pencil className="h-4 w-4" /></IconButton>}
              <IconButton label={t('visit.rx.print')} onClick={() => window.open(`/print/prescription/${rx.id}`, '_blank')}><Printer className="h-4 w-4" /></IconButton>
            </div>
          </div>
          <DataTable
            rows={rx.items}
            rowKey={(r) => r.id ?? r.drugName}
            dense
            columns={[
              { key: 'd', header: t('visit.rx.drug'), cell: (r) => <b dir="ltr">{r.drugName}</b> },
              { key: 'dose', header: t('visit.rx.dose'), cell: (r) => r.dose ?? '—' },
              { key: 'f', header: t('visit.rx.frequency'), cell: (r) => r.frequency ?? '—' },
              { key: 'du', header: t('visit.rx.duration'), cell: (r) => r.duration ?? '—' },
              { key: 'r', header: t('visit.rx.route'), cell: (r) => r.route ?? '—' },
              { key: 'i', header: t('visit.rx.instructions'), cell: (r) => r.instructions ?? '' },
            ]}
          />
          {rx.notes && <p className="mt-2 text-sm text-ink-soft">{rx.notes}</p>}
        </Card>
      ))}
    </div>
  );
}

// ── Lab orders ──
interface LabTest { id: string; code: string; name: string; category: string | null; service: { price: number } | null }

export function LabTab({ visit, onSaved, readOnly }: TabProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const tests = useQuery({ queryKey: ['catalog', 'lab-tests'], queryFn: () => api.get<LabTest[]>('/settings/lab-tests'), enabled: open });
  const order = useApiMutation(() => api.post('/lab/orders', { visitId: visit.id, patientId: visit.patient.id, testIds: sel, clinicalNotes: notes || null, priority }), {
    success: t('visit.lab.ordered'),
    invalidate: [['lab']],
    onSuccess: () => { setOpen(false); setSel([]); setNotes(''); onSaved(); },
  });
  return (
    <div className="space-y-4">
      {!readOnly && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('visit.lab.order')}</Button>}
      {!visit.labOrders?.length ? <Card><EmptyState title={t('visit.lab.none')} /></Card> : visit.labOrders.map((o) => (
        <Card key={o.id}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <a href={`/lab/${o.id}`} className="font-mono text-sm font-bold text-primary-700 hover:underline">{o.orderNumber}</a>
            <StatusBadge enumName="LabOrderStatus" value={o.status} />
            {o.priority !== 'NORMAL' && <StatusBadge enumName="Priority" value={o.priority} dot={false} />}
            <span className="text-xs text-ink-muted">{fmtDateTime(o.requestedAt)}</span>
            <IconButton className="ms-auto" label={t('common.print')} onClick={() => window.open(`/print/lab/${o.id}${o.status === 'COMPLETED' ? '?mode=result' : ''}`, '_blank')}><Printer className="h-4 w-4" /></IconButton>
          </div>
          <ul className="space-y-2">
            {o.items.map((i) => (
              <li key={i.id} className="rounded-xl bg-surface-subtle p-2.5 text-sm">
                <b>{i.testName}</b>
                {i.results.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {i.results.map((r) => (
                      <span key={r.id} className={r.flag && r.flag !== 'NORMAL' ? 'font-bold text-danger-700' : ''} dir="ltr">
                        {r.parameterName}: {r.value} {r.unit} {r.referenceRange && <span className="text-ink-muted">({r.referenceRange})</span>}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={t('visit.lab.order')}
        footer={<><Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button disabled={!sel.length} loading={order.isPending} onClick={() => order.mutate(undefined)}>{t('visit.lab.order')} ({sel.length})</Button></>}
      >
        {!tests.data ? <PageLoader /> : (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {tests.data.map((x) => (
                <label key={x.id} className={`flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 ${sel.includes(x.id) ? 'border-primary-400 bg-primary-50' : 'border-line'}`}>
                  <Checkbox label="" checked={sel.includes(x.id)} onChange={(e) => setSel(e.target.checked ? [...sel, x.id] : sel.filter((s) => s !== x.id))} />
                  <span className="flex-1 text-sm font-semibold">{x.name}</span>
                  <span className="font-mono text-[11px] text-ink-muted">{x.code}</span>
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
              <Field label={t('visit.lab.clinicalNotes')}><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              <Field label={t('reception.priority')}>
                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>{['NORMAL', 'URGENT', 'EMERGENCY'].map((p) => <option key={p} value={p}>{t(`enum.Priority.${p}`)}</option>)}</Select>
              </Field>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ── Medical report ──
export function ReportTab({ visit, onSaved, readOnly }: TabProps) {
  const { t } = useTranslation();
  const [edit, setEdit] = useState<{ id?: string; title: string; content: string } | null>(null);
  const save = useApiMutation(
    () => (edit!.id ? api.put(`/medical-reports/${edit!.id}`, edit) : api.post(`/visits/${visit.id}/reports`, edit)),
    { onSuccess: () => { setEdit(null); onSaved(); } },
  );
  const summary = () => {
    const c = visit.consultation;
    const lines = [
      c?.chiefComplaint && `${t('visit.chiefComplaint')}: ${c.chiefComplaint}`,
      c?.examination && `${t('visit.examination')}: ${c.examination}`,
      visit.diagnoses?.length && `${t('visit.diagnoses')}: ${visit.diagnoses.map((d) => `${d.description}${d.icd10Code ? ` (${d.icd10Code})` : ''}`).join('، ')}`,
      c?.treatmentPlan && `${t('visit.treatmentPlan')}: ${c.treatmentPlan}`,
    ].filter(Boolean);
    return lines.join('\n');
  };
  return (
    <div className="space-y-4">
      {!readOnly && !edit && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ title: t('visit.report.defaultTitle'), content: '' })}>{t('visit.report.new')}</Button>}
      {edit && (
        <Card>
          <div className="space-y-3">
            <Field label={t('visit.report.titleLabel')} error={save.fieldErrors.title}><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label={t('visit.report.content')} error={save.fieldErrors.content}><Textarea rows={10} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} /></Field>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEdit({ ...edit, content: `${edit.content}${edit.content ? '\n' : ''}${summary()}` })}>{t('visit.report.template')}</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
                <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button>
              </div>
            </div>
          </div>
        </Card>
      )}
      {!visit.medicalReports?.length && !edit ? <Card><EmptyState title={t('visit.report.none')} /></Card> : visit.medicalReports?.map((r) => (
        <Card key={r.id}>
          <CardHeader
            title={r.title}
            subtitle={fmtDateTime(r.createdAt)}
            actions={
              <>
                {!readOnly && <IconButton label={t('common.edit')} onClick={() => setEdit({ id: r.id, title: r.title, content: r.content })}><Pencil className="h-4 w-4" /></IconButton>}
                <IconButton label={t('common.print')} onClick={() => window.open(`/print/medical-report/${r.id}`, '_blank')}><Printer className="h-4 w-4" /></IconButton>
              </>
            }
          />
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{r.content}</p>
        </Card>
      ))}
    </div>
  );
}

// ── Previous visits ──
export function HistoryTab({ patientId, currentVisitId }: { patientId: string; currentVisitId: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['timeline', patientId, page], queryFn: () => api.get<Paged<TimelineVisit>>(`/patients/${patientId}/timeline`, { page }) });
  if (!q.data) return <PageLoader />;
  const items = q.data.items.filter((v) => v.id !== currentVisitId);
  if (!items.length) return <Card><EmptyState title={t('patients.noVisits')} /></Card>;
  return (
    <div>
      <ol className="relative space-y-4 before:absolute before:bottom-2 before:start-[6px] before:top-2 before:w-0.5 before:bg-primary-100">
        {items.map((v) => <VisitTimelineItem key={v.id} v={v} />)}
      </ol>
      <Pagination {...q.data} onPage={setPage} />
    </div>
  );
}
