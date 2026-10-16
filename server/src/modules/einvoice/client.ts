import type { Credentials } from './config';

/**
 * Sends one invoice to the national system and classifies the answer as described in the ISTD guide v1.5
 * (section 8): the final state comes from EINV_STATUS, not from the HTTP code alone.
 */

export type Outcome = 'SUBMITTED' | 'REJECTED' | 'FAILED' | 'UNKNOWN';

export interface SendResult {
  outcome: Outcome;
  httpStatus: number | null;
  einvStatus: string | null;
  qr: string | null;
  signedInvoice: string | null;
  einvNum: string | null;
  einvUuid: string | null;
  /** Short Arabic message for the user. */
  message: string | null;
  /** ERRORS / WARNINGS from EINV_RESULTS (no request data, no credentials). */
  errors: unknown;
  durationMs: number;
}

interface EinvResponse {
  EINV_STATUS?: string;
  EINV_QR?: string | null;
  EINV_SINGED_INVOICE?: string | null;
  EINV_NUM?: string | null;
  EINV_INV_UUID?: string | null;
  EINV_RESULTS?: { status?: string; ERRORS?: { EINV_CODE?: string; EINV_MESSAGE?: string }[]; WARNINGS?: unknown[] };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function classify(httpStatus: number | null, body: unknown, networkError: string | null, durationMs: number): SendResult {
  const b = (body && typeof body === 'object' ? body : {}) as EinvResponse;
  const einvStatus = str(b.EINV_STATUS)?.toUpperCase() ?? null;
  const base = {
    httpStatus, einvStatus, durationMs,
    qr: str(b.EINV_QR), signedInvoice: str(b.EINV_SINGED_INVOICE), einvNum: str(b.EINV_NUM), einvUuid: str(b.EINV_INV_UUID),
    errors: b.EINV_RESULTS ? { status: b.EINV_RESULTS.status ?? null, errors: b.EINV_RESULTS.ERRORS ?? [], warnings: b.EINV_RESULTS.WARNINGS ?? [] } : null,
  };
  if (networkError) return { ...base, outcome: 'UNKNOWN', message: `تعذر الاتصال بنظام الفوترة (${networkError}). ستُعاد المحاولة بنفس رقم الفاتورة` };
  // Accepted now, or accepted earlier with the same ID+UUID (the official way to recover the QR, p. 99).
  if (einvStatus === 'SUBMITTED' || einvStatus === 'ALREADY_SUBMITTED') {
    if (base.qr) return { ...base, outcome: 'SUBMITTED', message: null };
    return { ...base, outcome: 'UNKNOWN', message: 'رد الاعتماد لا يحتوي رمز QR. ستُعاد المحاولة بنفس رقم الفاتورة لاسترجاعه' };
  }
  const errs = (b.EINV_RESULTS?.ERRORS ?? []).map((e) => str(e?.EINV_MESSAGE) ?? str(e?.EINV_CODE)).filter(Boolean) as string[];
  if (einvStatus === 'NOT_SUBMITTED' || httpStatus === 400) {
    return { ...base, outcome: 'REJECTED', message: `رفض نظام الفوترة الفاتورة${errs.length ? `: ${errs.join(' — ')}` : ''}` };
  }
  if (httpStatus === 403) return { ...base, outcome: 'FAILED', message: 'رقم المستخدم (Client ID) أو المفتاح السري (Secret Key) غير صحيح' };
  if (httpStatus === 500) {
    return { ...base, outcome: 'FAILED', message: 'رفض نظام الفوترة الطلب (500): غالباً خطأ في الرقم الضريبي أو تسلسل مصدر الدخل، وأحياناً في بيانات الربط أو نسبة الضريبة' };
  }
  if (httpStatus === 504 || httpStatus === 502 || httpStatus === 503) {
    return { ...base, outcome: 'UNKNOWN', message: `لم يصل رد من نظام الفوترة (${httpStatus}). ستُعاد المحاولة بنفس رقم الفاتورة` };
  }
  if (httpStatus === 200) return { ...base, outcome: 'UNKNOWN', message: 'رد غير مفهوم من نظام الفوترة. ستُعاد المحاولة بنفس رقم الفاتورة' };
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) return { ...base, outcome: 'FAILED', message: `رفض نظام الفوترة الطلب (${httpStatus})${errs.length ? `: ${errs.join(' — ')}` : ''}` };
  return { ...base, outcome: 'UNKNOWN', message: `رد غير متوقع من نظام الفوترة (${httpStatus ?? '—'}). ستُعاد المحاولة بنفس رقم الفاتورة` };
}

/** POST {"invoice": base64(xml)} with the Client-Id / Secret-Key headers (guide p. 96). */
export async function postInvoice(url: string, creds: Credentials, xml: string, timeoutMs: number): Promise<SendResult> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Client-Id': creds.clientId, 'Secret-Key': creds.secretKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return classify(res.status, body, null, Date.now() - started);
  } catch (e) {
    const name = (e as Error)?.name;
    // Only a generic reason: the error object may carry the request (headers) and must not be logged.
    return classify(null, null, name === 'AbortError' ? 'انتهت مهلة الانتظار' : 'انقطاع الاتصال', Date.now() - started);
  } finally {
    clearTimeout(timer);
  }
}
