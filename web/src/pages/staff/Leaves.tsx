import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { fmtDay, ymd } from '@/lib/format';
import type { UserLite } from '@/lib/types';
import { Button, Card, DataTable, Dialog, Field, Input, PageHeader, Pagination, Select, Tabs } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Row { id: string; type: string; startDate: string; endDate: string; status: string; reason: string | null; user: { id: string; fullName: string } }

export default function Leaves() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('shifts.manage');
  const list = usePagedList<Row, { status?: string }>('leaves', '/staff/leaves', { filters: { status: manage ? 'PENDING' : undefined } });
  const decide = useApiMutation((v: { id: string; status: string }) => api.post(`/staff/leaves/${v.id}/decision`, { status: v.status }), { invalidate: [['leaves'], ['schedule']] });
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title={t('staff.leaves')} subtitle={t('staff.leavesSubtitle')} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('staff.requestLeave')}</Button>} />
      <Card padded={false}>
        <div className="px-4 pt-2">
          <Tabs value={list.filters.status ?? 'ALL'} onChange={(k) => list.setFilters({ status: k === 'ALL' ? undefined : k })} items={['PENDING', 'APPROVED', 'REJECTED', 'ALL'].map((k) => ({ key: k, label: k === 'ALL' ? t('common.all') : t(`enum.LeaveStatus.${k}`) }))} />
        </div>
        <div className="p-4">
          <DataTable
            rows={list.data?.items}
            loading={list.query.isFetching}
            error={list.query.error}
            rowKey={(r) => r.id}
            columns={[
              { key: 'u', header: t('staff.employee'), cell: (r) => <b>{r.user.fullName}</b> },
              { key: 't', header: t('staff.leaveType'), cell: (r) => t(`enum.LeaveType.${r.type}`) },
              { key: 'f', header: t('staff.startDate'), cell: (r) => fmtDay(r.startDate) },
              { key: 'e', header: t('staff.endDate'), cell: (r) => fmtDay(r.endDate) },
              { key: 'r', header: t('common.reason'), hideOnMobile: true, cell: (r) => r.reason ?? '—' },
              { key: 's', header: t('common.status'), cell: (r) => <StatusBadge enumName="LeaveStatus" value={r.status} /> },
              {
                key: 'x', header: '', cell: (r) => manage && r.status === 'PENDING' && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="success" onClick={() => decide.mutate({ id: r.id, status: 'APPROVED' })}>{t('staff.approve')}</Button>
                    <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: r.id, status: 'REJECTED' })}>{t('staff.reject')}</Button>
                  </div>
                ),
              },
            ]}
          />
          {list.data && <Pagination {...list.data} onPage={list.setPage} />}
        </div>
      </Card>
      {open && <LeaveDialog manage={manage} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LeaveDialog({ manage, onClose }: { manage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const users = useQuery({ queryKey: ['users', 'lookup'], queryFn: () => api.get<UserLite[]>('/users/lookup'), enabled: manage });
  const [v, setV] = useState({ userId: '', type: 'ANNUAL', startDate: ymd(), endDate: ymd(), reason: '' });
  const save = useApiMutation(() => api.post('/staff/leaves', { ...v, userId: v.userId || undefined, reason: v.reason || null }), { invalidate: [['leaves']], onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={t('staff.requestLeave')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        {manage && <Field label={t('staff.employee')}><Select value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })}><option value="">{t('staff.myLeave')}</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></Field>}
        <Field label={t('staff.leaveType')}><Select value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}>{['ANNUAL', 'SICK', 'UNPAID', 'EMERGENCY', 'OTHER'].map((x) => <option key={x} value={x}>{t(`enum.LeaveType.${x}`)}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('staff.startDate')}><Input type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} /></Field>
          <Field label={t('staff.endDate')}><Input type="date" value={v.endDate} onChange={(e) => setV({ ...v, endDate: e.target.value })} /></Field>
        </div>
        <Field label={t('common.reason')}><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
