import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { money } from '@/lib/format';
import type { PaymentMethod } from '@/lib/types';
import { Button, Dialog, Field, Input, Textarea } from '@/components/ui';

export const usePaymentMethods = () => useQuery({ queryKey: ['catalog', 'payment-methods'], queryFn: () => api.get<PaymentMethod[]>('/settings/payment-methods'), staleTime: 5 * 60_000 });

/** Records a payment (or refund) on an invoice. */
export function PaymentDialog({ invoiceId, max, mode = 'PAYMENT', onClose, onDone }: { invoiceId: string; max: number; mode?: 'PAYMENT' | 'REFUND'; onClose: () => void; onDone?: (receiptId: string) => void }) {
  const { t } = useTranslation();
  const methods = usePaymentMethods();
  const [v, setV] = useState({ amount: String(max), methodId: '', reference: '', notes: '' });
  const method = methods.data?.find((m) => m.id === v.methodId);
  const save = useApiMutation(
    () => api.post<{ payment: { id: string; receiptNumber: string } }>(`/billing/invoices/${invoiceId}/${mode === 'REFUND' ? 'refunds' : 'payments'}`, { ...v, amount: Number(v.amount), reference: v.reference || null, notes: v.notes || null }),
    {
      invalidate: [['invoice'], ['invoices'], ['queue'], ['cashier']],
      success: false,
      onSuccess: (r) => {
        toast.success(mode === 'REFUND' ? t('billing.refundSaved') : t('billing.paymentSaved', { number: r.payment.receiptNumber }));
        onDone?.(r.payment.id);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={mode === 'REFUND' ? t('billing.refund') : t('billing.addPayment')}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button variant={mode === 'REFUND' ? 'danger' : 'success'} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.confirm')}</Button></>}
    >
      <div className="space-y-3">
        <Field group label={t('common.amount')} required error={save.fieldErrors.amount} hint={`${t('common.balance')}: ${money(max)}`}>
          <div className="flex gap-2">
            <Input type="number" step="0.001" min={0} max={max} value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} dir="ltr" className="text-lg font-bold" />
            <Button variant="outline" onClick={() => setV({ ...v, amount: String(max) })}>{t('billing.fullAmount')}</Button>
          </div>
        </Field>
        <Field group label={t('billing.method')} required error={save.fieldErrors.methodId}>
          <div className="grid grid-cols-2 gap-2">
            {methods.data?.map((m) => (
              <button key={m.id} type="button" onClick={() => setV({ ...v, methodId: m.id })} className={`h-11 rounded-xl border text-sm font-semibold transition ${v.methodId === m.id ? 'border-primary-500 bg-primary-50 text-primary-800 ring-2 ring-primary-100' : 'border-line-strong hover:bg-surface-subtle'}`}>
                {m.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('billing.reference')} required={method?.requiresReference} error={save.fieldErrors.reference}>
          <Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} dir="ltr" />
        </Field>
        <Field label={mode === 'REFUND' ? t('billing.refundReason') : t('common.notes')} required={mode === 'REFUND'} error={save.fieldErrors.notes}>
          <Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
