import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * File storage abstraction. The local-disk driver is used today; an S3-compatible driver can
 * implement the same interface later without touching the modules.
 */
export interface StorageDriver {
  put(buffer: Buffer, originalName: string): Promise<string>;
  stream(key: string): fs.ReadStream;
  exists(key: string): Promise<boolean>;
}

const root = path.resolve(env.UPLOAD_DIR);

const safePath = (key: string) => {
  const p = path.resolve(root, key);
  if (!p.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return p;
};

export const storage: StorageDriver = {
  async put(buffer, originalName) {
    const now = new Date();
    const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const key = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}${ext}`;
    const full = safePath(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer, { flag: 'wx' });
    return key;
  },
  stream: (key) => fs.createReadStream(safePath(key)),
  async exists(key) {
    try {
      await fsp.access(safePath(key));
      return true;
    } catch {
      return false;
    }
  },
};

export const ALLOWED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain',
]);

/** Verifies magic bytes for the common types so a renamed executable cannot pass as a PDF/image. */
export function sniffMatches(buffer: Buffer, mime: string) {
  const b = buffer.subarray(0, 12);
  const starts = (sig: number[]) => sig.every((x, i) => b[i] === x);
  switch (mime) {
    case 'application/pdf': return starts([0x25, 0x50, 0x44, 0x46]);
    case 'image/jpeg': return starts([0xff, 0xd8, 0xff]);
    case 'image/png': return starts([0x89, 0x50, 0x4e, 0x47]);
    case 'image/gif': return starts([0x47, 0x49, 0x46]);
    case 'image/webp': return starts([0x52, 0x49, 0x46, 0x46]) && b.subarray(8, 12).toString() === 'WEBP';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return starts([0x50, 0x4b, 0x03, 0x04]);
    default: return true;
  }
}
