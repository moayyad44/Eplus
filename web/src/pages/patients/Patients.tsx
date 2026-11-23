import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, UserPlus } from 'lucide-react';
import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDate } from '@/lib/format';
import type { PatientLite } from '@/lib/types';
import { Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select } from '@/components/ui';
import { PatientFormDialog } from '@/components/shared/PatientForm';

export default function Patients() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const list = usePagedList<PatientLite, { gender?: string }>('patients', '/patients', { sort: 'createdAt' });
  const doExport = async () => {
    const all = await api.get<Paged<PatientLite>>('/patients', { q: list.q, pageSize: 200, ...list.sort, ...list.filters });
    exportCsv('patients', [
      { header: t('patients.fileNumber'), value: (p) => p.fileNumber }, { header: t('patients.fullName'), value: (p) => p.fullName },
      { header: t('patients.phone'), value: (p) => p.phone }, { header: t('patients.gender'), value: (p) => t(`enum.Gender.${p.gender}`) },
      { header: t('patients.age'), value: (p) => p.age ?? '' }, { header: t('patients.visitCount'), value: (p) => p.visitCount },
      { header: t('patients.lastVisit'), value: (p) => fmtDate(p.lastVisitAt) },
    ], all.items);
  };
  return (
    <div>
      <PageHeader
        title={t('patients.title')}
        subtitle={t('patients.subtitle')}
        actions={
          <>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={doExport}>{t('common.exportCsv')}</Button>
            {can('patients.create') && <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t('patients.new')}</Button>}
          </>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('patients.searchPlaceholder')} className="w-full sm:w-96" autoFocus />
          <Select value={list.filters.gender ?? ''} onChange={(e) => list.setFilters({ gender: e.target.value || undefined })} className="w-auto">
            <option value="">{t('patients.gender')}: {t('common.all')}</option>
            <option value="MALE">{t('enum.Gender.MALE')}</option>
            <option value="FEMALE">{t('enum.Gender.FEMALE')}</option>
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          onRetry={() => list.query.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/patients/${r.id}`)}
          sort={list.sort}
          onSort={list.setSort}
          columns={[
            { key: 'fileNumber', header: t('patients.fileNumber'), sortable: true, cell: (r) => <span className="font-mono text-xs text-ink-soft">{r.fileNumber}</span> },
            { key: 'fullName', header: t('patients.fullName'), sortable: true, cell: (r) => <span className="font-semibold">{r.fullName}</span> },
            { key: 'phone', header: t('patients.phone'), cell: (r) => <span dir="ltr">{r.phone}</span> },
            { key: 'gender', header: t('patients.gender'), hideOnMobile: true, cell: (r) => t(`enum.Gender.${r.gender}`) },
            { key: 'age', header: t('patients.age'), hideOnMobile: true, cell: (r) => (r.age != null ? r.age : '—') },
            { key: 'visitCount', header: t('patients.visitCount'), sortable: true, hideOnMobile: true, cell: (r) => r.visitCount },
            { key: 'lastVisitAt', header: t('patients.lastVisit'), sortable: true, hideOnMobile: true, cell: (r) => fmtDate(r.lastVisitAt) },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {creating && <PatientFormDialog open onClose={() => setCreating(false)} onSaved={(p) => nav(`/patients/${p.id}`)} />}
    </div>
  );
}
