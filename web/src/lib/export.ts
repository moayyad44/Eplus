/** CSV export with UTF-8 BOM so Excel opens Arabic text correctly. */
export function exportCsv<T>(filename: string, columns: { header: string; value: (r: T) => unknown }[], rows: T[]) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a print route in a new tab (print pages call window.print() once loaded). */
export const openPrint = (path: string) => window.open(`/print${path}`, '_blank', 'noopener');
