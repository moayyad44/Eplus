import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/** Validated categorical order (see dataviz validator): primary blue, then burnt orange. */
export const SERIES = ['#2389c2', '#c2410c'];
const AXIS = { fontSize: 11, fill: '#6b8093' };

interface Series { key: string; label: string }

/** Vertical bars over a category/time axis. One series → no legend; two → legend. */
export function BarsChart<T extends object>({ data, x, series, height = 240, format, xFormat }: { data: T[]; x: keyof T & string; series: Series[]; height?: number; format?: (v: number) => string; xFormat?: (v: string) => string }) {
  return (
    <div style={{ height }} dir="ltr">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="#e1e8ee" />
          <XAxis dataKey={x} tick={AXIS} tickLine={false} axisLine={{ stroke: '#cbd6df' }} tickFormatter={xFormat} interval="preserveStartEnd" />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => (format ? format(v) : String(v))} />
          <Tooltip
            cursor={{ fill: 'rgba(62,166,222,0.08)' }}
            contentStyle={{ borderRadius: 12, border: '1px solid #e1e8ee', fontFamily: 'inherit', fontSize: 12, direction: 'rtl' }}
            formatter={(v: number, name: string) => [format ? format(v) : v, name]}
            labelFormatter={(l: string) => (xFormat ? xFormat(l) : l)}
          />
          {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i]} radius={[4, 4, 0, 0]} maxBarSize={28} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal share bars in plain HTML (payment methods etc.) — readable labels, no legend needed. */
export function ShareBars({ rows, format }: { rows: { label: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${format(r.value)}`}>
          <div className="mb-1 flex justify-between text-sm"><span className="font-semibold text-ink">{r.label}</span><span className="tabular-nums text-ink-soft">{format(r.value)} <span className="text-xs text-ink-muted">({total ? Math.round((r.value / total) * 100) : 0}%)</span></span></div>
          <div className="h-2 rounded-full bg-surface-sunken"><div className="h-2 rounded-full bg-primary-600" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
