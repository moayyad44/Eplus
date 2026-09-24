import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { KeyRound, LaptopMinimal, ShieldAlert, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader } from '@/components/ui';

export default function Account() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ id: string; ip: string; userAgent: string; lastUsedAt: string; current: boolean }[]>('/auth/sessions') });
  const change = useApiMutation(() => api.post('/auth/change-password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }), {
    success: t('auth.passwordChanged'),
    invalidate: [['sessions']],
    onSuccess: () => { setPw({ currentPassword: '', newPassword: '', confirm: '' }); refresh(); },
  });
  const revoke = useApiMutation((id: string) => api.del(`/auth/sessions/${id}`), { invalidate: [['sessions']], success: t('common.done') });
  const mismatch = pw.confirm.length > 0 && pw.confirm !== pw.newPassword;
  if (!me) return null;
  const u = me.user;
  return (
    <div>
      <PageHeader title={t('account.title')} subtitle={t('account.subtitle')} />
      {(params.get('force') || u.mustChangePassword) && (
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-warning-100 bg-warning-50 px-4 py-3 text-sm text-warning-700">
          <ShieldAlert className="h-5 w-5" /> {t('auth.mustChange')}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('auth.profile')} icon={<UserRound className="h-5 w-5" />} />
          <dl className="grid grid-cols-2 gap-4 text-sm">
            {[
              [t('common.name'), u.fullName], [t('auth.username'), u.username], [t('auth.role'), u.role.name], [t('common.type'), t(`enum.StaffType.${u.staffType}`)],
              [t('common.phone'), u.phone ?? '—'], [t('common.email'), u.email ?? '—'], [t('auth.lastLogin'), fmtDateTime(u.lastLoginAt)],
            ].map(([k, v]) => (
              <div key={k as string}><dt className="text-xs text-ink-muted">{k}</dt><dd className="mt-0.5 font-semibold">{v}</dd></div>
            ))}
          </dl>
        </Card>
        <Card>
          <CardHeader title={t('auth.changePassword')} icon={<KeyRound className="h-5 w-5" />} />
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!mismatch) change.mutate(undefined); }}>
            <Field label={t('auth.currentPassword')} error={change.fieldErrors.currentPassword}>
              <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} autoComplete="current-password" required />
            </Field>
            <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')} error={change.fieldErrors.newPassword}>
              <Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} autoComplete="new-password" required />
            </Field>
            <Field label={t('auth.confirmPassword')} error={mismatch ? t('auth.passwordMismatch') : undefined}>
              <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" required invalid={mismatch} />
            </Field>
            <Button type="submit" loading={change.isPending} disabled={mismatch}>{t('auth.changePassword')}</Button>
          </form>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={t('auth.sessions')} icon={<LaptopMinimal className="h-5 w-5" />} />
          <ul className="divide-y divide-line">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block max-w-xl truncate font-medium" dir="ltr">{s.userAgent || '—'}</span>
                  <span className="text-xs text-ink-muted">{s.ip} · {t('auth.lastUsed')}: {fmtDateTime(s.lastUsedAt)}</span>
                </span>
                {s.current ? <Badge tone="success">{t('auth.currentSession')}</Badge> : (
                  <Button size="sm" variant="outline" loading={revoke.isPending} onClick={() => revoke.mutate(s.id, { onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) })}>{t('auth.revoke')}</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
