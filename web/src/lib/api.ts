export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** Field → message map for validation errors. */
  get fields(): Record<string, string> {
    return this.code === 'VALIDATION' && this.details && typeof this.details === 'object' ? (this.details as Record<string, string>) : {};
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export const qs = (q?: Query) => {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

let refreshing: Promise<boolean> | null = null;
const refreshOnce = () => {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'EmergencyPlus' } })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
};

export const authEvents = new EventTarget();

async function request<T>(method: string, url: string, body?: unknown, retry = true): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: 'include',
      headers: { ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Requested-With': 'EmergencyPlus' },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'تعذر الاتصال بالخادم. تحقق من الشبكة');
  }
  if (res.status === 401 && retry && !url.startsWith('/auth/login') && !url.startsWith('/auth/refresh')) {
    if (await refreshOnce()) return request<T>(method, url, body, false);
    authEvents.dispatchEvent(new Event('unauthorized'));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'حدث خطأ غير متوقع', e.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string, q?: Query) => request<T>('GET', url + qs(q)),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, form),
};

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}
