import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Archive, KeyRound, Pencil, ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import type { StaffType } from '@/lib/types';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, IconButton, Input, PageHeader, Pagination, SearchInput, Select, useConfirm } from '@/components/ui';

interface U { id: string; username: string; fullName: string; phone: string | null; email: string | null; staffType: StaffType; specialty: string | null; licenseNumber: string | null; isActive: boolean; loginEnabled: boolean; lastLoginAt: string | null; lockedUntil: string | null; mustChangePassword: boolean; role: { id: string; key: string; name: string } }
interface Role { id: string; key: string; name: string; permissions: string[] }
interface Perm { key: string; module: string; description: string }
const TYPES: StaffType[] = ['ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'ACCOUNTANT', 'OTHER'];

export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
export const usePermissionCatalog = () => useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Perm[]>('/roles/permissions'), staleTime: Infinity });

export default function Users() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const roles = useRoles();
  const list = usePagedList<U, { staffType?: string; roleId?: string; active?: string }>('users', '/users', { pageSize: 30 });
  const [edit, setEdit] = useState<Partial<U> | null>(null);
  const [reset, setReset] = useState<U | null>(null);
  const [perms, setPerms] = useState<U | null>(null);
  const archive = useApiMutation((id: string) => api.del(`/users/${id}`), { invalidate: [['users']], success: t('common.done') });
  useEffect(() => { const f = params.get('focus'); if (f) api.get<U>(`/users/${f}`).then(setEdit).catch(() => undefined); }, [params]);
  return (
    <div>
      <PageHeader title={t('staff.users')} subtitle={t('staff.usersSubtitle')} actions={can('users.manage') && <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setEdit({})}>{t('staff.newUser')}</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <SearchInput value={list.q} onChange={list.setSearch} placeholder={t('common.searchPlaceholder')} className="w-full sm:w-64" />
          <Select value={list.filters.staffType ?? ''} onChange={(e) => list.setFilters({ staffType: e.target.value || undefined })} className="w-auto">
            <option value="">{t('staff.staffType')}: {t('common.all')}</option>
            {TYPES.map((x) => <option key={x} value={x}>{t(`enum.StaffType.${x}`)}</option>)}
          </Select>
          <Select value={list.filters.roleId ?? ''} onChange={(e) => list.setFilters({ roleId: e.target.value || undefined })} className="w-auto">
            <option value="">{t('staff.role')}: {t('common.all')}</option>
            {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
          <Select value={list.filters.active ?? ''} onChange={(e) => list.setFilters({ active: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.status')}: {t('common.all')}</option>
            <option value="true">{t('common.active')}</option>
            <option value="false">{t('common.inactive')}</option>
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.query.isFetching}
          error={list.query.error}
          rowKey={(r) => r.id}
          rowClassName={(r) => (r.isActive ? undefined : 'opacity-60')}
          columns={[
            { key: 'n', header: t('staff.fullName'), cell: (r) => <><b>{r.fullName}</b><span className="block text-xs text-ink-muted" dir="ltr">@{r.username}</span></> },
            { key: 't', header: t('staff.staffType'), cell: (r) => <>{t(`enum.StaffType.${r.staffType}`)}{r.specialty && <span className="block text-xs text-ink-muted">{r.specialty}</span>}</> },
            { key: 'r', header: t('staff.role'), cell: (r) => <Badge tone="primary" dot={false}>{r.role.name}</Badge> },
            { key: 'p', header: t('common.phone'), hideOnMobile: true, cell: (r) => <span dir="ltr">{r.phone ?? '—'}</span> },
            { key: 's', header: t('common.status'), cell: (r) => <span className="flex flex-wrap gap-1"><Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? t('common.active') : t('common.inactive')}</Badge>{r.lockedUntil && new Date(r.lockedUntil) > new Date() && <Badge tone="danger">{t('staff.locked')}</Badge>}</span> },
            { key: 'l', header: t('staff.lastLogin'), hideOnMobile: true, cell: (r) => <span className="text-xs">{fmtDateTime(r.lastLoginAt)}</span> },
            {
              key: 'x', header: '', cell: (r) => can('users.manage') && (
                <div className="flex gap-0.5">
                  <IconButton size="sm" label={t('common.edit')} onClick={() => setEdit(r)}><Pencil className="h-4 w-4" /></IconButton>
                  <IconButton size="sm" label={t('staff.resetPassword')} onClick={() => setReset(r)}><KeyRound className="h-4 w-4" /></IconButton>
                  {can('roles.manage') && <IconButton size="sm" label={t('staff.permissions')} onClick={() => setPerms(r)}><ShieldCheck className="h-4 w-4" /></IconButton>}
                  <IconButton size="sm" label={t('common.archive')} onClick={async () => (await confirm({ message: t('staff.archiveConfirm'), danger: true })) && archive.mutate(r.id)}><Archive className="h-4 w-4 text-danger-600" /></IconButton>
                </div>
              ),
            },
          ]}
        />
        {list.data && <Pagination {...list.data} onPage={list.setPage} />}
      </Card>
      {edit && <UserDialog user={edit} roles={roles.data ?? []} onClose={() => setEdit(null)} />}
      {reset && <ResetDialog user={reset} onClose={() => setReset(null)} />}
      {perms && <OverridesDialog user={perms} roles={roles.data ?? []} onClose={() => setPerms(null)} />}
    </div>
  );
}

function UserDialog({ user, roles, onClose }: { user: Partial<U>; roles: Role[]; onClose: () => void }) {
  const { t } = useTranslation();
  const isNew = !user.id;
  const [v, setV] = useState({
    username: user.username ?? '', fullName: user.fullName ?? '', phone: user.phone ?? '', email: user.email ?? '', roleId: user.role?.id ?? '', staffType: user.staffType ?? 'OTHER',
    specialty: user.specialty ?? '', licenseNumber: user.licenseNumber ?? '', password: '', isActive: user.isActive ?? true, loginEnabled: user.loginEnabled ?? true,
  });
  const save = useApiMutation(() => {
    const { username, password, ...rest } = v;
    return isNew ? api.post('/users', { ...rest, username, password }) : api.put(`/users/${user.id}`, rest);
  }, { invalidate: [['users']], onSuccess: onClose });
  const fe = save.fieldErrors;
  const f = (k: 'username' | 'fullName' | 'phone' | 'email' | 'specialty' | 'licenseNumber' | 'password') => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  return (
    <Dialog open onClose={onClose} size="lg" title={isNew ? t('staff.newUser') : t('staff.editUser')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('staff.fullName')} required error={fe.fullName}><Input {...f('fullName')} /></Field>
        <Field label={t('staff.username')} required error={fe.username}><Input {...f('username')} disabled={!isNew} dir="ltr" autoComplete="off" /></Field>
        {isNew && <Field label={t('staff.password')} required error={fe.password} hint={t('auth.passwordHint')}><Input type="password" {...f('password')} autoComplete="new-password" /></Field>}
        <Field label={t('staff.role')} required error={fe.roleId}><Select value={v.roleId} onChange={(e) => setV({ ...v, roleId: e.target.value })} placeholder={t('common.select')}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        <Field label={t('staff.staffType')}><Select value={v.staffType} onChange={(e) => setV({ ...v, staffType: e.target.value as StaffType })}>{TYPES.map((x) => <option key={x} value={x}>{t(`enum.StaffType.${x}`)}</option>)}</Select></Field>
        <Field label={t('staff.specialty')}><Input {...f('specialty')} /></Field>
        <Field label={t('common.phone')} error={fe.phone}><Input {...f('phone')} dir="ltr" /></Field>
        <Field label={t('common.email')} error={fe.email}><Input {...f('email')} dir="ltr" /></Field>
        <Field label={t('staff.license')}><Input {...f('licenseNumber')} dir="ltr" /></Field>
        <div className="flex items-center gap-6 sm:col-span-2">
          <Checkbox label={t('staff.active')} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
          <Checkbox label={t('staff.loginEnabled')} checked={v.loginEnabled} onChange={(e) => setV({ ...v, loginEnabled: e.target.checked })} />
        </div>
      </div>
    </Dialog>
  );
}

function ResetDialog({ user, onClose }: { user: U; onClose: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const save = useApiMutation(() => api.post(`/users/${user.id}/reset-password`, { password: pw }), { success: t('staff.passwordReset'), onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={t('staff.resetPassword')} subtitle={user.fullName} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <Field label={t('staff.newPassword')} hint={t('auth.passwordHint')} error={save.fieldErrors.password}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
    </Dialog>
  );
}

function OverridesDialog({ user, roles, onClose }: { user: U; roles: Role[]; onClose: () => void }) {
  const { t } = useTranslation();
  const catalog = usePermissionCatalog();
  const detail = useQuery({ queryKey: ['users', user.id], queryFn: () => api.get<{ permissionOverrides: { permissionKey: string; allow: boolean }[] }>(`/users/${user.id}`) });
  const [ov, setOv] = useState<Record<string, boolean | undefined>>({});
  useEffect(() => { if (detail.data) setOv(Object.fromEntries(detail.data.permissionOverrides.map((o) => [o.permissionKey, o.allow]))); }, [detail.data]);
  const rolePerms = new Set(roles.find((r) => r.id === user.role.id)?.permissions ?? []);
  const save = useApiMutation(() => api.put(`/users/${user.id}/permissions`, { overrides: Object.entries(ov).filter(([, a]) => a !== undefined).map(([permissionKey, allow]) => ({ permissionKey, allow })) }), { invalidate: [['users']], onSuccess: onClose });
  const modules = [...new Set(catalog.data?.map((p) => p.module))];
  return (
    <Dialog open onClose={onClose} size="lg" title={`${t('staff.permissions')} — ${user.fullName}`} subtitle={t('staff.permissionsHint')} footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        {modules.map((m) => (
          <div key={m}>
            <p className="mb-1 text-xs font-bold text-ink-muted">{t(`settings.modules.${m}`)}</p>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {catalog.data!.filter((p) => p.module === m).map((p) => (
                <li key={p.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>{p.description} {rolePerms.has(p.key) && <Badge tone="info" dot={false}>{t('staff.fromRole')}</Badge>}</span>
                  <Select value={ov[p.key] === undefined ? '' : ov[p.key] ? 'allow' : 'deny'} onChange={(e) => setOv({ ...ov, [p.key]: e.target.value === '' ? undefined : e.target.value === 'allow' })} className="!h-8 w-32 text-xs">
                    <option value="">{t('staff.inherit')}</option>
                    <option value="allow">{t('staff.grant')}</option>
                    <option value="deny">{t('staff.deny')}</option>
                  </Select>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
