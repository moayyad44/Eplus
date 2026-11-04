import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, nullableStr } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { getSetting } from '../../lib/settings';
import { D, r3 } from '../../lib/money';
import { createEntry, dayOf, ensureOpenPeriod, updateEntry } from './journal';
import { addSheet, readTable, toAmount } from './xlsx';

/**
 * Opening balances from Excel: download a ready template (every account, with the figures EmergencyPlus already
 * knows as suggestions), fill it, upload it, review a preview with every error and warning, then confirm.
 * Nothing is written before the confirmation; a second import replaces the first one (never a duplicate).
 */
export const openingRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const KEY = 'opening-import';

/** What EmergencyPlus already knows (today): receivables, overpayments, insurance receivables, suppliers, stock value. */
async function suggestions() {
  const [ar, credits, ins, po, paid, stock] = await Promise.all([
    prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(balance) v FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED')`,
    prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(GREATEST("paidAmount" - "refundedAmount" - "patientShare" - "transferredFromInsurance", 0)) v FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED')`,
    prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(GREATEST("insuranceAmount" - "paidAmount" - "transferredAmount" - "writtenOffAmount", 0)) v FROM insurance_claims WHERE "workflowStatus" <> 'CANCELLED'`,
    prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(total) v FROM purchase_orders WHERE status = 'RECEIVED'`,
    prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(amount) v FROM supplier_payments WHERE "voidedAt" IS NULL`,
    prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`SELECT SUM(quantity * "purchasePrice") v FROM inventory_items WHERE "deletedAt" IS NULL`,
  ]);
  const v = (x: { v: Prisma.Decimal | null }[]) => Number(D(x[0]?.v).toFixed(3));
  return {
    AR_PATIENTS: { debit: v(ar) }, PATIENT_CREDITS: { credit: v(credits) }, AR_INSURANCE: { debit: v(ins) },
    AP_SUPPLIERS: { credit: Math.max(0, Number(D(po[0]?.v).sub(D(paid[0]?.v)).toFixed(3))) }, INVENTORY: { debit: v(stock) },
  } as Record<string, { debit?: number; credit?: number }>;
}

openingRouter.get('/opening/template', requirePerm('accounting.import'), ah(async (_req, res) => {
  const [accounts, sug] = await Promise.all([prisma.account.findMany({ where: { isGroup: false, isActive: true }, orderBy: { code: 'asc' } }), suggestions()]);
  const types: Record<string, string> = { ASSET: 'أصول', LIABILITY: 'التزامات', EQUITY: 'حقوق ملكية', REVENUE: 'إيرادات', EXPENSE: 'مصروفات' };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EmergencyPlus Accounting';
  addSheet(wb, 'الأرصدة الافتتاحية', [
    { header: 'رقم الحساب', key: 'code', width: 12 }, { header: 'اسم الحساب', key: 'name', width: 36 }, { header: 'النوع', key: 'type', width: 12 },
    { header: 'مدين', key: 'debit', width: 14, money: true }, { header: 'دائن', key: 'credit', width: 14, money: true },
    { header: 'الجهة (اختياري)', key: 'party', width: 20 }, { header: 'ملاحظة', key: 'note', width: 24 },
    { header: 'مقترح من EmergencyPlus (مدين)', key: 'sd', width: 18, money: true }, { header: 'مقترح من EmergencyPlus (دائن)', key: 'sc', width: 18, money: true },
  ], accounts.map((a) => ({ code: a.code, name: a.name, type: types[a.type], debit: null, credit: null, sd: sug[a.systemKey ?? '']?.debit || null, sc: sug[a.systemKey ?? '']?.credit || null })),
  { title: 'الأرصدة الافتتاحية — EmergencyPlus Accounting (JOD)', totals: ['debit', 'credit'] });
  const help = wb.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
  help.getColumn(1).width = 110;
  [
    'تعليمات تعبئة الأرصدة الافتتاحية',
    '1. اكتب رصيد كل حساب في عمود «مدين» أو «دائن» (واحد فقط لكل سطر). اترك الحسابات بلا رصيد فارغة.',
    '2. الأصول والمصروفات أرصدتها مدينة عادة؛ الالتزامات وحقوق الملكية والإيرادات دائنة.',
    '3. عمودا «مقترح من EmergencyPlus» أرقام يعرفها البرنامج اليوم (ذمم المرضى، ذمم التأمين، الموردون، المخزون). راجعها وانسخها إن كانت صحيحة؛ لا تُستورد تلقائياً.',
    '4. يجب أن يتساوى مجموع المدين ومجموع الدائن. إن لم يتساويا يمكن عند الاستيراد إكمال الفرق في «حساب الأرصدة الافتتاحية».',
    '5. لا تغيّر أرقام الحسابات؛ يمكنك حذف الصفوف الفارغة. يمكن إضافة حساب جديد من «دليل الحسابات» ثم تنزيل القالب من جديد.',
    '6. بعد الرفع تظهر معاينة بكل الأخطاء والتحذيرات، ولا يُسجَّل شيء قبل التأكيد. الاستيراد مرة ثانية يستبدل القيد الافتتاحي السابق.',
  ].forEach((t, i) => { const c = help.getCell(i + 1, 1); c.value = t; if (!i) c.font = { bold: true, size: 13 }; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="opening-balances.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

const HEAD = { code: /رقم الحساب|رمز الحساب|code/i, debit: /^مدين$|debit/i, credit: /^دائن$|credit/i, party: /الجهة|party/i, note: /ملاحظ|بيان|note/i, name: /اسم الحساب|name/i };

interface Row { row: number; code: string; name: string; debit: number; credit: number; party: string | null; note: string | null; accountId: string | null; accountName: string | null; errors: string[]; warnings: string[] }

/** Read the file, map the columns, check every row. Writes nothing. */
async function analyse(file: Express.Multer.File, sheetName?: string, cols?: Partial<Record<keyof typeof HEAD, number>>) {
  const { sheets } = await readTable(file.buffer, file.originalname);
  if (!sheets.length) throw badRequest('الملف لا يحتوي أوراق عمل');
  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0];
  const headerIdx = sheet.rows.findIndex((r) => r.some((c) => HEAD.code.test(String(c ?? ''))));
  if (headerIdx < 0 && !cols?.code) throw badRequest('لم يُعثر على عمود «رقم الحساب» في الورقة. اختر الأعمدة يدوياً أو استخدم القالب');
  const header = (sheet.rows[Math.max(headerIdx, 0)] ?? []).map((c) => String(c ?? '').trim());
  const find = (k: keyof typeof HEAD) => cols?.[k] ?? header.findIndex((h) => HEAD[k].test(h));
  const map = { code: find('code'), debit: find('debit'), credit: find('credit'), party: find('party'), note: find('note'), name: find('name') };
  if (map.debit < 0 || map.credit < 0) throw badRequest('لم يُعثر على عمودي «مدين» و«دائن»');
  const accounts = await prisma.account.findMany();
  const rows: Row[] = [];
  const seen = new Map<string, number>();
  sheet.rows.slice(headerIdx + 1).forEach((r, i) => {
    const code = String(r[map.code] ?? '').trim();
    if (!code || /الإجمالي/.test(code)) return;
    const debit = toAmount(r[map.debit]), credit = toAmount(r[map.credit]);
    const row: Row = { row: headerIdx + 2 + i, code, name: map.name >= 0 ? String(r[map.name] ?? '') : '', debit, credit, party: map.party >= 0 ? (String(r[map.party] ?? '').trim() || null) : null, note: map.note >= 0 ? (String(r[map.note] ?? '').trim() || null) : null, accountId: null, accountName: null, errors: [], warnings: [] };
    if (Number.isNaN(debit) || Number.isNaN(credit)) row.errors.push('مبلغ غير صالح');
    if (!row.errors.length && !debit && !credit) return; // no balance: ignored
    if (debit < 0 || credit < 0) row.errors.push('المبالغ لا تكون سالبة');
    if (debit && credit) row.errors.push('مدين ودائن في السطر نفسه');
    const a = accounts.find((x) => x.code === code);
    if (!a) row.errors.push('رقم الحساب غير موجود في دليل الحسابات');
    else {
      row.accountId = a.id; row.accountName = a.name;
      if (a.isGroup) row.errors.push('حساب رئيسي: استخدم حساباته الفرعية');
      if (!a.isActive) row.errors.push('الحساب موقوف');
      if (row.name && row.name.trim() !== a.name) row.warnings.push(`الاسم في الملف «${row.name}» يختلف عن «${a.name}»`);
      const natural = a.nature === 'DEBIT' ? 'debit' : 'credit';
      if ((natural === 'debit' && credit) || (natural === 'credit' && debit)) row.warnings.push('الرصيد على عكس طبيعة الحساب');
      if (['REVENUE', 'EXPENSE'].includes(a.type)) row.warnings.push('حسابات الإيرادات والمصروفات تبدأ السنة عادة بصفر');
    }
    const dup = seen.get(`${code}|${row.party ?? ''}`);
    if (dup) row.errors.push(`مكرر (السطر ${dup})`);
    seen.set(`${code}|${row.party ?? ''}`, row.row);
    rows.push(row);
  });
  const good = rows.filter((r) => !r.errors.length);
  const debit = Number(good.reduce((t, r) => t.add(r3(r.debit)), D(0)).toFixed(3)), credit = Number(good.reduce((t, r) => t.add(r3(r.credit)), D(0)).toFixed(3));
  const existing = await prisma.journalEntry.findUnique({ where: { sourceKey: KEY }, select: { id: true, number: true, status: true, totalDebit: true } });
  return { sheets: sheets.map((s) => s.name), sheet: sheet.name, header, map, rows, totals: { debit, credit, difference: Number((debit - credit).toFixed(3)), rows: rows.length, valid: good.length, invalid: rows.length - good.length }, existing };
}

openingRouter.post('/opening/preview', requirePerm('accounting.import'), upload.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('اختر ملف Excel أو CSV');
  if (!/\.(xlsx|csv)$/i.test(req.file.originalname)) throw badRequest('الملف يجب أن يكون .xlsx أو .csv');
  const q = parse(z.object({ sheet: z.string().optional(), cols: z.string().optional() }), req.body);
  const cols = q.cols ? JSON.parse(q.cols) : undefined;
  res.json(await analyse(req.file, q.sheet, cols));
}));

/** Confirm: re-checks everything, then writes (or replaces) the single opening entry. */
openingRouter.post('/opening/import', requirePerm('accounting.import'), ah(async (req, res) => {
  const b = parse(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح'),
    fillDifference: z.boolean().default(false),
    fileName: nullableStr(200),
    rows: z.array(z.object({ accountId: z.string().uuid(), debit: z.number().min(0), credit: z.number().min(0), party: nullableStr(150), note: nullableStr(300) })).min(1, 'لا توجد صفوف صالحة للاستيراد').max(5000),
  }), req.body);
  const cfg = await getSetting('accounting');
  if (cfg.startDate && b.date > cfg.startDate) throw badRequest(`تاريخ الأرصدة الافتتاحية يجب ألا يكون بعد تاريخ بدء المحاسبة (${cfg.startDate})`);
  const lines = b.rows.filter((r) => r.debit || r.credit).map((r) => ({ accountId: r.accountId, debit: r.debit, credit: r.credit, partyName: r.party, description: r.note }));
  const d = lines.reduce((t, l) => t.add(r3(l.debit)), D(0)), c = lines.reduce((t, l) => t.add(r3(l.credit)), D(0));
  if (!d.eq(c)) {
    if (!b.fillDifference) throw badRequest(`الأرصدة غير متوازنة: المدين ${d.toFixed(3)} والدائن ${c.toFixed(3)}. صحّح الملف أو اختر إكمال الفرق في حساب الأرصدة الافتتاحية`);
    const ob = cfg.accountMap.OPENING_BALANCES ?? (await prisma.account.findUniqueOrThrow({ where: { systemKey: 'OPENING_BALANCES' } })).id;
    const diff = d.sub(c);
    lines.push({ accountId: ob, debit: diff.lt(0) ? diff.abs().toNumber() : 0, credit: diff.gt(0) ? diff.toNumber() : 0, partyName: null, description: 'فرق الأرصدة الافتتاحية' });
  }
  const input = { date: b.date, type: 'OPENING' as const, description: 'الأرصدة الافتتاحية (استيراد Excel)', reference: b.fileName ?? null, lines };
  const e = await prisma.$transaction(async (tx) => {
    await ensureOpenPeriod(tx, dayOf(b.date));
    const existing = await tx.journalEntry.findUnique({ where: { sourceKey: KEY } });
    const out = existing && existing.status !== 'DELETED'
      ? await updateEntry(tx, req.ctx, existing.id, input, { reason: 'إعادة استيراد الأرصدة الافتتاحية' })
      : existing ? null : await createEntry(tx, req.ctx, input, { post: true, sourceKey: KEY });
    if (!out) throw badRequest('القيد الافتتاحي السابق محذوف؛ استعده أو أنشئ قيداً يدوياً');
    await audit(tx, req.ctx, { action: 'accounting.import', entityType: 'journal_entry', entityId: out.id, summary: `استيراد الأرصدة الافتتاحية: ${lines.length} سطر — ${b.fileName ?? ''}` });
    return out;
  });
  res.json({ id: e.id, number: e.number, lines: lines.length, total: Number(D(e.totalDebit).toFixed(3)) });
}));
