import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, FileUp, Plus, Printer, TestTube2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import type { LabOrder } from '@/lib/clinical';
import { Button, Card, CardHeader, ErrorState, IconButton, Input, PageHeader, PageLoader, Select, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { AttachmentsPanel } from '@/components/shared/Attachments';

interface Detail extends LabOrder {
  patient: { id: string; fullName: string; fileNumber: string; phone: string; gender: string; age: number | null };
  doctor: { id: string; fullName: string }; visit: { id: string; visitNumber: string } | null; collectedAt: string | null; cancelReason: string | null; updatedAt: string;
}
type ResultRow = { parameterName: string; value: string; unit: string; referenceRange: string; flag: string; notes: string };
interface FileResult { parameterName: string; value: string; unit: string | null; referenceRange: string | null; flag: string | null; notes: string | null }
interface ReadFile {
  header: { patientName: string | null; fileNo: string | null; sampleDate: string | null }; patientCheck: 'match' | 'mismatch' | 'unknown'; orderPatient: string; found: number;
  items: { itemId: string; results: FileResult[] }[]; unassigned: { name: string; short: string; value: string; unit: string; referenceRange: string; flag: string | null; notes: string | null }[]; missing: string[];
}
const toRow = (r: FileResult): ResultRow => ({ parameterName: r.parameterName, value: r.value, unit: r.unit ?? '', referenceRange: r.referenceRange ?? '', flag: r.flag ?? '', notes: r.notes ?? '' });

/** Suggests a flag by comparing a numeric value with a simple "a-b", "< x" or "> x" range. */
function autoFlag(value: string, range: string): string {
  const v = parseFloat(value);
  if (Number.isNaN(v) || !range) return '';
  const m = range.match(/^\s*([\d.]+)\s*-\s*([\d.]+)/);
  if (m) return v < +m[1] ? 'LOW' : v > +m[2] ? 'HIGH' : 'NORMAL';
  const lt = range.match(/^\s*<\s*([\d.]+)/);
  if (lt) return v < +lt[1] ? 'NORMAL' : 'HIGH';
  const gt = range.match(/^\s*>\s*([\d.]+)/);
  if (gt) return v > +gt[1] ? 'NORMAL' : 'LOW';
  return '';
}

export default function LabOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['lab', id], queryFn: () => api.get<Detail>(`/lab/orders/${id}`) });
  const [rows, setRows] = useState<Record<string, ResultRow[]>>({});
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState<ReadFile | null>(null);
  const [assignTo, setAssignTo] = useState<Record<number, string>>({});

  /** Reads the lab's PDF, fills the boxes for review (nothing is saved) and keeps the file with the order's attachments. */
  const readFile = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setReading(true);
    try {
      const r = await api.upload<ReadFile>(`/lab/orders/${id}/read-file`, fd);
      if (r.patientCheck === 'mismatch' && !(await confirm({ danger: true, message: t('lab.file.otherPatient', { file: r.header.patientName, order: r.orderPatient }), confirmLabel: t('lab.file.fillAnyway') }))) return;
      const filled = Object.values(rows).some((rs) => rs.some((x) => x.value.trim()));
      if (filled && r.items.length && !(await confirm({ message: t('lab.file.replace'), confirmLabel: t('lab.file.replaceOk') }))) return;
      setRows((cur) => { const next = { ...cur }; for (const it of r.items) next[it.itemId] = it.results.map(toRow); return next; });
      setRead(r);
      setAssignTo({});
      toast.success(t('lab.file.done', { n: r.items.reduce((s2, i) => s2 + i.results.length, 0) }));
      const att = new FormData();
      att.append('file', file); att.append('category', 'LAB_RESULT'); att.append('labOrderId', id!);
      await api.upload('/attachments', att).then(() => qc.invalidateQueries({ queryKey: ['attachments'] })).catch(() => toast.warning(t('lab.file.notAttached')));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const initKey = q.data ? `${q.data.id}:${q.data.updatedAt}` : '';
  useEffect(() => {
    if (!q.data) return;
    const init: Record<string, ResultRow[]> = {};
    for (const it of q.data.items) {
      if (it.results.length) {
        init[it.id] = it.results.map((r) => ({ parameterName: r.parameterName, value: r.value, unit: r.unit ?? '', referenceRange: r.referenceRange ?? '', flag: r.flag ?? '', notes: r.notes ?? '' }));
      } else {
        const params = it.labTest?.parameters?.length ? it.labTest.parameters : [{ name: it.testName, unit: it.labTest?.unit ?? '', referenceRange: it.labTest?.referenceRange ?? '' }];
        init[it.id] = params.map((p) => ({ parameterName: p.name, value: '', unit: p.unit ?? '', referenceRange: p.referenceRange ?? '', flag: '', notes: '' }));
      }
    }
    setRows(init);
  }, [initKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = useApiMutation((v: { status: string; reason?: string }) => api.post(`/lab/orders/${id}/status`, v), { invalidate: [['lab']] });
  const save = useApiMutation(
    (complete: boolean) =>
      api.put(`/lab/orders/${id}/results`, {
        complete,
        items: Object.entries(rows).map(([itemId, rs]) => ({
          itemId,
          results: rs.filter((r) => r.value.trim()).map((r) => ({ ...r, unit: r.unit || null, referenceRange: r.referenceRange || null, flag: r.flag || null, notes: r.notes || null })),
        })),
      }),
    { invalidate: [['lab']], success: false, onSuccess: (_r, complete) => toast.success(complete ? t('lab.completedOk') : t('lab.savedOk')) },
  );

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data;
  const editable = can('lab.process') && o.status !== 'CANCELLED';
  const setRow = (itemId: string, idx: number, patch: Partial<ResultRow>) =>
    setRows((r) => ({ ...r, [itemId]: r[itemId].map((x, i) => { if (i !== idx) return x; const n = { ...x, ...patch }; if ('value' in patch || 'referenceRange' in patch) n.flag = autoFlag(n.value, n.referenceRange) || n.flag; return n; }) }));

  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-2">{o.orderNumber} <StatusBadge enumName="LabOrderStatus" value={o.status} /></span>}
        subtitle={<>{fmtDateTime(o.requestedAt)} · {o.doctor.fullName}{o.visit && <> · <Link className="text-primary-700 hover:underline" to={`/visits/${o.visit.id}`}>{o.visit.visitNumber}</Link></>}</>}
        actions={
          <>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/print/lab/${o.id}`, '_blank')}>{t('lab.printRequest')}</Button>
            {o.status === 'COMPLETED' && <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/print/lab/${o.id}?mode=result`, '_blank')}>{t('lab.printResult')}</Button>}
            {can('lab.process') && o.status === 'REQUESTED' && <Button variant="secondary" icon={<TestTube2 className="h-4 w-4" />} loading={status.isPending} onClick={() => status.mutate({ status: 'SAMPLE_COLLECTED' })}>{t('lab.collect')}</Button>}
            {can('lab.process') && ['REQUESTED', 'SAMPLE_COLLECTED'].includes(o.status) && <Button variant="secondary" onClick={() => status.mutate({ status: 'PROCESSING' })}>{t('lab.process')}</Button>}
            {['REQUESTED', 'SAMPLE_COLLECTED', 'PROCESSING'].includes(o.status) && (can('lab.process') || can('lab.order')) && (
              <Button variant="danger" onClick={async () => { const r = await confirm({ message: o.orderNumber, danger: true, reason: { label: t('lab.cancelReason'), required: true } }); if (r) status.mutate({ status: 'CANCELLED', reason: r }); }}>{t('lab.cancel')}</Button>
            )}
          </>
        }
      />
      {editable && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
            <Button icon={<FileUp className="h-4 w-4" />} loading={reading} onClick={() => fileInput.current?.click()}>{t('lab.file.read')}</Button>
            <p className="text-xs text-ink-muted">{t('lab.file.hint')}</p>
          </div>
          {read && (
            <div className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
              <p className={read.patientCheck === 'mismatch' ? 'flex items-center gap-2 font-semibold text-danger-700' : 'flex items-center gap-2 text-success-700'}>
                {read.patientCheck === 'mismatch' ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {t('lab.file.patient', { name: read.header.patientName ?? '—', file: read.header.fileNo ?? '—', date: read.header.sampleDate ?? '—' })}
              </p>
              <p>{t('lab.file.summary', { tests: read.items.length, n: read.items.reduce((s2, i) => s2 + i.results.length, 0), found: read.found })} <b className="text-warning-700">{t('lab.file.review')}</b></p>
              {read.missing.length > 0 && <p className="text-warning-700">{t('lab.file.missing')}: <b>{read.missing.join('، ')}</b></p>}
              {read.unassigned.length > 0 && (
                <details className="rounded-xl bg-surface-subtle p-2.5">
                  <summary className="cursor-pointer text-xs font-semibold">{t('lab.file.unassigned', { n: read.unassigned.length })} <span className="text-primary-700">{t('lab.file.show')}</span></summary>
                  <ul className="mt-2 space-y-1.5">{read.unassigned.map((u, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
                      <span dir="ltr" className="font-semibold">{u.name}</span><span dir="ltr">{u.value} {u.unit}</span>
                      <Select className="!h-8 w-48 text-xs" value={assignTo[i] ?? ''} onChange={(e) => setAssignTo({ ...assignTo, [i]: e.target.value })}>
                        <option value="">{t('lab.file.addTo')}</option>{o.items.map((it) => <option key={it.id} value={it.id}>{it.testName}</option>)}
                      </Select>
                      <Button size="sm" variant="outline" disabled={!assignTo[i]} onClick={() => {
                        const target = assignTo[i];
                        setRows((cur) => ({ ...cur, [target]: [...(cur[target] ?? []).filter((x) => x.value.trim() || x.parameterName.trim()), toRow({ parameterName: u.short, value: u.value, unit: u.unit, referenceRange: u.referenceRange.slice(0, 120), flag: u.flag, notes: u.notes })] }));
                        setRead({ ...read, unassigned: read.unassigned.filter((_, j) => j !== i) });
                        setAssignTo({});
                      }}>{t('lab.file.add')}</Button>
                    </li>
                  ))}</ul>
                </details>
              )}
            </div>
          )}
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          {o.items.map((it) => (
            <Card key={it.id}>
              <CardHeader title={it.testName} subtitle={[it.labTest?.code, it.labTest?.sampleType].filter(Boolean).join(' · ')} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="text-xs text-ink-muted"><th className="p-1.5 text-start">{t('lab.parameter')}</th><th className="p-1.5 text-start">{t('lab.value')}</th><th className="p-1.5 text-start">{t('lab.unit')}</th><th className="p-1.5 text-start">{t('lab.range')}</th><th className="p-1.5 text-start">{t('lab.flag')}</th><th /></tr></thead>
                  <tbody>
                    {(rows[it.id] ?? []).map((r, idx) => (
                      <tr key={idx}>
                        <td className="p-1"><Input value={r.parameterName} disabled={!editable} onChange={(e) => setRow(it.id, idx, { parameterName: e.target.value })} dir="ltr" /></td>
                        <td className="p-1"><Input value={r.value} disabled={!editable} onChange={(e) => setRow(it.id, idx, { value: e.target.value })} dir="ltr" invalid={!!r.flag && r.flag !== 'NORMAL'} className={r.flag && r.flag !== 'NORMAL' ? 'bg-danger-50 font-bold text-danger-700' : 'font-semibold'} /></td>
                        <td className="p-1"><Input value={r.unit} disabled={!editable} onChange={(e) => setRow(it.id, idx, { unit: e.target.value })} dir="ltr" className="w-24" /></td>
                        <td className="p-1"><Input value={r.referenceRange} disabled={!editable} onChange={(e) => setRow(it.id, idx, { referenceRange: e.target.value })} dir="ltr" className="w-28" /></td>
                        <td className="p-1">
                          <Select value={r.flag} disabled={!editable} onChange={(e) => setRow(it.id, idx, { flag: e.target.value })} className="min-w-[8.5rem]">
                            <option value="">—</option>
                            {['NORMAL', 'LOW', 'HIGH', 'ABNORMAL', 'CRITICAL'].map((f) => <option key={f} value={f}>{t(`enum.ResultFlag.${f}`)}</option>)}
                          </Select>
                        </td>
                        <td className="p-1">{editable && <IconButton size="sm" label={t('common.remove')} onClick={() => setRows((x) => ({ ...x, [it.id]: x[it.id].filter((_, i) => i !== idx) }))}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {editable && <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="h-4 w-4" />} onClick={() => setRows((x) => ({ ...x, [it.id]: [...(x[it.id] ?? []), { parameterName: '', value: '', unit: '', referenceRange: '', flag: '', notes: '' }] }))}>{t('lab.addParam')}</Button>}
            </Card>
          ))}
          {editable && (
            <div className="flex justify-end gap-2">
              {o.status !== 'COMPLETED' && <Button variant="outline" loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>{t('lab.saveDraft')}</Button>}
              <Button variant="success" loading={save.isPending && !!save.variables} onClick={() => save.mutate(true)}>{o.status === 'COMPLETED' ? t('lab.amend') : t('lab.complete')}</Button>
            </div>
          )}
        </div>
        <aside className="space-y-4">
          <Card>
            <Link to={`/patients/${o.patient.id}`} className="text-lg font-bold hover:text-primary-700">{o.patient.fullName}</Link>
            <p className="text-sm text-ink-muted">#{o.patient.fileNumber} · {t(`enum.Gender.${o.patient.gender}`)}{o.patient.age != null && ` · ${t('common.yearsOld', { age: o.patient.age })}`}</p>
            <dl className="mt-3 space-y-2 text-sm">
              {o.clinicalNotes && <div><dt className="text-xs text-ink-muted">{t('lab.clinicalNotes')}</dt><dd>{o.clinicalNotes}</dd></div>}
              <div><dt className="text-xs text-ink-muted">{t('lab.collectedAt')}</dt><dd>{fmtDateTime(o.collectedAt)}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('lab.completedAt')}</dt><dd>{fmtDateTime(o.completedAt)}</dd></div>
              {o.cancelReason && <div><dt className="text-xs text-ink-muted">{t('lab.cancelReason')}</dt><dd className="text-danger-700">{o.cancelReason}</dd></div>}
            </dl>
          </Card>
          <Card><CardHeader title={t('common.attachments')} /><AttachmentsPanel labOrderId={o.id} compact /></Card>
        </aside>
      </div>
    </div>
  );
}
