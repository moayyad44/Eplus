import ExcelJS from 'exceljs';

/**
 * Excel helpers for EmergencyPlus Accounting: Arabic, right-to-left sheets, frozen header with filters,
 * JOD amounts with 3 decimals, and a reader that accepts .xlsx and .csv.
 */
export const JOD = '#,##0.000;[Red]-#,##0.000';

export interface Col { header: string; key: string; width?: number; money?: boolean; date?: boolean }

export function addSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[], opts: { title?: string; totals?: string[] } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: opts.title ? 2 : 1 }] });
  let headerRow = 1;
  if (opts.title) {
    ws.mergeCells(1, 1, 1, cols.length);
    const t = ws.getCell(1, 1);
    t.value = opts.title; t.font = { bold: true, size: 14, color: { argb: 'FF0B4F6C' } }; t.alignment = { horizontal: 'center' };
    headerRow = 2;
  }
  const h = ws.getRow(headerRow);
  cols.forEach((c, i) => {
    const cell = h.getCell(i + 1);
    cell.value = c.header; cell.font = { bold: true, color: { argb: 'FF0B4F6C' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDF0FB' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF7FB8D6' } } };
    ws.getColumn(i + 1).width = c.width ?? Math.max(12, c.header.length + 4);
    if (c.money) ws.getColumn(i + 1).numFmt = JOD;
    if (c.date) ws.getColumn(i + 1).numFmt = 'yyyy-mm-dd';
  });
  rows.forEach((r, ri) => { const row = ws.getRow(headerRow + 1 + ri); cols.forEach((c, i) => { row.getCell(i + 1).value = (r[c.key] ?? null) as ExcelJS.CellValue; }); });
  const last = headerRow + rows.length;
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(last, headerRow), column: cols.length } };
  if (opts.totals?.length && rows.length) {
    const tr = ws.getRow(last + 1);
    tr.getCell(1).value = 'الإجمالي'; tr.font = { bold: true };
    for (const k of opts.totals) {
      const i = cols.findIndex((c) => c.key === k) + 1;
      const letter = ws.getColumn(i).letter;
      tr.getCell(i).value = { formula: `SUBTOTAL(9,${letter}${headerRow + 1}:${letter}${last})` };
    }
  }
  return ws;
}

/** Reads the sheets of an .xlsx or a .csv file as rows of plain values. */
export async function readTable(buf: Buffer, name: string): Promise<{ sheets: { name: string; rows: unknown[][] }[] }> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(name)) {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(splitCsv);
    return { sheets: [{ name: 'CSV', rows }] };
  }
  await wb.xlsx.load(buf as never);
  const sheets = wb.worksheets.map((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1).map((v) => {
        if (v && typeof v === 'object') {
          const o = v as { result?: unknown; text?: string; richText?: { text: string }[] };
          if ('result' in o) return o.result;
          if (o.richText) return o.richText.map((x) => x.text).join('');
          if (o.text) return o.text;
          if (v instanceof Date) return v.toISOString().slice(0, 10);
        }
        return v;
      });
      rows.push(vals);
    });
    return { name: ws.name, rows };
  });
  return { sheets };
}

function splitCsv(line: string) {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A number from a cell: accepts "1,234.500", "(12)", empty. NaN when the text is not a number. */
export function toAmount(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[,\s]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}
