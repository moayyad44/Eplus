import type { Tx } from '../../lib/prisma';
import { nextCounter, pad } from '../../lib/counters';

/** Document numbers per type: RV-000001, PV-…, TT-…, CC-… */
export async function docNumber(tx: Tx, prefix: string, width = 6) {
  return `${prefix}-${pad(await nextCounter(tx, `acc-${prefix}`), width)}`;
}

/** One history line per change of a document (who, when, what changed, optional reason). */
export async function docRevision(tx: Tx, docType: string, docId: string, version: number, action: string, snapshot: unknown, userId: string | null, changes?: unknown, reason?: string | null) {
  await tx.docRevision.create({ data: { docType, docId, version, action, snapshot: snapshot as never, changes: (changes ?? undefined) as never, reason: reason || null, userId } });
}

export function diffFields(a: Record<string, unknown>, b: Record<string, unknown>) {
  return Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => ({ field: k, from: a[k] ?? null, to: b[k] ?? null }));
}

// ───── Amount in Arabic words (Jordanian dinar / fils) ─────
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(HUNDREDS[h]);
  if (r) parts.push(r < 20 ? ONES[r] : r % 10 ? `${ONES[r % 10]} و${TENS[Math.floor(r / 10)]}` : TENS[Math.floor(r / 10)]);
  return parts.join(' و');
}
function scale(n: number, one: string, two: string, few: string, many: string) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${below1000(n)} ${few}`;
  return `${below1000(n)} ${many}`;
}
function integerWords(n: number): string {
  if (n === 0) return 'صفر';
  const m = Math.floor(n / 1_000_000), t = Math.floor((n % 1_000_000) / 1000), r = n % 1000;
  const parts: string[] = [];
  if (m) parts.push(scale(m, 'مليون', 'مليونان', 'ملايين', 'مليون'));
  if (t) parts.push(scale(t, 'ألف', 'ألفان', 'آلاف', 'ألف'));
  if (r) parts.push(below1000(r));
  return parts.join(' و');
}
/** e.g. 1250.5 → «ألف ومائتان وخمسون ديناراً وخمسمائة فلس فقط لا غير» */
export function amountInWords(v: number) {
  const fils = Math.round(v * 1000);
  const d = Math.floor(fils / 1000), f = fils % 1000;
  const dWord = d === 0 ? '' : d === 1 ? 'دينار واحد' : d === 2 ? 'ديناران' : `${integerWords(d)} ${d % 100 >= 3 && d % 100 <= 10 ? 'دنانير' : 'ديناراً'}`;
  const fWord = f ? `${integerWords(f)} فلس` : '';
  return `${[dWord, fWord].filter(Boolean).join(' و') || 'صفر'} فقط لا غير`;
}
