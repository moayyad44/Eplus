import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronLeft, Circle, Rocket, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge, Card, CardHeader, IconButton } from '@/components/ui';

interface Setup { items: { key: string; done: boolean; optional?: boolean; link: string }[] }

const storageKey = (userId: string) => `ep.setupHidden.${userId}`;
const read = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };

/** Go-live checklist on the admin dashboard; disappears once every required step is done (or when hidden). */
export function SetupChecklist() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { me } = useAuth();
  const key = storageKey(me?.user.id ?? '');
  const [hidden, setHidden] = useState(() => read(key));
  const q = useQuery({ queryKey: ['dashboard', 'setup'], queryFn: () => api.get<Setup>('/dashboard/setup'), enabled: !hidden });
  if (hidden || !q.data) return null;
  const items = q.data.items;
  const required = items.filter((i) => !i.optional);
  if (required.every((i) => i.done)) return null;
  const doneCount = items.filter((i) => i.done).length;
  const hide = () => { try { localStorage.setItem(key, '1'); } catch { /* private mode */ } setHidden(true); };

  return (
    <Card className="mb-4 border-primary-200">
      <CardHeader
        icon={<Rocket className="h-5 w-5" />}
        title={t('dashboard.setup.title')}
        subtitle={t('dashboard.setup.subtitle', { done: doneCount, total: items.length })}
        actions={<IconButton label={t('dashboard.setup.hide')} onClick={hide}><X className="h-4 w-4" /></IconButton>}
      />
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-surface-sunken">
        <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${(doneCount / items.length) * 100}%` }} />
      </div>
      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((i) => (
          <li key={i.key}>
            <button
              onClick={() => nav(i.link)}
              className={clsx('flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-start transition hover:border-primary-300 hover:bg-primary-50/50', i.done ? 'border-success-100 bg-success-50/40' : 'border-line')}
            >
              {i.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-600" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" />}
              <span className="min-w-0 flex-1">
                <span className={clsx('flex flex-wrap items-center gap-2 text-sm font-semibold', i.done ? 'text-ink-soft' : 'text-ink')}>
                  {t(`dashboard.setup.items.${i.key}.title`)}
                  {i.optional && !i.done && <Badge tone="neutral" dot={false}>{t('dashboard.setup.optional')}</Badge>}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{t(`dashboard.setup.items.${i.key}.hint`)}</span>
              </span>
              {!i.done && <ChevronLeft className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
