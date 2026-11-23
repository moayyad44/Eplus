import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock, ShieldCheck, User } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Me } from '@/lib/types';
import { Button, Field, Input } from '@/components/ui';
import { Logo } from '@/components/layout/Logo';
import { LANGS } from '@/i18n';

export default function Login() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clinic = useQuery({ queryKey: ['public-clinic'], queryFn: () => api.get<{ name: string; hasLogo: boolean }>('/public/clinic'), retry: false });

  if (me) return <Navigate to={(loc.state as { from?: string })?.from ?? '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api.post<Me>('/auth/login', { username: username.trim(), password });
      qc.setQueryData(['me'], data);
      nav((loc.state as { from?: string })?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-primary-300 via-primary-400 to-primary-600 lg:block">
        <div className="absolute -start-24 -top-24 h-96 w-96 rounded-full bg-white/15" />
        <div className="absolute -bottom-32 -end-16 h-[28rem] w-[28rem] rounded-full bg-white/10" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-3" dir="ltr">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/20 backdrop-blur">
              <svg viewBox="0 0 24 24" className="h-7 w-7" fill="white"><path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z" /></svg>
            </span>
            <span className="text-2xl font-extrabold">EmergencyPlus</span>
          </div>
          <div>
            <h2 className="text-4xl font-bold leading-tight">{clinic.data?.name ?? 'EmergencyPlus'}</h2>
            <p className="mt-3 max-w-md text-lg text-white/85">{t('app.tagline')}</p>
          </div>
          <p className="flex items-center gap-2 text-sm text-white/80"><ShieldCheck className="h-4 w-4" />{t('auth.secure')}</p>
        </div>
      </div>
      <div className="flex flex-col items-center justify-center bg-white px-6 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-4 text-center">
            {clinic.data?.hasLogo ? <img src="/api/public/logo" alt="" className="h-16 w-auto" /> : <Logo size="lg" />}
            <div>
              <h1 className="text-2xl font-bold">{t('auth.title')}</h1>
              <p className="mt-1 text-sm text-ink-muted">{t('auth.subtitle')}</p>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Field label={t('auth.username')}>
              <div className="relative">
                <User className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus dir="ltr" className="ps-9 text-start" required />
              </div>
            </Field>
            <Field label={t('auth.password')}>
              <div className="relative">
                <Lock className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" dir="ltr" className="ps-9 text-start" required />
              </div>
            </Field>
            {error && <p className="rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-700" role="alert">{error}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>{busy ? t('auth.loggingIn') : t('auth.login')}</Button>
          </form>
          <div className="mt-8 flex justify-center gap-2">
            {LANGS.map((l) => (
              <button key={l.code} onClick={() => i18n.changeLanguage(l.code)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${i18n.language === l.code ? 'bg-primary-50 text-primary-700' : 'text-ink-muted hover:text-ink'}`}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
