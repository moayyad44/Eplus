import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import { Button, Card, CardHeader, DataTable, Dialog, ErrorState, Field, Input, PageHeader, PageLoader, Select, StatCard, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { usePaymentMethods } from '@/components/shared/PaymentDialog';
import { SupplierDialog, type Supplier } from './Suppliers';

interface Detail extends Supplier {
  purchaseOrders: { id: string; poNumber: string; status: string; orderDate: string; total: number; _count: { items: number } }[];
  payments: { id: string; amount: number; paidAt: string; reference: string | null; voidedAt: string | null; method: { name: string }; purchaseOrder: { poNumber: string } | null }[];
}

export default function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const methods = usePaymentMethods();
  const [edit, setEdit] = useState(false);
  const [pay, setPay] = useState(false);
  const [pv, setPv] = useState({ amount: '', methodId: '', purchaseOrderId: '', reference: '' });
  const q = useQuery({ queryKey: ['suppliers', id], queryFn: () => api.get<Detail>(`/suppliers/${id}`) });
  const addPay = useApiMutation(() => api.post(`/suppliers/${id}/payments`, { ...pv, amount: Number(pv.amount), purchaseOrderId: pv.purchaseOrderId || null }), { invalidate: [['suppliers']], onSuccess: () => { setPay(false); setPv({ amount: '', methodId: '', purchaseOrderId: '', reference: '' }); } });
  const voidPay = useApiMutation((pid: string) => api.post(`/suppliers/payments/${pid}/void`), { invalidate: [['suppliers']] });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  return (
    <div>
      <PageHeader
        title={s.name}
        subtitle={[s.phone, s.email, s.contactPerson].filter(Boolean).join(' · ')}
        actions={can('suppliers.manage') && (
          <>
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav(`/purchases/new?supplierId=${s.id}`)}>{t('suppliers.newPO')}</Button>
            <Button variant="success" icon={<Wallet className="h-4 w-4" />} onClick={() => setPay(true)}>{t('suppliers.addPayment')}</Button>
            <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>{t('common.edit')}</Button>
          </>
        )}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label={t('suppliers.purchases')} value={money(s.purchases)} />
        <StatCard label={t('suppliers.paid')} value={money(s.paid)} tone="success" />
        <StatCard label={t('suppliers.balance')} value={money(s.balance)} tone="danger" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('suppliers.orders')} />
          <DataTable rows={s.purchaseOrders} rowKey={(r) => r.id} onRowClick={(r) => nav(`/purchases/${r.id}`)} dense columns={[
            { key: 'n', header: t('suppliers.poNumber'), cell: (r) => <span className="font-mono text-xs">{r.poNumber}</span> },
            { key: 'd', header: t('suppliers.orderDate'), cell: (r) => fmtDate(r.orderDate) },
            { key: 't', header: t('common.total'), cell: (r) => money(r.total) },
            { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="PurchaseOrderStatus" value={r.status} /> },
          ]} />
        </Card>
        <Card>
          <CardHeader title={t('suppliers.payments')} />
          <DataTable rows={s.payments} rowKey={(r) => r.id} dense rowClassName={(r) => (r.voidedAt ? 'opacity-50 line-through' : undefined)} columns={[
            { key: 'd', header: t('common.date'), cell: (r) => fmtDateTime(r.paidAt) },
            { key: 'a', header: t('common.amount'), cell: (r) => <b>{money(r.amount)}</b> },
            { key: 'm', header: t('common.paymentMethod'), cell: (r) => r.method.name },
            { key: 'po', header: t('suppliers.poNumber'), cell: (r) => r.purchaseOrder?.poNumber ?? '—' },
            { key: 'x', header: '', cell: (r) => !r.voidedAt && can('suppliers.manage') && <Button size="sm" variant="ghost" onClick={async () => (await confirm({ message: money(r.amount), danger: true })) && voidPay.mutate(r.id)}>{t('billing.voidPayment')}</Button> },
          ]} />
        </Card>
      </div>
      {edit && <SupplierDialog supplier={s} onClose={() => setEdit(false)} />}
      <Dialog open={pay} onClose={() => setPay(false)} size="sm" title={t('suppliers.addPayment')} footer={<><Button variant="outline" onClick={() => setPay(false)}>{t('common.cancel')}</Button><Button loading={addPay.isPending} onClick={() => addPay.mutate(undefined)}>{t('common.save')}</Button></>}>
        <div className="space-y-3">
          <Field label={t('common.amount')} required error={addPay.fieldErrors.amount}><Input type="number" step="0.001" value={pv.amount} onChange={(e) => setPv({ ...pv, amount: e.target.value })} dir="ltr" /></Field>
          <Field label={t('common.paymentMethod')} required error={addPay.fieldErrors.methodId}><Select value={pv.methodId} onChange={(e) => setPv({ ...pv, methodId: e.target.value })} placeholder={t('common.select')}>{methods.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
          <Field label={t('suppliers.purchaseOrder')}><Select value={pv.purchaseOrderId} onChange={(e) => setPv({ ...pv, purchaseOrderId: e.target.value })} placeholder={t('common.none')}>{s.purchaseOrders.map((p) => <option key={p.id} value={p.id}>{p.poNumber} — {money(p.total)}</option>)}</Select></Field>
          <Field label={t('common.reference')}><Input value={pv.reference} onChange={(e) => setPv({ ...pv, reference: e.target.value })} /></Field>
        </div>
      </Dialog>
    </div>
  );
}
