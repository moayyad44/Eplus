import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDate, money } from '@/lib/format';
import { useInsuranceCompanies, type Company } from '@/lib/insurance';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, PageHeader, Textarea } from '@/components/ui';

export default function Companies() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useInsuranceCompanies();
  const [edit, setEdit] = useState<Company | 'new' | null>(null);
  return (
    <div>
      <PageHeader title={t('ins.companies')} subtitle={t('ins.companiesSub')}
        actions={can('insurance.company.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>{t('ins.newCompany')}</Button>} />
      <Card>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          error={q.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/insurance/companies/${r.id}`)}
          columns={[
            { key: 'n', header: t('ins.company'), cell: (r) => <span className="flex items-center gap-2"><Building2 className="h-4 w-4 text-primary-600" /><b>{r.nameAr}</b>{r.nameEn && <span className="text-xs text-ink-muted" dir="ltr">{r.nameEn}</span>}</span> },
            { key: 'c', header: t('ins.contracts'), cell: (r) => r.contracts.filter((c) => c.isActive).map((c) => c.name).join('، ') || '—' },
            { key: 'm', header: t('ins.d.insuredPatients'), hideOnMobile: true, cell: (r) => r._count?.memberships ?? 0 },
            { key: 'e', header: t('ins.f.contractEnd'), hideOnMobile: true, cell: (r) => fmtDate(r.contractEnd) },
            { key: 'o', header: t('ins.c.outstanding'), cell: (r) => <b className="tabular-nums">{money(r.outstanding ?? 0)}</b> },
            { key: 's', header: t('common.status'), cell: (r) => <Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? t('common.active') : t('common.inactive')}</Badge> },
          ]}
        />
      </Card>
      {edit && <CompanyDialog company={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function CompanyDialog({ company, onClose }: { company: Company | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({
    code: company?.code ?? '', nameAr: company?.nameAr ?? '', nameEn: company?.nameEn ?? '', phone: company?.phone ?? '', email: company?.email ?? '', address: company?.address ?? '',
    contactPerson: company?.contactPerson ?? '', contractNumber: company?.contractNumber ?? '', contractStart: company?.contractStart?.slice(0, 10) ?? '', contractEnd: company?.contractEnd?.slice(0, 10) ?? '',
    openingBalance: String(company?.openingBalance ?? 0), isActive: company?.isActive ?? true, notes: company?.notes ?? '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const save = useApiMutation(
    () => {
      const body = { ...v, contractStart: v.contractStart || null, contractEnd: v.contractEnd || null };
      return company ? api.put(`/insurance/companies/${company.id}`, body) : api.post('/insurance/companies', body);
    },
    { invalidate: [['insurance']], onSuccess: onClose },
  );
  const fe = save.fieldErrors;
  return (
    <Dialog open onClose={onClose} size="lg" title={company ? company.nameAr : t('ins.newCompany')}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ins.f.nameAr')} required error={fe.nameAr}><Input value={v.nameAr} onChange={set('nameAr')} /></Field>
        <Field label={t('ins.f.nameEn')}><Input value={v.nameEn} onChange={set('nameEn')} dir="ltr" /></Field>
        <Field label={t('ins.f.code')} hint={t('common.optional')} error={fe.code}><Input value={v.code} onChange={set('code')} dir="ltr" /></Field>
        <Field label={t('ins.f.contactPerson')}><Input value={v.contactPerson} onChange={set('contactPerson')} /></Field>
        <Field label={t('ins.f.phone')}><Input value={v.phone} onChange={set('phone')} dir="ltr" /></Field>
        <Field label={t('ins.f.email')}><Input value={v.email} onChange={set('email')} dir="ltr" /></Field>
        <Field label={t('ins.f.address')} className="sm:col-span-2"><Input value={v.address} onChange={set('address')} /></Field>
        <Field label={t('ins.f.contractNumber')}><Input value={v.contractNumber} onChange={set('contractNumber')} dir="ltr" /></Field>
        <Field label={t('ins.f.openingBalance')}><Input type="number" min={0} step="0.001" value={v.openingBalance} onChange={set('openingBalance')} dir="ltr" /></Field>
        <Field label={t('ins.f.contractStart')}><Input type="date" value={v.contractStart} onChange={set('contractStart')} /></Field>
        <Field label={t('ins.f.contractEnd')}><Input type="date" value={v.contractEnd} onChange={set('contractEnd')} /></Field>
        <Field label={t('ins.f.notes')} className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field>
        <Checkbox label={t('ins.f.isActive')} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
      </div>
    </Dialog>
  );
}
