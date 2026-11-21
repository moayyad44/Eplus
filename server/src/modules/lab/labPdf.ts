import type { Line, Word } from './pdfText';

/**
 * Reads a laboratory report PDF (laid out as produced by the referral lab's system) into results:
 * name, value, unit, normal range and the high/low arrow. Then matches every result to a test of the order.
 * Nothing is saved here: the screen fills the boxes and the user reviews before saving.
 */
export interface ParsedResult { name: string; key: string | null; group: string | null; section: string | null; value: string; unit: string; referenceRange: string; flag: 'HIGH' | 'LOW' | 'NORMAL' | null; notes: string | null }
export interface ParsedHeader { patientName: string | null; fileNo: string | null; visitNo: string | null; sampleDate: string | null; gender: string | null; age: string | null }

const ARROW = /^[↑↓]$/;
const NUM = /^[<>≤≥]?\s*-?\d+(\.\d+)?$/;
const HEADER = /^(Patient Name|File No\.?|Visit No\.?|Consultant|Age|Gender|Sample Date)/i;
const FOOTER = /^(Result Entered|Printed (By|At)|\d+\s*\/\s*\d+$)/i;
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const arabic = (s: string) => /[؀-ۿ]/.test(s);

/** Arabic text comes out of the PDF in visual order: words and letters reversed. */
function fixArabic(words: string[]) {
  return words.filter((w) => arabic(w)).map((w) => [...w].reverse().join('')).reverse().join(' ');
}

export function parseHeader(lines: Line[]): ParsedHeader {
  const h: ParsedHeader = { patientName: null, fileNo: null, visitNo: null, sampleDate: null, gender: null, age: null };
  const after = (l: Line, label: RegExp) => {
    const i = l.words.findIndex((w) => label.test(w.s));
    if (i < 0) return null;
    const rest: string[] = [];
    for (let j = i + 1; j < l.words.length; j++) { if (/^(Age|Gender|Sample Date\/Time|File No\.|Visit No\.)$/i.test(l.words[j].s)) break; rest.push(l.words[j].s); }
    return clean(rest.join(' ').replace(/^:\s*/, '').replace(/\s*\.$/, '')) || null;
  };
  for (const l of lines.filter((x) => x.page === 1)) {
    if (/^Patient Name/i.test(l.text)) {
      const i = l.words.findIndex((w) => /^Age$/i.test(w.s));
      const nameWords = l.words.slice(1, i < 0 ? undefined : i).map((w) => w.s.replace(/^:\s*/, '')).filter((s) => s && s !== ':' && s !== '.');
      h.patientName = nameWords.some(arabic) ? fixArabic(nameWords) : clean(nameWords.join(' '));
      h.age = after(l, /^Age$/i);
    }
    if (/^File No/i.test(l.text)) { h.fileNo = after(l, /^File No\.?$/i); h.gender = after(l, /^Gender$/i); }
    if (/^Visit No/i.test(l.text)) { h.visitNo = after(l, /^Visit No\.?$/i); h.sampleDate = after(l, /^Sample Date\/Time$/i); }
  }
  return h;
}

/** Value tokens of a column: [arrow] value [unit…]. */
function readValue(words: Word[]) {
  let i = 0, flag: ParsedResult['flag'] = null;
  if (words[i] && ARROW.test(words[i].s)) { flag = words[i].s === '↑' ? 'HIGH' : 'LOW'; i++; }
  if (!words[i]) return null;
  // value and unit may arrive as one piece ("0.1-0.3 mg/dl" in ranges, "17 mm/hr")
  const parts = words.slice(i).map((w) => w.s).join(' ').split(' ');
  let value = parts.shift() ?? '';
  if (/^[<>≤≥]$/.test(value) && parts.length) value += parts.shift();
  if (/^(Less|More|up|Up)$/i.test(value)) { value = [value, ...parts].join(' '); return { flag, value: clean(value), unit: '' }; }
  return { flag, value, unit: clean(parts.join(' ')) };
}

const isRangeText = (s: string) => /\d/.test(s) || /^(negative|positive|nil|absent)/i.test(s);

export function parseResults(lines: Line[]): ParsedResult[] {
  const out: ParsedResult[] = [];
  let section: string | null = null;
  let group: string | null = null;
  let groupIsSub = false; // a heading whose lines are sub-results ("1st Hour:") does not cover the tests after it
  let cols: { si: number; conv: number } | null = null; // "SI Unit | Conventional Unit" layout
  let rangeX: number | null = null; // hematology table: "Normal Range" column
  let cur: ParsedResult | null = null;
  let curZone: 'si' | 'conv' | 'main' = 'main';
  let inRanges = false;
  let ranges: string[] = [], siRanges: string[] = [];
  let prevY: number | null = null, prevPage = 0;

  const flush = () => {
    if (!cur) return;
    const rs = (curZone === 'si' ? siRanges : ranges).filter(Boolean);
    if (rs.length) {
      const all = rs.join(' | ');
      cur.referenceRange = all.length <= 120 ? all : `${all.slice(0, 117)}…`;
      if (all.length > 120) cur.notes = [cur.notes, `المعدل الطبيعي: ${all}`].filter(Boolean).join(' — ');
    }
    if (!cur.flag && cur.referenceRange && /\d/.test(cur.value)) cur.flag = 'NORMAL';
    out.push(cur);
    cur = null; ranges = []; siRanges = []; inRanges = false;
  };

  for (const l of lines) {
    const t = l.text;
    if (HEADER.test(t) || FOOTER.test(t) || /@|^\d{6,}/.test(t) || (l.words.every((w) => arabic(w.s) || /^[\d.\-:]+$/.test(w.s)) && l.words.some((w) => arabic(w.s)))) continue;
    const gap = prevPage === l.page && prevY != null ? prevY - l.y : Infinity; // a new page ends the ranges of the result above
    prevY = l.y; prevPage = l.page;
    const first = l.words[0];

    // column headers
    if (/^Test$/i.test(first.s) && l.words.some((w) => /SI Unit/i.test(w.s))) {
      const si = l.words.find((w) => /SI Unit/i.test(w.s))!, conv = l.words.find((w) => /Conventional/i.test(w.s));
      cols = { si: si.x, conv: conv ? conv.x : si.x + 140 };
      continue;
    }
    if (/^Normal Range\s*\(/i.test(t)) { rangeX = first.x; cols = null; continue; }
    // section title: one centred word in capitals or a known title
    if (l.words.length === 1 && first.x > 150 && !/\d/.test(first.s) && /^[A-Za-z &]+$/.test(first.s)) { flush(); section = first.s; group = null; rangeX = null; continue; }

    // "Normal Ranges:" — start of the ranges of the result above
    if (/^Normal Ranges?:?$/i.test(first.s)) {
      inRanges = true;
      const rest = l.words.slice(1);
      if (rest.length) addRange(rest, null);
      continue;
    }
    if (inRanges && cur && gap < 24) { // lines that follow belong to the ranges
      const label = l.words.filter((w) => valueZone(w) === null).map((w) => w.s).join(' ');
      addRange(l.words.filter((w) => valueZone(w) !== null), label || null);
      continue;
    }
    if (inRanges) flush();

    // a hematology-style row: name | [arrow] value [% abs] | unit | range
    if (rangeX != null && first.x < 120) {
      flush();
      const name = clean(first.s.replace(/:$/, '').replace(/\b([A-Z]) (?=[A-Z]\b)/g, '$1').replace(/ - /g, '-'));
      const rest = l.words.slice(1);
      const range = rest.filter((w) => w.x >= rangeX! - 10).map((w) => w.s).join(' ');
      const vals = rest.filter((w) => w.x < rangeX! - 10);
      let flag: ParsedResult['flag'] = null, k = 0;
      if (vals[k] && ARROW.test(vals[k].s)) { flag = vals[k].s === '↑' ? 'HIGH' : 'LOW'; k++; }
      const v = vals[k]?.s ?? '';
      if (vals[k + 1]?.s === '%' && vals[k + 2] && NUM.test(vals[k + 2].s)) {
        // differential count: percentage and absolute number
        const unit = clean(vals.slice(k + 3).map((w) => w.s).join(' '));
        out.push({ name: `${name} %`, key: keyOf(name, '%'), group, section, value: v, unit: '%', referenceRange: '', flag, notes: null });
        out.push({ name: `${name} #`, key: keyOf(name, '#'), group, section, value: vals[k + 2].s, unit, referenceRange: range, flag: flag ?? (range ? 'NORMAL' : null), notes: null });
      } else if (v) {
        out.push({ name, key: keyOf(name), group, section, value: v, unit: clean(vals.slice(k + 1).map((w) => w.s).join(' ')), referenceRange: range, flag: flag ?? (range ? 'NORMAL' : null), notes: null });
      }
      continue;
    }

    // a test line: name at the left, value in the SI or the conventional column
    const left = l.words.filter((w) => valueZone(w) === null);
    const conv = l.words.filter((w) => valueZone(w) === 'conv'), si = l.words.filter((w) => valueZone(w) === 'si');
    const rawName = clean(left.map((w) => w.s).join(' '));
    const name = rawName.replace(/:$/, '');
    const sub = /:$/.test(rawName) && !!group; // "1st Hour:" under "… (ESR), Blood"
    if (sub) groupIsSub = true;
    else if (groupIsSub) { group = null; groupIsSub = false; }
    if (!conv.length && !si.length) { flush(); if (name) { group = name; groupIsSub = false; } continue; } // a group heading ("Liver Function Test LFT")
    flush();
    const main = conv.length ? readValue(conv) : readValue(si);
    if (!main) continue;
    curZone = conv.length ? 'conv' : 'si';
    // a short label ("1st Hour") under a heading ("… (ESR), Blood") is a sub-result of that heading
    const fullName = sub ? `${group} — ${name}` : name;
    cur = { name: fullName, key: keyOf(fullName), group: sub ? null : group, section, value: main.value, unit: main.unit, referenceRange: '', flag: main.flag, notes: null };
    if (conv.length && si.length) { const s = readValue(si); if (s) cur.notes = `SI: ${s.value} ${s.unit}`.trim(); }
  }
  flush();
  return out;

  function valueZone(w: Word): 'si' | 'conv' | null {
    if (!cols) return w.x >= 280 ? 'conv' : null;
    if (w.x >= cols.conv - 15) return 'conv';
    if (w.x >= cols.si - 15) return 'si';
    return null;
  }
  function addRange(words: Word[], label: string | null) {
    const c = words.filter((w) => valueZone(w) === 'conv').map((w) => w.s).join(' ');
    const s = words.filter((w) => valueZone(w) === 'si').map((w) => w.s).join(' ');
    if (c && isRangeText(c)) ranges.push(clean(label ? `${label}: ${c}` : c));
    if (s && isRangeText(s)) { siRanges.push(clean(label ? `${label}: ${s}` : s)); if (!c && curZone === 'si') ranges.push(clean(label ? `${label}: ${s}` : s)); }
  }
}

// ───── test names → keys ─────

const ALIASES: [string, RegExp][] = [
  ['HGB', /\b(hemoglobin|haemoglobin|hgb|hb)\b(?!\s*a1c)/i], ['HCT', /\b(hematocrit|haematocrit|hct|pcv)\b/i], ['RBC', /\b(erythrocytes?|rbcs?|red blood cells?)\b/i],
  ['MCHC', /\bmchc\b/i], ['MCH', /\bmch\b/i], ['MCV', /\bmcv\b/i], ['RDW', /\brdw/i], ['WBC', /\b(leukocytes?|leucocytes?|wbcs?|white blood cells?)\b/i],
  ['NEUT', /\bneutro/i], ['LYMPH', /\blympho/i], ['MONO', /\bmono(cytes?)?\b/i], ['EOS', /\beosino/i], ['BASO', /\bbaso/i], ['PLT', /\b(platelets?|plts?|thrombocytes?)\b/i], ['MPV', /\bmpv\b/i],
  ['ESR', /\b(esr|sedimentation)\b/i], ['CRP', /\b(c-?reactive|crp)\b/i],
  ['ALT', /\b(alt|gpt|alanine aminotransferase|sgpt)\b/i], ['AST', /\b(ast|got|aspartate aminotransferase|sgot)\b/i], ['GGT', /\b(ggt|gamma[- ]glutamyl)/i], ['ALP', /\b(alp|alkaline phosphatase)\b/i],
  ['DBIL', /\bbilirubin\b.*\bdirect\b|\bdirect\b.*\bbilirubin\b|\bd\.?\s?bil/i], ['TBIL', /\bbilirubin\b|\bt\.?\s?bil/i], ['ALB', /\balbumin\b/i], ['TP', /\b(total protein|protein, total|protein total)\b/i],
  ['TSH', /\b(tsh|thyroid stimulating)\b/i], ['FT4', /\b(ft4|free t4|free thyroxine|thyroxine \(ft4\))/i], ['FT3', /\b(ft3|free t3|free triiodothyronine)/i], ['T4', /\b(t4|thyroxine)\b/i], ['T3', /\b(t3|triiodothyronine)\b/i],
  ['HBA1C', /\b(hba1c|a1c|glycated|glycosylated)\b/i], ['GLU', /\b(glucose|fbs|rbs|fbg|blood sugar)\b/i], ['UREA', /\burea\b/i], ['BUN', /\bbun\b/i], ['CREA', /\bcreatinine\b/i], ['UA', /\buric acid\b/i],
  ['HDL', /\bhdl\b/i], ['LDL', /\bldl\b/i], ['TG', /\b(triglycerides?|tg)\b/i], ['CHOL', /\bcholesterol\b/i],
  ['NA', /\b(sodium|na\+?)\b/i], ['K', /\b(potassium|k\+?)\b/i], ['CL', /\b(chloride|cl-?)\b/i], ['CA', /\bcalcium\b/i], ['MG', /\bmagnesium\b/i], ['PHOS', /\bphosph(orus|ate)\b(?!.*alkaline)/i],
  ['VITD', /\b(vitamin d|vit\.? ?d|25.?oh)/i], ['B12', /\b(b12|cobalamin)\b/i], ['FERR', /\bferritin\b/i], ['TIBC', /\btibc\b/i], ['FE', /\b(iron|fe)\b/i], ['FOLATE', /\bfol(ate|ic)\b/i],
  ['PSA', /\bpsa\b/i], ['BHCG', /\b(b-?hcg|beta hcg|pregnancy)\b/i], ['PT', /\b(pt|prothrombin)\b/i], ['INR', /\binr\b/i], ['PTT', /\b(a?ptt)\b/i],
];
export const PANELS: Record<string, string[]> = {
  CBC: ['HGB', 'HCT', 'RBC', 'MCV', 'MCH', 'MCHC', 'RDW', 'WBC', 'NEUT', 'LYMPH', 'MONO', 'EOS', 'BASO', 'PLT', 'MPV'],
  LFT: ['ALT', 'AST', 'GGT', 'ALP', 'TBIL', 'DBIL', 'TP', 'ALB'],
  KFT: ['UREA', 'BUN', 'CREA', 'UA', 'NA', 'K', 'CL'],
  LIPID: ['CHOL', 'TG', 'HDL', 'LDL'],
  TFT: ['TSH', 'FT4', 'FT3', 'T4', 'T3'],
  ELECTROLYTES: ['NA', 'K', 'CL', 'CA', 'MG', 'PHOS'],
  IRON: ['FE', 'TIBC', 'FERR'],
  COAG: ['PT', 'INR', 'PTT'],
};
const PANEL_NAMES: [string, RegExp][] = [
  ['CBC', /\b(cbc|complete blood|blood count|hemogram)\b/i], ['LFT', /\b(lft|liver function|liver panel|liver profile)\b/i], ['KFT', /\b(kft|rft|kidney function|renal function|renal profile)\b/i],
  ['LIPID', /\blipid/i], ['TFT', /\b(tft|thyroid function|thyroid panel|thyroid profile)\b/i], ['ELECTROLYTES', /\belectrolytes?\b/i], ['IRON', /\biron (profile|study|studies)\b/i], ['COAG', /\b(coagulation|pt\/inr)\b/i],
];

/** A test name → a stable key (ALT, TSH, NEUT_P…). The abbreviation in brackets wins: "(ALT-GPT)" → ALT. */
export function keyOf(name: string, kind?: '%' | '#'): string | null {
  const n = name.replace(/,?\s*(serum|plasma|blood|whole blood|urine)\b/gi, ' ');
  const inBrackets = [...n.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  let key: string | null = null;
  for (const b of inBrackets) { const hit = ALIASES.find(([, re]) => re.test(b)); if (hit) { key = hit[0]; break; } }
  if (!key) key = ALIASES.find(([, re]) => re.test(n))?.[0] ?? null;
  if (key && kind && ['NEUT', 'LYMPH', 'MONO', 'EOS', 'BASO'].includes(key)) key += kind === '%' ? '_P' : '_A';
  if (key && !kind && ['NEUT', 'LYMPH', 'MONO', 'EOS', 'BASO'].includes(key)) key += /#|abs/i.test(name) ? '_A' : '_P';
  return key;
}
const base = (k: string) => k.replace(/_[PA]$/, '');

// ───── results → tests of the order ─────

const GENERIC = new Set(['blood', 'serum', 'plasma', 'urine', 'test', 'tests', 'function', 'count', 'total', 'complete', 'profile', 'panel', 'level', 'free', 'high', 'sensitivity']);

export interface OrderItemLite { id: string; testName: string; code: string | null; parameters: { name: string; unit?: string | null; referenceRange?: string | null }[] }
export interface Proposal {
  items: { itemId: string; results: { parameterName: string; value: string; unit: string | null; referenceRange: string | null; flag: string | null; notes: string | null }[] }[];
  unassigned: ParsedResult[];
  missing: string[];
}

export function matchToOrder(results: ParsedResult[], items: OrderItemLite[]): Proposal {
  // what each test of the order covers
  const covers = items.map((it) => {
    const params = it.parameters.map((p) => ({ name: p.name, key: keyOf(p.name) }));
    const label = `${it.testName} ${it.code ?? ''}`;
    const panel = PANEL_NAMES.find(([, re]) => re.test(label))?.[0];
    const own = keyOf(it.testName) ?? (it.code ? keyOf(it.code) : null);
    return { it, params, panel, own, groupWords: label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w)) };
  });
  const byItem = new Map<string, Proposal['items'][number]['results']>();
  const unassigned: ParsedResult[] = [];
  for (const r of results) {
    const k = r.key;
    let target: (typeof covers)[number] | undefined;
    let paramName: string | null = null;
    if (k) {
      // 1. a defined parameter of a test; 2. a single test of that name; 3. a panel that includes it
      for (const c of covers) {
        const p = c.params.find((x) => x.key === k) ?? c.params.find((x) => x.key && base(x.key) === base(k) && !c.params.some((y) => y.key === k));
        if (p) { target = c; paramName = p.name; break; }
      }
      target ??= covers.find((c) => !c.params.length && c.own && (c.own === k || base(c.own) === base(k)) && !c.panel);
      target ??= covers.find((c) => c.panel && PANELS[c.panel].includes(base(k)));
    }
    // 4. the report's own grouping ("Liver Function Test LFT") matches the test's name
    if (!target && r.group) target = covers.find((c) => c.groupWords.some((w) => r.group!.toLowerCase().includes(w)));
    if (!target && covers.length === 1 && !covers[0].params.length && !k) target = covers[0];
    if (!target) { unassigned.push(r); continue; }
    const list = byItem.get(target.it.id) ?? [];
    list.push({ parameterName: paramName ?? shortName(r.name), value: r.value, unit: r.unit || null, referenceRange: r.referenceRange || null, flag: r.flag, notes: r.notes });
    byItem.set(target.it.id, list);
  }
  return {
    items: [...byItem].map(([itemId, rs]) => ({ itemId, results: rs })),
    unassigned,
    missing: items.filter((it) => !byItem.has(it.id)).map((it) => it.testName),
  };
}

/** "Alanine Aminotransferase (ALT-GPT), Serum" → "ALT-GPT"; "Bilirubin Total, Serum" → "Bilirubin Total" (fits the result box). */
export function shortName(name: string) {
  const abbr = name.match(/\(([A-Za-z0-9][A-Za-z0-9 \-/]{0,14})\)/)?.[1];
  if (abbr && /[A-Z]/.test(abbr)) return name.includes('—') ? `${abbr.trim()} — ${name.split('—').pop()!.trim()}` : abbr.trim();
  return clean(name.replace(/,?\s*(Serum|Plasma|Whole Blood|Blood|Urine)\s*$/i, '').replace(/,?\s*(Serum|Plasma|Blood)\s*—/i, ' —')).slice(0, 80);
}
