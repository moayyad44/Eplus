import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { QrCode, RefreshCw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime, fmtDay, money, qty } from '@/lib/format';
import { RESENDABLE, type EInvoiceDoc } from '@/lib/einvoice';
import { Button, Card, CardHeader, DataTable, Dialog, Field, Input, Textarea, useConfirm } from '@/components/ui';
import { StatusBadge } from './StatusBadge';

export const useEInvoiceDocs = (invoiceId: string, enabled = true) =>
  useQuery({
    queryKey: ['einvoice', 'invoice', invoiceId],
    queryFn: () => api.get<EInvoiceDoc[]>(`/einvoice/invoices/${invoiceId}`),
    enabled,
    // While a document is being sent or waits for a retry, keep the card current.
    refetchInterval: (q) => (q.state.data?.some((d) => ['PENDING', 'SENDING', 'UNKNOWN'].includes(d.status)) ? 10_000 : false),
  });

/** The official QR returned by the national system, rendered on the server from EINV_QR. */
export function EInvoiceQr({ svg, size = 112 }: { svg: string; size?: number }) {
  return <div className="bg-white p-1 [&>svg]:h-full [&>svg]:w-full" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** National e-invoicing status of an invoice: its documents, QR, resend and returns. */
export function EInvoiceCard({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useEInvoiceDocs(invoiceId);
  const [ret, setRet] = useState<EInvoiceDoc | null>(null);
  const resend = useApiMutation((id: string) => api.post<{ status: string; lastError: string | null }>(`/einvoice/documents/${id}/send`), {
    invalidate: [['einvoice']], success: false,
    onSuccess: (r) => (r.status === 'SUBMITTED' ? toast.success(t('enum.EInvoiceStatus.SUBMITTED')) : toast.error(r.lastError ?? t(`enum.EInvoiceStatus.${r.status}`))),
  });
  const docs = q.data ?? [];
  if (q.isLoading || (!docs.length && !can('einvoice.view'))) return null;
  return (
    <Card>
      <CardHeader title={t('einv.card.title')} icon={<QrCode className="h-5 w-5" />} />
      {!docs.length && <p className="text-sm text-ink-muted">{t('einv.card.none')}</p>}
      <ul className="space-y-3">
        {docs.map((d) => (
          <li key={d.id} className="rounded-xl border border-line p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{t(`einv.kind.${d.kind}`)} · {t(`einv.party.${d.party}`)} <span className="text-xs text-ink-muted">({t(`einv.type.${d.typeName}`)})</span></span>
              <StatusBadge enumName="EInvoiceStatus" value={d.status} />
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              <span className="font-mono" dir="ltr">{d.docNumber}</span> · <bdi>{fmtDay(`${d.issueDate}T00:00:00Z`)}</bdi> · <b className="tabular-nums text-ink">{money(d.total)}</b>
            </p>
            {d.reason && <p className="mt-1 text-xs">{t('einv.reason')}: {d.reason}</p>}
            {d.status === 'SUBMITTED' && d.qrSvg && (
              <div className="mt-2 flex items-center gap-3">
                <EInvoiceQr svg={d.qrSvg} size={96} />
                <span className="text-xs text-ink-muted">{t('einv.card.qrHint')}{d.submittedAt && <><br /><bdi>{fmtDateTime(d.submittedAt)}</bdi></>}</span>
              </div>
            )}
            {d.status === 'UNKNOWN' && <p className="mt-2 rounded-lg bg-warning-50 px-2 py-1 text-xs text-warning-800">{t('einv.card.unknownHint')}</p>}
            {d.status === 'VOID' && <p className="mt-2 text-xs text-ink-muted">{t('einv.card.voidHint')}</p>}
            {['REJECTED', 'FAILED'].includes(d.status) && d.lastError && <p className="mt-2 rounded-lg bg-danger-50 px-2 py-1 text-xs text-danger-700">{d.lastError}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {RESENDABLE.includes(d.status) && can('einvoice.send') && (
                <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={resend.isPending && resend.variables === d.id} onClick={() => resend.mutate(d.id)}>{t('einv.resend')}</Button>
              )}
              {d.kind === 'SALE' && d.status === 'SUBMITTED' && can('einvoice.return') && d.lines.some((l) => Number(l.remaining ?? 0) > 0) && (
                <Button size="sm" variant="outline" icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => setRet(d)}>{t('einv.card.returnBtn')}</Button>
              )}
              {can('einvoice.view') && <Link to={`/einvoice?doc=${d.id}`} className="self-center text-xs font-semibold text-primary-700 hover:underline">{t('einv.details')}</Link>}
            </div>
          </li>
        ))}
      </ul>
      {ret && <ReturnDialog doc={ret} onClose={() => setRet(null)} />}
    </Card>
  );
}

function ReturnDialog({ doc, onClose }: { doc: EInvoiceDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const create = useApiMutation((body: { reason: string; lines: { lineId: number; quantity: number }[] }) => api.post<{ docNumber: string; status: string; lastError: string | null }>(`/einvoice/documents/${doc.id}/returns`, body), {
    invalidate: [['einvoice']], success: false,
    onSuccess: (r) => {
      if (r.status === 'SUBMITTED') toast.success(t('einv.ret.done', { number: `⁨${r.docNumber}⁩` }));
      else toast.error(r.lastError ?? t(`enum.EInvoiceStatus.${r.status}`));
      onClose();
    },
  });
  const lines = doc.lines.map((l) => ({ lineId: l.lineId, quantity: Number(qtys[l.lineId] || 0) })).filter((l) => l.quantity > 0);
  const tooMuch = doc.lines.some((l) => Number(qtys[l.lineId] || 0) > Number(l.remaining ?? 0));
  const submit = async () => {
    if (await confirm({ message: t('einv.ret.confirm'), danger: true })) create.mutate({ reason, lines });
  };
  return (
    <Dialog open onClose={onClose} size="lg" title={t('einv.ret.title', { number: doc.docNumber })}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={create.isPending} disabled={!lines.length || tooMuch || reason.trim().length < 3} onClick={submit}>{t('einv.ret.submit')}</Button></>}>
      <div className="space-y-3">
        <p className="rounded-xl bg-warning-50 px-3 py-2 text-xs text-warning-800">{t('einv.ret.hint')}</p>
        <DataTable
          rows={doc.lines}
          rowKey={(l) => String(l.lineId)}
          dense
          columns={[
            { key: 'n', header: t('billing.service'), cell: (l) => <b>{l.name}</b> },
            { key: 's', header: t('einv.ret.sold'), cell: (l) => qty(l.quantity) },
            { key: 'r', header: t('einv.ret.returned'), cell: (l) => qty(l.returned ?? 0) },
            {
              key: 'q', header: t('einv.ret.qty'), cell: (l) => (
                <Input type="number" min={0} max={Number(l.remaining ?? 0)} step="any" className="w-24" disabled={Number(l.remaining ?? 0) <= 0}
                  invalid={Number(qtys[l.lineId] || 0) > Number(l.remaining ?? 0)}
                  value={qtys[l.lineId] ?? ''} onChange={(e) => setQtys({ ...qtys, [l.lineId]: e.target.value })} />
              ),
            },
          ]}
        />
        <Field label={t('einv.ret.reason')} required error={create.fieldErrors.reason}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
