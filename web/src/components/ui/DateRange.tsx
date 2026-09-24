import { useTranslation } from 'react-i18next';
import { addDays, ymd } from '@/lib/format';
import { Input } from './form';

export interface Range {
  from: string;
  to: string;
}

export const presetRange = (key: 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth'): Range => {
  const now = new Date();
  switch (key) {
    case 'today': return { from: ymd(now), to: ymd(now) };
    case 'yesterday': { const y = addDays(now, -1); return { from: ymd(y), to: ymd(y) }; }
    case 'week': return { from: ymd(addDays(now, -6)), to: ymd(now) };
    case 'month': return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
    case 'lastMonth': return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  }
};

export function DateRangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const { t } = useTranslation();
  const presets = [
    ['today', t('common.today')], ['yesterday', t('common.yesterday')], ['week', t('common.thisWeek')], ['month', t('common.thisMonth')], ['lastMonth', t('common.lastMonth')],
  ] as const;
  const active = presets.find(([k]) => { const r = presetRange(k); return r.from === value.from && r.to === value.to; })?.[0];
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <div className="inline-flex flex-wrap rounded-xl bg-surface-sunken p-1">
        {presets.map(([k, label]) => (
          <button key={k} onClick={() => onChange(presetRange(k))} className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${active === k ? 'bg-white text-primary-700 shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} className="!h-9 w-[9.5rem]" aria-label={t('common.from')} />
        <span className="text-xs text-ink-muted">←</span>
        <Input type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} className="!h-9 w-[9.5rem]" aria-label={t('common.to')} />
      </div>
    </div>
  );
}
