import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Archive, ArrowRight, CalendarPlus, FilePlus2, ListPlus, Pencil, Plus, Printer, Trash2, UserRound } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import type { Patient } from '@/lib/types';
import type { TimelineVisit } from '@/lib/clinical';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, IconButton, Input, PageLoader, Pagination, Select, Tabs, Textarea, useConfirm } from '@/components/ui';
import { PatientFormDialog } from '@/components/shared/PatientForm';
import { VisitQueueForm } from '@/components/shared/VisitQueueForm';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { VisitTimelineItem } from '@/components/shared/VisitTimeline';
import { AttachmentsPanel } from '@/components/shared/Attachments';

type Tab = 'overview' | 'history' | 'timeline' | 'labs' | 'invoices' | 'attachments' | 'reports';

export default function PatientProfile() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const q = useQuery({ queryKey: ['patient', id], queryFn: () => api.get<Patient>(`/patients/${id}`) });
  const archive = useApiMutation(() => api.del(`/patients/${id}`), { invalidate: [['patients']], success: t('patients.archived'), onSuccess: () => nav('/patients') });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  const medical = p.canViewMedical;

  const tabs = [
    { key: 'overview' as const, label: t('patients.tabs.overview') },
    { key: 'history' as const, label: t('patients.tabs.history'), hidden: !medical },
    { key: 'timeline' as const, label: t('patients.tabs.timeline') },
    { key: 'labs' as const, label: t('patients.tabs.labs'), hidden: !can('lab.view') },
    { key: 'reports' as const, label: t('patients.tabs.reports'), hidden: !medical },
    { key: 'invoices' as const, label: t('patients.tabs.invoices'), hidden: !can('invoices.view') },
    { key: 'attachments' as const, label: t('patients.tabs.attachments'), hidden: !can('attachments.view') },
  ];

  return (
    <div>
      <Link to="/patients" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-primary-700 print:hidden"><ArrowRight className="h-3.5 w-3.5 ltr:rotate-180" />{t('patients.title')}</Link>
      <Card className="mb-4">
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-primary-100 to-primary-200 text-primary-800"><UserRound className="h-8 w-8" /></span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold sm:text-2xl">{p.fullName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
              <span className="font-mono">#{p.fileNumber}</span>
              <span dir="ltr">{p.phone}</span>
              <span>{t(`enum.Gender.${p.gender}`)}</span>
              {p.age != null && <span>{t('common.yearsOld', { age: p.age })}</span>}
              {p.bloodType && <Badge tone="danger" dot={false}>{p.bloodType}</Badge>}
            </div>
            {medical && p.allergies && p.allergies.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-danger-600" />
                {p.allergies.map((a) => <Badge key={a.id} tone="danger" dot={false}>{a.allergen}</Badge>)}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            {can('queue.manage') && <Button icon={<ListPlus className="h-4 w-4" />} onClick={() => setQueueing(true)}>{t('patients.addToQueue')}</Button>}
            {can('appointments.manage') && <Button variant="outline" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => nav(`/appointments?patientId=${p.id}&new=1`)}>{t('patients.bookAppointment')}</Button>}
            {can('invoices.create') && <Button variant="outline" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => nav(`/billing/invoices/new?patientId=${p.id}`)}>{t('patients.newInvoice')}</Button>}
            {medical && <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/print/patient/${p.id}`, '_blank')}>{t('patients.patientReport')}</Button>}
            {can('patients.update') && <IconButton label={t('common.edit')} variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></IconButton>}
            {can('patients.delete') && (
              <IconButton label={t('common.archive')} variant="outline" onClick={async () => (await confirm({ message: t('patients.archiveConfirm'), danger: true })) && archive.mutate(undefined)}>
                <Archive className="h-4 w-4 text-danger-600" />
              </IconButton>
            )}
          </div>
        </div>
      </Card>

      <Tabs items={tabs} value={tab} onChange={setTab} className="mb-4" />

      {tab === 'overview' && <Overview p={p} />}
      {tab === 'history' && medical && <MedicalHistory p={p} />}
      {tab === 'timeline' && (medical ? <Timeline patientId={p.id} /> : <VisitsBasic patientId={p.id} />)}
      {tab === 'labs' && <PatientLabs patientId={p.id} />}
      {tab === 'reports' && <PatientReports patientId={p.id} />}
      {tab === 'invoices' && <PatientInvoices patientId={p.id} />}
      {tab === 'attachments' && <Card><AttachmentsPanel patientId={p.id} /></Card>}

      {editing && <PatientFormDialog open patient={p} onClose={() => setEditing(false)} />}
      <Dialog open={queueing} onClose={() => setQueueing(false)} title={t('reception.newVisit')} subtitle={p.fullName}>
        <VisitQueueForm patient={p} onDone={() => setQueueing(false)} />
      </Dialog>
    </div>
  );
}

function Overview({ p }: { p: Patient }) {
  const { t } = useTranslation();
  const rows: [string, React.ReactNode][] = [
    [t('patients.nationality'), p.nationality], [t('patients.nationalId'), p.nationalId], [t('patients.dateOfBirth'), fmtDate(p.dateOfBirth)],
    [t('patients.altPhone'), p.altPhone && <span dir="ltr">{p.altPhone}</span>], [t('patients.address'), p.address],
    [t('patients.emergencyContact'), p.emergencyContactName && `${p.emergencyContactName}${p.emergencyContactRelation ? ` (${p.emergencyContactRelation})` : ''} — ${p.emergencyContactPhone ?? ''}`],
    [t('patients.firstVisit'), fmtDate(p.firstVisitAt)], [t('patients.lastVisit'), fmtDate(p.lastVisitAt)], [t('patients.visitCount'), p.visitCount],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title={t('patients.basicInfo')} />
        <dl className="grid gap-4 sm:grid-cols-3">
          {rows.map(([k, v]) => <div key={k}><dt className="text-xs text-ink-muted">{k}</dt><dd className="mt-0.5 text-sm font-semibold">{v || '—'}</dd></div>)}
        </dl>
        {p.notes && <p className="mt-4 rounded-xl bg-surface-subtle p-3 text-sm"><b>{t('patients.notes')}:</b> {p.notes}</p>}
      </Card>
      <div className="space-y-4">
        {p.outstandingBalance != null && (
          <Card>
            <p className="text-xs text-ink-muted">{t('patients.outstanding')}</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums ${Number(p.outstandingBalance) > 0 ? 'text-danger-600' : 'text-success-700'}`}>{money(p.outstandingBalance)}</p>
          </Card>
        )}
        <Card>
          <p className="text-xs text-ink-muted">{t('patients.nextAppointment')}</p>
          <p className="mt-1 font-semibold">{p.nextAppointment ? `${fmtDateTime(p.nextAppointment.startAt)} — ${p.nextAppointment.doctor.fullName}` : '—'}</p>
        </Card>
        {p.canViewMedical && p.histories && (
          <Card>
            <p className="mb-2 text-xs text-ink-muted">{t('patients.chronic')}</p>
            <div className="flex flex-wrap gap-1.5">
              {p.histories.filter((h) => h.type === 'CHRONIC' && h.isActive).map((h) => <Badge key={h.id} tone="warning" dot={false}>{h.name}</Badge>)}
              {!p.histories.some((h) => h.type === 'CHRONIC' && h.isActive) && <span className="text-sm text-ink-muted">—</span>}
            </div>
            {p.medications && p.medications.filter((m) => m.isActive).length > 0 && (
              <>
                <p className="mb-2 mt-3 text-xs text-ink-muted">{t('patients.medications')}</p>
                <ul className="text-sm">{p.medications.filter((m) => m.isActive).map((m) => <li key={m.id} dir="auto">• {m.name} {m.dose ?? ''}</li>)}</ul>
              </>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function MedicalHistory({ p }: { p: Patient }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const editable = can('medical.history.manage');
  const [dialog, setDialog] = useState<null | 'allergies' | 'histories' | 'medications'>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const save = useApiMutation((path: string) => api.post(`/patients/${p.id}/${path}`, form), { invalidate: [['patient', p.id]], success: t('common.created'), onSuccess: () => { setDialog(null); setForm({}); } });
  const del = useApiMutation((path: string) => api.del(`/patients/${p.id}/${path}`), { invalidate: [['patient', p.id]], success: t('common.done') });
  const toggle = useApiMutation((v: { path: string; isActive: boolean }) => api.put(`/patients/${p.id}/${v.path}`, { isActive: v.isActive }), { invalidate: [['patient', p.id]], success: false });
  const remove = async (path: string, label: string) => (await confirm({ message: label, danger: true, confirmLabel: t('common.delete') })) && del.mutate(path);
  const f = (k: string) => ({ value: form[k] ?? '', onChange: (e: { target: { value: string } }) => setForm((x) => ({ ...x, [k]: e.target.value })) });
  const addBtn = (k: 'allergies' | 'histories' | 'medications', label: string) => editable && <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => { setForm(k === 'histories' ? { type: 'CHRONIC' } : k === 'allergies' ? { severity: 'MODERATE' } : {}); setDialog(k); }}>{label}</Button>;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('patients.allergies')} actions={addBtn('allergies', t('patients.addAllergy'))} />
        {!p.allergies?.length ? <EmptyState title={t('patients.noAllergies')} className="!py-4" /> : (
          <ul className="divide-y divide-line">
            {p.allergies.map((a) => (
              <li key={a.id} className="flex items-center gap-2 py-2">
                <span className="flex-1"><b>{a.allergen}</b>{a.reaction && <span className="text-sm text-ink-soft"> — {a.reaction}</span>}</span>
                <StatusBadge enumName="AllergySeverity" value={a.severity} />
                {editable && <IconButton size="sm" label={t('common.delete')} onClick={() => remove(`allergies/${a.id}`, a.allergen)}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title={t('patients.medications')} actions={addBtn('medications', t('patients.addMedication'))} />
        {!p.medications?.length ? <EmptyState className="!py-4" /> : (
          <ul className="divide-y divide-line">
            {p.medications.map((m) => (
              <li key={m.id} className={`flex items-center gap-2 py-2 ${m.isActive ? '' : 'opacity-50'}`}>
                <span className="flex-1"><b dir="auto">{m.name}</b> <span className="text-sm text-ink-soft">{[m.dose, m.frequency].filter(Boolean).join(' · ')}</span></span>
                {editable && <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ path: `medications/${m.id}`, isActive: !m.isActive })}>{m.isActive ? t('common.deactivate') : t('common.activate')}</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title={t('patients.histories')} actions={addBtn('histories', t('patients.addHistory'))} />
        {!p.histories?.length ? <EmptyState className="!py-4" /> : (
          <DataTable
            rows={p.histories}
            rowKey={(r) => r.id}
            dense
            rowClassName={(r) => (r.isActive ? undefined : 'opacity-50')}
            columns={[
              { key: 'type', header: t('common.type'), cell: (r) => <Badge tone={r.type === 'CHRONIC' ? 'warning' : 'neutral'} dot={false}>{t(`enum.HistoryType.${r.type}`)}</Badge> },
              { key: 'name', header: t('patients.historyName'), cell: (r) => <b>{r.name}</b> },
              { key: 'icd', header: 'ICD-10', cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.icd10Code ?? '—'}</span> },
              { key: 'since', header: t('patients.since'), cell: (r) => r.since ?? '—' },
              { key: 'notes', header: t('common.notes'), cell: (r) => <span className="text-xs text-ink-soft">{r.notes ?? ''}</span> },
              ...(editable ? [{ key: 'a', header: '', cell: (r: NonNullable<Patient['histories']>[number]) => <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ path: `histories/${r.id}`, isActive: !r.isActive })}>{r.isActive ? t('common.deactivate') : t('common.activate')}</Button> }] : []),
            ]}
          />
        )}
        {p.familyHistory && <p className="mt-3 rounded-xl bg-surface-subtle p-3 text-sm"><b>{t('patients.familyHistory')}:</b> {p.familyHistory}</p>}
      </Card>

      <Dialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        size="sm"
        title={dialog === 'allergies' ? t('patients.addAllergy') : dialog === 'medications' ? t('patients.addMedication') : t('patients.addHistory')}
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => dialog && save.mutate(dialog)}>{t('common.save')}</Button></>}
      >
        <div className="space-y-3">
          {dialog === 'allergies' && (
            <>
              <Field label={t('patients.allergen')} required error={save.fieldErrors.allergen}><Input {...f('allergen')} /></Field>
              <Field label={t('patients.reaction')}><Input {...f('reaction')} /></Field>
              <Field label={t('patients.severity')}><Select {...f('severity')}>{['MILD', 'MODERATE', 'SEVERE'].map((s) => <option key={s} value={s}>{t(`enum.AllergySeverity.${s}`)}</option>)}</Select></Field>
            </>
          )}
          {dialog === 'medications' && (
            <>
              <Field label={t('patients.medName')} required error={save.fieldErrors.name}><Input {...f('name')} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('patients.dose')}><Input {...f('dose')} /></Field>
                <Field label={t('patients.frequency')}><Input {...f('frequency')} /></Field>
              </div>
            </>
          )}
          {dialog === 'histories' && (
            <>
              <Field label={t('common.type')}><Select {...f('type')}>{['CHRONIC', 'PAST_ILLNESS', 'SURGERY', 'FAMILY', 'OTHER'].map((s) => <option key={s} value={s}>{t(`enum.HistoryType.${s}`)}</option>)}</Select></Field>
              <Field label={t('patients.historyName')} required error={save.fieldErrors.name}><Input {...f('name')} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="ICD-10"><Input {...f('icd10Code')} dir="ltr" /></Field>
                <Field label={t('patients.since')}><Input {...f('since')} /></Field>
              </div>
              <Field label={t('common.notes')}><Textarea {...f('notes')} rows={2} /></Field>
            </>
          )}
        </div>
      </Dialog>
    </div>
  );
}

function Timeline({ patientId }: { patientId: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['timeline', patientId, page], queryFn: () => api.get<Paged<TimelineVisit>>(`/patients/${patientId}/timeline`, { page }) });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoader />;
  if (!q.data.items.length) return <Card><EmptyState title={t('patients.noVisits')} /></Card>;
  return (
    <div>
      <ol className="relative space-y-4 before:absolute before:bottom-2 before:start-[6px] before:top-2 before:w-0.5 before:bg-primary-100">
        {q.data.items.map((v) => <VisitTimelineItem key={v.id} v={v} />)}
      </ol>
      <Pagination {...q.data} onPage={setPage} />
    </div>
  );
}

function VisitsBasic({ patientId }: { patientId: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['patient-visits', patientId, page], queryFn: () => api.get<Paged<{ id: string; visitNumber: string; status: string; arrivedAt: string; doctor: { fullName: string } | null; visitType: { name: string } | null }>>(`/patients/${patientId}/visits`, { page }) });
  return (
    <Card>
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', header: '#', cell: (r) => <span className="font-mono text-xs">{r.visitNumber}</span> },
          { key: 'd', header: t('common.date'), cell: (r) => fmtDateTime(r.arrivedAt) },
          { key: 'doc', header: t('common.doctor'), cell: (r) => r.doctor?.fullName ?? '—' },
          { key: 'type', header: t('common.type'), cell: (r) => r.visitType?.name ?? '—' },
          { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="VisitStatus" value={r.status} /> },
        ]}
      />
      {q.data && <Pagination {...q.data} onPage={setPage} />}
    </Card>
  );
}

function PatientLabs({ patientId }: { patientId: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['lab', 'patient', patientId], queryFn: () => api.get<Paged<{ id: string; orderNumber: string; status: string; requestedAt: string; doctor: { fullName: string }; items: { testName: string }[] }>>('/lab/orders', { patientId, pageSize: 100 }) });
  return (
    <Card>
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/lab/${r.id}`)}
        columns={[
          { key: 'n', header: '#', cell: (r) => <span className="font-mono text-xs">{r.orderNumber}</span> },
          { key: 'd', header: t('common.date'), cell: (r) => fmtDateTime(r.requestedAt) },
          { key: 'tests', header: t('lab.tests'), cell: (r) => r.items.map((i) => i.testName).join('، ') },
          { key: 'doc', header: t('common.doctor'), cell: (r) => r.doctor.fullName },
          { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="LabOrderStatus" value={r.status} /> },
        ]}
      />
    </Card>
  );
}

function PatientReports({ patientId }: { patientId: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['reports', patientId], queryFn: () => api.get<{ id: string; title: string; createdAt: string; doctor: { fullName: string } }[]>(`/patients/${patientId}/reports`) });
  return (
    <Card>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => window.open(`/print/medical-report/${r.id}`, '_blank')}
        columns={[
          { key: 't', header: t('common.name'), cell: (r) => <b>{r.title}</b> },
          { key: 'd', header: t('common.date'), cell: (r) => fmtDateTime(r.createdAt) },
          { key: 'doc', header: t('common.doctor'), cell: (r) => r.doctor.fullName },
          { key: 'p', header: '', cell: () => <Printer className="h-4 w-4 text-ink-muted" /> },
        ]}
      />
    </Card>
  );
}

function PatientInvoices({ patientId }: { patientId: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['invoices', 'patient', patientId], queryFn: () => api.get<Paged<{ id: string; invoiceNumber: string | null; status: string; createdAt: string; total: number; paidAmount: number; balance: number }>>('/billing/invoices', { patientId, pageSize: 100 }) });
  return (
    <Card>
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/billing/invoices/${r.id}`)}
        columns={[
          { key: 'n', header: t('billing.invoiceNumber'), cell: (r) => <span className="font-mono text-xs">{r.invoiceNumber ?? t('enum.InvoiceStatus.DRAFT')}</span> },
          { key: 'd', header: t('common.date'), cell: (r) => fmtDate(r.createdAt) },
          { key: 't', header: t('common.total'), cell: (r) => money(r.total) },
          { key: 'p', header: t('common.paid'), cell: (r) => money(r.paidAmount) },
          { key: 'b', header: t('common.balance'), cell: (r) => <b className={Number(r.balance) > 0 ? 'text-danger-600' : ''}>{money(r.balance)}</b> },
          { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="InvoiceStatus" value={r.status} /> },
        ]}
      />
    </Card>
  );
}
