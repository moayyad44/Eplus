/** Verifies every literal t('key') used in src/ exists in the Arabic (reference) dictionary. */
import fs from 'node:fs';
import path from 'node:path';
import ar from '../src/i18n/ar/index';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src');
const files: string[] = [];
const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) && files.push(path.join(d, e.name))));
walk(root);

const has = (key: string) => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ar) !== undefined;
const missing = new Map<string, string>();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) if (!has(m[1])) missing.set(m[1], path.relative(root, f));
  // Keys built from label strings in nav config
  for (const m of src.matchAll(/label: '((?:nav|common)\.[a-zA-Z0-9_.]+)'/g)) if (!has(m[1])) missing.set(m[1], path.relative(root, f));
}
if (missing.size) {
  console.error(`Missing ${missing.size} i18n keys:`);
  for (const [k, f] of missing) console.error(`  ${k}  (${f})`);
  process.exit(1);
}
console.log(`i18n OK — ${files.length} files checked`);
