// Server runs with process.env.TZ set to the clinic timezone, so local date methods are clinic-local.

export const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
export const endOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
/** Local calendar date as YYYY-MM-DD. */
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** A `@db.Date` value for the local calendar day (stored as UTC midnight). */
export const dateOnly = (d: Date | string = new Date()) => {
  const s = typeof d === 'string' ? d.slice(0, 10) : ymd(d);
  return new Date(`${s}T00:00:00.000Z`);
};
/** Converts a stored `@db.Date` (UTC midnight) back to YYYY-MM-DD. */
export const dateOnlyStr = (d: Date) => d.toISOString().slice(0, 10);

/** Resolve a `from`/`to` query (YYYY-MM-DD) into an inclusive local datetime range. Defaults to today. */
export const rangeFromQuery = (from?: string, to?: string) => {
  const f = from ? startOfDay(new Date(`${from}T00:00:00`)) : startOfDay();
  const t = to ? endOfDay(new Date(`${to}T00:00:00`)) : endOfDay(f);
  return { from: f, to: t };
};

export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Combines a date (YYYY-MM-DD or Date) with "HH:mm" local time. */
export const atTime = (day: Date | string, hhmm: string) => {
  const base = typeof day === 'string' ? day.slice(0, 10) : dateOnlyStr(day);
  return new Date(`${base}T${hhmm}:00`);
};

export const ageFrom = (dob?: Date | null) => {
  if (!dob) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getUTCFullYear();
  const m = now.getMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getUTCDate())) age--;
  return age;
};
