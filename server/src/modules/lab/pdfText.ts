/** Text of a PDF as lines of positioned words (pdf.js, pure JavaScript — works the same on Windows and Linux, nothing leaves the server). */
export interface Word { x: number; x2: number; s: string }
export interface Line { page: number; y: number; words: Word[]; text: string }

// A real dynamic import (pdf.js is an ES module; this project compiles to CommonJS).
const esm = new Function('m', 'return import(m)') as (m: string) => Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>;

async function loadPdfjs() {
  try {
    return await esm('pdfjs-dist/legacy/build/pdf.mjs'); // the built server (CommonJS)
  } catch {
    return await import('pdfjs-dist/legacy/build/pdf.mjs'); // tests (already ES modules)
  }
}

export async function pdfLines(data: Buffer): Promise<Line[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const out: Line[] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 30); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows: { y: number; words: Word[] }[] = [];
      for (const it of tc.items as { str: string; transform: number[]; width: number }[]) {
        const s = it.str.normalize('NFKC').replace(/[‎‏‪-‮]/g, '');
        if (!s.trim()) continue;
        const x = it.transform[4], y = it.transform[5];
        let row = rows.find((r) => Math.abs(r.y - y) < 3);
        if (!row) { row = { y, words: [] }; rows.push(row); }
        row.words.push({ x, x2: x + it.width, s: s.trim() });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.words.sort((a, b) => a.x - b.x);
        // join pieces that touch (pdf.js may split one word into several items)
        const words: Word[] = [];
        for (const w of r.words) {
          const last = words[words.length - 1];
          if (last && w.x - last.x2 < 2.5) { last.s += (w.x - last.x2 > 0.8 ? ' ' : '') + w.s; last.x2 = w.x2; } else words.push({ ...w });
        }
        out.push({ page: p, y: r.y, words, text: words.map((w) => w.s).join(' ') });
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
