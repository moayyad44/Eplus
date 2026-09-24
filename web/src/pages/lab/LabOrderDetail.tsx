import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Printer, TestTube2, Trash2 } from 'lucide-react';
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
