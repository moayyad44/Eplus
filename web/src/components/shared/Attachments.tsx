import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, FileImage, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { Button, EmptyState, IconButton, Select, Spinner, useConfirm } from '@/components/ui';

interface Att { id: string; fileName: string; mimeType: string; size: number; category: string; createdAt: string; description: string | null }

const CATEGORIES = ['REPORT', 'IMAGE', 'LAB_RESULT', 'DOCUMENT', 'INVOICE', 'OTHER'];

export function AttachmentsPanel({ patientId, visitId, labOrderId, expenseId, compact }: { patientId?: string; visitId?: string; labOrderId?: string; expenseId?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(expenseId ? 'INVOICE' : 'REPORT');
  const [busy, setBusy] = useState(false);
  const params = { patientId, visitId, labOrderId, expenseId };
  const key = ['attachments', params];
  const list = useQuery({ queryKey: key, queryFn: () => api.get<Att[]>('/attachments', params) });
  const canUpload = expenseId ? can('expenses.manage') : can('attachments.upload');

  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('category', category);
    for (const [k, v] of Object.entries(params)) if (v) fd.append(k, v);
    setBusy(true);
    try {
      await api.upload('/attachments', fd);
      toast.success(t('common.created'));
      qc.invalidateQueries({ queryKey: ['attachments'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async (a: Att) => {
    if (!(await confirm({ message: a.fileName, danger: true, confirmLabel: t('common.remove') }))) return;
    await api.del(`/attachments/${a.id}`).then(() => qc.invalidateQueries({ queryKey: ['attachments'] })).catch((e) => toast.error(e.message));
  };

  return (
    <div>
      {canUpload && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="!h-9 w-40">
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`enum.AttachmentCategory.${c}`)}</option>)}
          </Select>
          <input ref={input} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.doc,.docx,.xls,.xlsx,.txt" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button size="sm" variant="secondary" icon={<Upload className="h-4 w-4" />} loading={busy} onClick={() => input.current?.click()}>{t('common.upload')}</Button>
          <span className="text-[11px] text-ink-muted">PDF, JPG, PNG, DOCX — 15MB</span>
        </div>
      )}
      {list.isLoading ? <Spinner /> : !list.data?.length ? (
        <EmptyState icon={<Paperclip className="h-6 w-6" />} title={t('common.noAttachments')} className={compact ? '!py-4' : ''} />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {list.data.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-xl border border-line p-2.5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-700">
                {a.mimeType.startsWith('image/') ? <FileImage className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
              </span>
              <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 hover:text-primary-700">
                <span className="block truncate text-sm font-semibold">{a.fileName}</span>
                <span className="block text-[11px] text-ink-muted">{t(`enum.AttachmentCategory.${a.category}`)} · {(a.size / 1024).toFixed(0)} KB · {fmtDateTime(a.createdAt)}</span>
              </a>
              <a href={`/api/attachments/${a.id}/file?download=1`} className="rounded-lg p-2 text-ink-muted hover:bg-surface-sunken" title={t('common.download')}><Download className="h-4 w-4" /></a>
              {canUpload && <IconButton size="sm" label={t('common.remove')} onClick={() => remove(a)}><Trash2 className="h-4 w-4 text-danger-600" /></IconButton>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
