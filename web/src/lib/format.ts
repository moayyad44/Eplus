import i18n from '@/i18n';

const locale = () => (i18n.language === 'en' ? 'en-GB' : 'ar-JO-u-nu-latn');

let currency = { symbol: 'د.أ', decimals: 3 };
export const setCurrency = (c: { symbol: string; decimals: number }) => (currency = c);

export const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

export const money = (v: unknown, withSymbol = true) => {
  const s = num(v).toLocaleString('en-US', { minimumFractionDigits: currency.decimals, maximumFractionDigits: currency.decimals });
  return withSymbol ? `${s} ${currency.symbol}` : s;
};

export const qty = (v: unknown) => num(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

const d = (v: string | Date) => (typeof v === 'string' ? new Date(v) : v);

export const fmtDate = (v?: string | Date | null) => (v ? d(v).toLocaleDateString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—');
/** For @db.Date values (stored as UTC midnight). */
export const fmtDay = (v?: string | null) => (v ? new Date(v).toLocaleDateString(locale(), { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }) : '—');
export const fmtTime = (v?: string | Date | null) => (v ? d(v).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDateTime = (v?: string | Date | null) => (v ? `${fmtDate(v)} ${fmtTime(v)}` : '—');
export const fmtWeekday = (v: string | Date) => d(v).toLocaleDateString(locale(), { weekday: 'long' });
export const fmtMonth = (v: string | Date) => d(v).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });

/** Minutes elapsed since a timestamp, e.g. waiting time. */
export const minutesSince = (v?: string | null) => (v ? Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 60_000)) : 0);
export const duration = (mins: number) => (mins < 60 ? `${mins} د` : `${Math.floor(mins / 60)} س ${mins % 60} د`);

export const ymd = (dt: Date = new Date()) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
export const addDays = (dt: Date, n: number) => {
  const x = new Date(dt);
  x.setDate(x.getDate() + n);
  return x;
};
export const startOfWeek = (dt: Date) => addDays(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()), -((dt.getDay() + 1) % 7)); // week starts Saturday
export const toLocalInput = (v?: string | Date | null) => {
  if (!v) return '';
  const x = d(v);
  return `${ymd(x)}T${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
};
