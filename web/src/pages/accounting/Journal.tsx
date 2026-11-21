import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { usePagedList } from '@/lib/hooks';
import { exportCsv } from '@/lib/export';
import { fmtDateTime } from '@/lib/format';
import { JTYPES, STATUS_TONE, amt0, useAccounts } from '@/lib/accounting';
import { Badge, Button, Card, Checkbox, DataTable, Input, PageHeader, Pagination, SearchInput, Select } from '@/components/ui';

interface Row { id: string; number: string; date: string; type: string; status: string; description: string; reference: string | null; sourceType: string | null; totalDebit: string; createdAt: string; createdBy: string | null; updatedBy: string | null; version: number }

export default function Journal() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const accounts = useAccounts();
  const list = usePagedList<Row, { from?: string; to?: string; type?: string; status?: string; source?: string; accountId?: string; includeDeleted?: string }>('acc-journal', '/accounting/journal', { pageSize: 30 });
  const f = list.filters;
  const total = (list.data as unknown as { totalAmount?: string })?.totalAmount;
  return (
    <div>
      <PageHeader
        title={t('acc.journal.title')}
        subtitle={t('acc.journal.subtitle')}
        actions={<>
          {can('accounting.export') && <Button variant="outline" onClick={() => list.data && exportCsv('journal', [
            { header: t('acc.f.number'), value: (r: Row) => r.number }, { header: t('acc.f.date'), value: (r) => r.date }, { header: t('acc.f.jtype'), value: (r) => t(`acc.jtype.${r.type}`) },
            { header: t('acc.f.statement'), value: (r) => r.description }, { header: t('acc.f.reference'), value: (r) => r.reference ?? '' }, { header: t('acc.f.amount'), value: (r) => Number(r.totalDebit).toFixed(3) },
            { header: t('acc.f.status'), value: (r) => t(`acc.status.${r.status}`) }, { header: t('acc.f.createdBy'), value: (r) => r.createdBy ?? '' },
          ], list.data.items)}>{t('common.exportCsv')}</Button>}
          {can('accounting.journal.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav('/accounting/journal/new')}>{t('acc.journal.new')}</Button>}
        </>}
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-56" />
          <Input type="date" value={f.from ?? ''} onChange={(e) => list.setFilters({ from: e.target.value || undefined })} className="!h-10 w-40" aria-label={t('common.from')} />
          <Input type="date" value={f.to ?? ''} onChange={(e) => list.setFilters({ to: e.target.value || undefined })} className="!h-10 w-40" aria-label={t('common.to')} />
          <Select value={f.type ?? ''} onChange={(e) => list.setFilters({ type: e.target.value || undefined })} className="w-auto">
            <option value="">{t('acc.f.jtype')}: {t('acc.f.all')}</option>{JTYPES.map((x) => <option key={x} value={x}>{t(`acc.jtype.${x}`)}</option>)}
          </Select>
          <Select value={f.status ?? ''} onChange={(e) => list.setFilters({ status: e.target.value || undefined })} className="w-auto">
            <option value="">{t('acc.f.status')}: {t('acc.f.all')}</option>{['POSTED', 'DRAFT', 'DELETED'].map((x) => <option key={x} value={x}>{t(`acc.status.${x}`)}</option>)}
          </Select>
          <Select value={f.source ?? ''} onChange={(e) => list.setFilters({ source: e.target.value || undefined })} className="w-auto">
            <option value="">{t('acc.f.source')}: {t('acc.f.all')}</option><option value="manual">{t('acc.source.manual')}</option><option value="auto">{t('acc.source.auto')}</option>
          </Select>
          <Select value={f.accountId ?? ''} onChange={(e) => list.setFilters({ accountId: e.target.value || undefined })} className="w-auto max-w-[14rem]">
            <option value="">{t('acc.f.account')}: {t('acc.f.all')}</option>{accounts.data?.filter((a) => !a.isGroup).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </Select>
          <Checkbox label={t('acc.journal.includeDeleted')} checked={f.includeDeleted === 'true'} onChange={(e) => list.setFilters({ includeDeleted: e.target.checked ? 'true' : undefined })} />
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/accounting/journal/${r.id}`)}
          rowClassName={(r) => (r.status === 'DELETED' ? 'opacity-50 line-through' : undefined)}
          columns={[
            { key: 'n', header: t('acc.f.number'), cell: (r) => <span className="font-mono text-xs font-semibold" dir="ltr">{r.number}</span> },
            { key: 'd', header: t('acc.f.date'), cell: (r) => <span className="tabular-nums">{r.date}</span> },
            { key: 't', header: t('acc.f.jtype'), hideOnMobile: true, cell: (r) => <span className="text-xs">{t(`acc.jtype.${r.type}`)}</span> },
            { key: 's', header: t('acc.f.statement'), cell: (r) => <span>{r.description}{r.reference && <span className="block text-xs text-ink-muted">{r.reference}</span>}</span> },
            { key: 'a', header: t('acc.f.amount'), align: 'end', cell: (r) => <b className="tabular-nums" dir="ltr">{amt0(r.totalDebit)}</b> },
            { key: 'st', header: t('acc.f.status'), cell: (r) => <span className="flex flex-wrap gap-1"><Badge tone={STATUS_TONE[r.status]} dot={false}>{t(`acc.status.${r.status}`)}</Badge>{r.sourceType && <Badge tone="info" dot={false}>{t('acc.source.auto')}</Badge>}</span> },
            { key: 'u', header: t('acc.f.createdBy'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.createdBy}{r.updatedBy && <span className="block text-ink-muted">{t('acc.f.updatedBy')}: {r.updatedBy}</span>}<span className="block text-ink-muted">{fmtDateTime(r.createdAt)}</span></span> },
          ]}
          footer={total != null ? <tr><td colSpan={4} className="p-2 text-end font-bold">{t('acc.f.total')}</td><td className="p-2 text-end font-bold tabular-nums" dir="ltr">{amt0(total)}</td><td colSpan={2} /></tr> : undefined}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
