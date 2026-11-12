import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env';

/** A value encrypted at rest (AES-256-GCM). Only the server can read it; it never goes back to the browser. */
export interface Sealed { v: 1; iv: string; tag: string; data: string }

const key = () => Buffer.from(hkdfSync('sha256', env.SECRETS_KEY ?? env.JWT_SECRET, 'eplus-secrets', 'stored-credentials', 32));

export function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** null when missing or unreadable (e.g. the key changed): the value must then be entered again. */
export function unseal(s: Sealed | null | undefined): string | null {
  if (!s?.data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(s.iv, 'base64'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
