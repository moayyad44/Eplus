import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import { useInsuranceCompanies, type Authorization } from '@/lib/insurance';
import { Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, useConfirm } from '@/components/ui';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { AuthDecisionDialog, AuthorizationDialog } from '@/components/insurance/widgets';
import { PatientPicker } from '@/components/shared/PatientPicker';
import type { PatientLite } from '@/lib/types';
import { Dialog } from '@/components/ui';

export default function Authorizations() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const companies = useInsuranceCompanies();
  const list = usePagedList<Authorization, { status?: string; companyId?: string }>('insurance-authorizations', '/insurance/authorizations');
  const [decide, setDecide] = useState<Authorization | null>(null);
  const [pickPatient, setPickPatient] = useState(false);
  const [patient, setPatient] = useState<PatientLite | null>(null);
  const inv = [['insurance-authorizations'], ['insurance']];
  const submit = useApiMutation((id: string) => api.post(`/insurance/authorizations/${id}/submit`), { invalidate: inv });
  const cancel = useApiMutation((v: { id: string; reason: string }) => api.post(`/insurance/authorizations/${v.id}/cancel`, { reason: v.reason }), { invalidate: inv });
  const manage = can('insurance.authorization.manage');
  return (
    <div>
      <PageHeader title={t('ins.authorizations')} subtitle={t('ins.authorizationsSub')}
        actions={manage && <Button onClick={() => setPickPatient(true)}>{t('ins.a.new')}</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-64" />
          <Select value={list.filters.status ?? ''} onChange={(e) => list.setFilters({ status: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.status')}: {t('common.all')}</option>
            {['PENDING', 'SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{t(`enum.AuthorizationStatus.${s}`)}</option>)}
          </Select>
          <Select value={list.filters.companyId ?? ''} onChange={(e) => list.setFilters({ companyId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('ins.company')}: {t('common.all')}</option>
            {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          columns={[
            { key: 'n', header: t('ins.a.requestNumber'), cell: (r) => <><span className="font-mono text-xs font-semibold">{r.requestNumber}</span><span className="block text-[11px] text-ink-muted">{fmtDateTime(r.requestedAt)}</span></> },
            { key: 'p', header: t('common.patient'), cell: (r) => <><Link to={`/patients/${r.patient.id}?tab=insurance`} className="font-semibold hover:text-primary-700">{r.patient.fullName}</Link><span className="block text-[11px] text-ink-muted">{r.company.nameAr} · {r.patientInsurance.memberId}</span></> },
            { key: 's', header: t('ins.a.service'), cell: (r) => <>{r.service.name} × {Number(r.quantity)}<span className="block text-[11px] text-ink-muted">{r.diagnosis ?? ''}</span></> },
            { key: 'v', header: t('ins.a.visit'), hideOnMobile: true, cell: (r) => (r.visit ? <Link to={`/visits/${r.visit.id}`} className="text-primary-700 hover:underline">{r.visit.visitNumber}</Link> : '—') },
            { key: 'ap', header: t('ins.a.approvalNumber'), hideOnMobile: true, cell: (r) => <><span className="font-mono text-xs">{r.approvalNumber ?? '—'}</span>{r.approvedAmount != null && <span className="block text-[11px]">{money(r.approvedAmount)}</span>}{r.validUntil && <span className="block text-[11px] text-ink-muted">{t('ins.a.validUntil')} {fmtDate(r.validUntil)}</span>}</> },
            { key: 'st', header: t('common.status'), cell: (r) => <><StatusBadge enumName="AuthorizationStatus" value={r.effectiveStatus} />{r.rejectReason && <span className="block text-[11px] text-danger-700">{r.rejectReason}</span>}</> },
            {
              key: 'x', header: '', cell: (r) => manage && (
                <div className="flex flex-wrap gap-1">
                  {r.status === 'PENDING' && <Button size="sm" variant="ghost" onClick={() => submit.mutate(r.id)}>{t('ins.a.submit')}</Button>}
                  {['PENDING', 'SUBMITTED'].includes(r.status) && <Button size="sm" variant="outline" onClick={() => setDecide(r)}>{t('ins.a.decide')}</Button>}
                  {!['CANCELLED'].includes(r.status) && r._count.invoiceItems === 0 && (
                    <Button size="sm" variant="ghost" onClick={async () => { const reason = await confirm({ message: r.requestNumber, danger: true, reason: { label: t('common.reason'), required: true } }); if (reason) cancel.mutate({ id: r.id, reason }); }}>{t('ins.a.cancel')}</Button>
                  )}
                </div>
              ),
            },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {decide && <AuthDecisionDialog auth={decide} onClose={() => setDecide(null)} />}
      <Dialog open={pickPatient} onClose={() => setPickPatient(false)} title={t('ins.a.new')}
        footer={<><Button variant="outline" onClick={() => setPickPatient(false)}>{t('common.cancel')}</Button><Button disabled={!patient} onClick={() => setPickPatient(false)}>{t('common.next')}</Button></>}>
        <PatientPicker value={patient} onChange={setPatient} />
      </Dialog>
      {patient && !pickPatient && <AuthorizationDialog patientId={patient.id} onClose={() => setPatient(null)} />}
    </div>
  );
}
