import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { PermissionKey } from '../../auth/permissions';
import { can, type Ctx } from '../../auth/context';
import { prisma, type Tx } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, forbidden } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { getSetting } from '../../lib/settings';
import { r3 } from '../../lib/money';
import { dateOnly } from '../../lib/dates';
import { createEntry, dayOf } from './journal';
import { enqueue, postDoc } from './link';
import { docNumber } from './common';
import { createAccount } from './accounts';
import { createTransfer, issueVoucher } from './treasury';
import { addSheet, readTable, toAmount } from './xlsx';

/**
 * Excel import for EmergencyPlus Accounting. Every type has a template; a file is first checked row by row
 * (preview — nothing is saved), then imported all-or-nothing in one transaction after the user confirms.
 * Rows already in the system are skipped, never doubled. Each row goes through the same function the screen uses.
 */
export const importsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

interface Column { key: string; header: string; required?: boolean; note: string }
type Values = Record<string, string>;
interface Checked { line: number; values: Values; errors: string[]; warnings: string[]; skip?: boolean; data?: unknown; group?: string }
interface ImportType {
  title: string; perm: PermissionKey; columns: Column[];
  check(rows: Checked[], db: Tx | typeof prisma): Promise<void>;
  save(tx: Tx, ctx: Ctx, rows: Checked[]): Promise<number>;
}

// ───── value helpers ─────
const num = (v: string) => (v === '' ? NaN : toAmount(v));
function dateOf(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const yes = (v: string) => /^(نعم|y|yes|true|1)$/i.test(v.trim());
const TYPES: Record<string, string> = { أصول: 'ASSET', اصول: 'ASSET', خصوم: 'LIABILITY', 'حقوق ملكية': 'EQUITY', 'حقوق الملكية': 'EQUITY', إيرادات: 'REVENUE', ايرادات: 'REVENUE', مصروفات: 'EXPENSE', مصاريف: 'EXPENSE' };

async function lookups(db: Tx | typeof prisma) {
  const [accounts, treasuries, categories, methods, suppliers] = await Promise.all([
    db.account.findMany(), db.treasury.findMany({ where: { isActive: true } }), db.expenseCategory.findMany({ where: { isActive: true } }),
    db.paymentMethod.findMany(), db.supplier.findMany({ where: { deletedAt: null } }),
  ]);
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return {
    account: (code: string) => accounts.find((a) => a.code === code.trim()),
    treasury: (name: string) => treasuries.find((t) => norm(t.name) === norm(name)),
    category: (name: string) => categories.find((c) => norm(c.name) === norm(name)),
    method: (name: string) => methods.find((m) => norm(m.name) === norm(name) || norm(m.code) === norm(name)),
    supplier: (name: string) => suppliers.find((s) => norm(s.name) === norm(name)),
    accounts,
  };
}
const need = (r: Checked, ...keys: string[]) => { for (const k of keys) if (!r.values[k]?.trim()) r.errors.push(`«${k}» مطلوب`); };

// ───── import types ─────
const T: Record<string, ImportType> = {
  accounts: {
    title: 'دليل الحسابات', perm: 'accounting.accounts.manage',
    columns: [
      { key: 'code', header: 'رقم الحساب', required: true, note: 'أرقام فقط، فريد' },
      { key: 'name', header: 'اسم الحساب', required: true, note: '' },
      { key: 'parent', header: 'رقم الحساب الأب', note: 'حساب موجود أو وارد في سطر سابق من نفس الملف' },
      { key: 'type', header: 'النوع', note: 'أصول / خصوم / حقوق ملكية / إيرادات / مصروفات (إلزامي إذا لم يوجد أب)' },
      { key: 'group', header: 'حساب رئيسي', note: 'نعم / لا' },
    ],
    async check(rows, db) {
      const L = await lookups(db);
      const seen = new Set<string>();
      for (const r of rows) {
        need(r, 'code', 'name');
        const v = r.values;
        if (v.code && !/^[0-9A-Za-z.-]+$/.test(v.code)) r.errors.push('رقم الحساب: أرقام وأحرف إنجليزية فقط');
        if (v.code && L.account(v.code)) { r.skip = true; r.warnings.push('الحساب موجود؛ سيُتجاوز'); }
        if (seen.has(v.code)) r.errors.push('رقم مكرر في الملف');
        if (v.parent && !L.account(v.parent) && !seen.has(v.parent)) r.errors.push(`الحساب الأب ${v.parent} غير موجود`);
        const type = v.type ? TYPES[v.type.trim()] ?? (/^(ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE)$/.test(v.type.trim().toUpperCase()) ? v.type.trim().toUpperCase() : undefined) : undefined;
        if (v.type && !type) r.errors.push('النوع غير معروف');
        if (!v.parent && !type) r.errors.push('حدّد النوع للحساب بلا أب');
        seen.add(v.code);
        r.data = { code: v.code.trim(), name: v.name.trim(), parent: v.parent.trim(), type, isGroup: yes(v.group) };
      }
    },
    async save(tx, ctx, rows) {
      let n = 0;
      for (const r of rows) {
        const d = r.data as { code: string; name: string; parent: string; type?: 'ASSET'; isGroup: boolean };
        const parent = d.parent ? await tx.account.findUnique({ where: { code: d.parent } }) : null;
        await createAccount(tx, ctx, { code: d.code, name: d.name, parentId: parent?.id ?? null, type: d.type, isGroup: d.isGroup, description: null });
        n++;
      }
      return n;
    },
  },

  journal: {
    title: 'قيود يومية', perm: 'accounting.journal.create',
    columns: [
      { key: 'ref', header: 'رقم القيد في الملف', required: true, note: 'الأسطر بنفس الرقم = قيد واحد؛ يمنع تكرار الاستيراد' },
      { key: 'date', header: 'التاريخ', required: true, note: 'YYYY-MM-DD' },
      { key: 'description', header: 'البيان', required: true, note: 'بيان القيد (من أول سطر)' },
      { key: 'account', header: 'رقم الحساب', required: true, note: 'حساب فرعي' },
      { key: 'debit', header: 'مدين', note: '' }, { key: 'credit', header: 'دائن', note: '' },
      { key: 'line', header: 'بيان السطر', note: '' },
    ],
    async check(rows, db) {
      const L = await lookups(db);
      const groups = new Map<string, Checked[]>();
      for (const r of rows) {
        need(r, 'ref', 'date', 'account');
        const v = r.values, dt = dateOf(v.date);
        if (v.date && !dt) r.errors.push('تاريخ غير صالح');
        const a = v.account ? L.account(v.account) : undefined;
        if (v.account && !a) r.errors.push(`الحساب ${v.account} غير موجود`);
        else if (a?.isGroup) r.errors.push(`الحساب ${v.account} رئيسي؛ استخدم حساباً فرعياً`);
        const dr = v.debit ? num(v.debit) : 0, cr = v.credit ? num(v.credit) : 0;
        if (Number.isNaN(dr) || Number.isNaN(cr) || dr < 0 || cr < 0) r.errors.push('مبلغ غير صالح');
        else if ((dr > 0) === (cr > 0)) r.errors.push('ضع المبلغ في مدين أو دائن (واحد منهما)');
        r.group = v.ref.trim();
        r.data = { date: dt, accountId: a?.id, debit: dr, credit: cr, description: v.line || null };
        groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
      }
      for (const [ref, g] of groups) {
        if (!ref) continue;
        const dr = g.reduce((t, r) => t + ((r.data as { debit: number }).debit || 0), 0), cr = g.reduce((t, r) => t + ((r.data as { credit: number }).credit || 0), 0);
        if (Math.abs(dr - cr) >= 0.0005) g[0].errors.push(`القيد ${ref} غير متوازن (مدين ${dr.toFixed(3)} / دائن ${cr.toFixed(3)})`);
        if (g.length < 2) g[0].errors.push(`القيد ${ref} يحتاج سطرين على الأقل`);
        if (new Set(g.map((r) => (r.data as { date: string }).date)).size > 1) g[0].errors.push(`أسطر القيد ${ref} بتواريخ مختلفة`);
        if (!g[0].values.description?.trim()) g[0].errors.push('البيان مطلوب في أول سطر من القيد');
        if (await db.journalEntry.findUnique({ where: { sourceKey: `import:journal:${ref}` } })) for (const r of g) { r.skip = true; r.warnings.push('القيد مستورد سابقاً؛ سيُتجاوز'); }
        const p = (g[0].data as { date: string | null }).date && await db.fiscalPeriod.findFirst({ where: { startDate: { lte: dayOf((g[0].data as { date: string }).date) }, endDate: { gte: dayOf((g[0].data as { date: string }).date) } } });
        if ((g[0].data as { date: string | null }).date && !p) g[0].errors.push('لا توجد سنة مالية لهذا التاريخ');
        else if (p && p.status === 'CLOSED') g[0].errors.push(`الفترة ${p.name} مغلقة`);
      }
    },
    async save(tx, ctx, rows) {
      const cfg = await getSetting('accounting', tx);
      const groups = new Map<string, Checked[]>();
      for (const r of rows) groups.set(r.group!, [...(groups.get(r.group!) ?? []), r]);
      for (const [ref, g] of groups) {
        const first = g[0].data as { date: string };
        await createEntry(tx, ctx, { date: first.date, type: 'GENERAL', description: g[0].values.description.trim(), reference: ref, lines: g.map((r) => r.data as never) }, { post: !cfg.requireApproval, sourceKey: `import:journal:${ref}` });
      }
      return groups.size;
    },
  },

  expenses: {
    title: 'مصروفات', perm: 'expenses.manage',
    columns: [
      { key: 'date', header: 'التاريخ', required: true, note: 'YYYY-MM-DD' },
      { key: 'category', header: 'التصنيف', required: true, note: 'اسم تصنيف موجود في المصروفات' },
      { key: 'amount', header: 'المبلغ', required: true, note: '' },
      { key: 'description', header: 'الوصف', required: true, note: '' },
      { key: 'method', header: 'طريقة الدفع', note: 'اسم طريقة دفع موجودة (اختياري)' },
      { key: 'reference', header: 'المرجع', note: '' },
    ],
    async check(rows, db) {
      const L = await lookups(db);
      for (const r of rows) {
        need(r, 'date', 'category', 'amount', 'description');
        const v = r.values, dt = dateOf(v.date), amount = num(v.amount), c = v.category && L.category(v.category), m = v.method ? L.method(v.method) : null;
        if (v.date && !dt) r.errors.push('تاريخ غير صالح');
        if (v.amount && (Number.isNaN(amount) || amount <= 0)) r.errors.push('مبلغ غير صالح');
        if (v.category && !c) r.errors.push(`التصنيف «${v.category}» غير موجود`);
        if (v.method && !m) r.errors.push(`طريقة الدفع «${v.method}» غير موجودة`);
        if (dt && c && !Number.isNaN(amount) && await db.expense.findFirst({ where: { voidedAt: null, expenseDate: dateOnly(dt), amount: r3(amount), categoryId: c.id, description: v.description.trim() } })) { r.skip = true; r.warnings.push('مصروف مطابق موجود؛ سيُتجاوز'); }
        r.data = { expenseDate: dt, amount: r3(amount || 0), categoryId: c ? c.id : null, paymentMethodId: m ? m.id : null, description: v.description.trim(), reference: v.reference || null };
      }
    },
    async save(tx, ctx, rows) {
      for (const r of rows) {
        const d = r.data as { expenseDate: string; categoryId: string };
        const row = await tx.expense.create({ data: { ...(r.data as object), categoryId: d.categoryId, expenseDate: dateOnly(d.expenseDate), branchId: ctx.branchId, createdById: ctx.userId } as never });
        await enqueue(tx, 'expense', row.id);
      }
      return rows.length;
    },
  },

  suppliers: {
    title: 'الموردون', perm: 'suppliers.manage',
    columns: [
      { key: 'name', header: 'اسم المورد', required: true, note: '' }, { key: 'phone', header: 'الهاتف', note: '' }, { key: 'email', header: 'البريد الإلكتروني', note: '' },
      { key: 'taxNumber', header: 'الرقم الضريبي', note: '' }, { key: 'contactPerson', header: 'الشخص المسؤول', note: '' }, { key: 'address', header: 'العنوان', note: '' },
    ],
    async check(rows, db) {
      const L = await lookups(db);
      const seen = new Set<string>();
      for (const r of rows) {
        need(r, 'name');
        const v = r.values, key = v.name.trim().toLowerCase();
        if (v.email && !z.string().email().safeParse(v.email.trim()).success) r.errors.push('بريد غير صالح');
        if (L.supplier(v.name) || seen.has(key)) { r.skip = true; r.warnings.push('المورد موجود؛ سيُتجاوز'); }
        seen.add(key);
        r.data = { name: v.name.trim(), phone: v.phone || null, email: v.email.trim() || null, taxNumber: v.taxNumber || null, contactPerson: v.contactPerson || null, address: v.address || null };
      }
    },
    async save(tx, _ctx, rows) {
      for (const r of rows) await tx.supplier.create({ data: r.data as never });
      return rows.length;
    },
  },

  assets: {
    title: 'الأصول الثابتة', perm: 'accounting.assets.manage',
    columns: [
      { key: 'name', header: 'اسم الأصل', required: true, note: '' },
      { key: 'account', header: 'رقم حساب الفئة', required: true, note: 'حساب أصول فرعي (مثل الأجهزة الطبية)' },
      { key: 'date', header: 'تاريخ الشراء', required: true, note: 'YYYY-MM-DD' },
      { key: 'cost', header: 'التكلفة', required: true, note: '' },
      { key: 'salvage', header: 'القيمة المتبقية', note: 'افتراضي 0' },
      { key: 'life', header: 'العمر بالأشهر', required: true, note: '' },
      { key: 'funding', header: 'رقم الحساب الممول', required: true, note: 'صندوق / بنك / الموردون / رأس المال (لأصول موجودة سابقاً)' },
      { key: 'location', header: 'الموقع', note: '' },
    ],
    async check(rows, db) {
      const L = await lookups(db);
      for (const r of rows) {
        need(r, 'name', 'account', 'date', 'cost', 'life', 'funding');
        const v = r.values, dt = dateOf(v.date), cost = num(v.cost), salvage = v.salvage ? num(v.salvage) : 0, life = Number(v.life);
        const a = v.account && L.account(v.account), f = v.funding && L.account(v.funding);
        if (v.date && !dt) r.errors.push('تاريخ غير صالح');
        if (v.cost && (Number.isNaN(cost) || cost <= 0)) r.errors.push('تكلفة غير صالحة');
        if (Number.isNaN(salvage) || salvage < 0 || salvage >= cost) r.errors.push('القيمة المتبقية غير صالحة');
        if (v.life && (!Number.isInteger(life) || life < 1 || life > 600)) r.errors.push('العمر بالأشهر غير صالح');
        if (v.account && (!a || a.isGroup || a.type !== 'ASSET')) r.errors.push('حساب الفئة يجب أن يكون حساب أصول فرعياً');
        if (v.funding && (!f || f.isGroup)) r.errors.push('الحساب الممول غير موجود أو رئيسي');
        if (dt && a && !Number.isNaN(cost) && await db.fixedAsset.findFirst({ where: { name: v.name.trim(), purchaseDate: dayOf(dt), cost: r3(cost) } })) { r.skip = true; r.warnings.push('أصل مطابق موجود؛ سيُتجاوز'); }
        r.data = { name: v.name.trim(), accountId: a ? a.id : null, purchaseDate: dt, cost, salvage, usefulLifeMonths: life, fundingAccountId: f ? f.id : null, location: v.location || null };
      }
    },
    async save(tx, ctx, rows) {
      for (const r of rows) {
        const d = r.data as { purchaseDate: string; cost: number; salvage: number };
        const a = await tx.fixedAsset.create({ data: { ...(r.data as object), purchaseDate: dayOf(d.purchaseDate), cost: r3(d.cost), salvage: r3(d.salvage), code: await docNumber(tx, 'FA', 4), createdById: ctx.userId } as never });
        await postDoc(tx, 'asset', a.id);
      }
      return rows.length;
    },
  },

  'cheques-in': chequeType('IN'),
  'cheques-out': chequeType('OUT'),

  transfers: {
    title: 'تحويلات بين الصناديق والبنوك', perm: 'accounting.treasury.manage',
    columns: [
      { key: 'date', header: 'التاريخ', required: true, note: 'YYYY-MM-DD' },
      { key: 'from', header: 'من (اسم الصندوق/البنك)', required: true, note: 'كما هو في النظام' },
      { key: 'to', header: 'إلى (اسم الصندوق/البنك)', required: true, note: '' },
      { key: 'amount', header: 'المبلغ', required: true, note: '' }, { key: 'fee', header: 'العمولة', note: 'افتراضي 0' },
      { key: 'reference', header: 'المرجع', required: true, note: 'رقم الحوالة؛ يمنع التكرار' }, { key: 'notes', header: 'ملاحظات', note: '' },
    ],
    async check(rows, db) {
      const L = await lookups(db);
      for (const r of rows) {
        need(r, 'date', 'from', 'to', 'amount', 'reference');
        const v = r.values, dt = dateOf(v.date), amount = num(v.amount), fee = v.fee ? num(v.fee) : 0, f = v.from && L.treasury(v.from), t = v.to && L.treasury(v.to);
        if (v.date && !dt) r.errors.push('تاريخ غير صالح');
        if (v.from && !f) r.errors.push(`«${v.from}» غير موجود`);
        if (v.to && !t) r.errors.push(`«${v.to}» غير موجود`);
        if (f && t && f.id === t.id) r.errors.push('المصدر والوجهة متطابقان');
        if (Number.isNaN(amount) || amount <= 0 || Number.isNaN(fee) || fee < 0) r.errors.push('مبلغ غير صالح');
        if (v.reference && await db.treasuryTransfer.findFirst({ where: { reference: v.reference.trim(), status: 'ACTIVE' } })) { r.skip = true; r.warnings.push('تحويل بنفس المرجع موجود؛ سيُتجاوز'); }
        r.data = { date: dt, fromId: f ? f.id : null, toId: t ? t.id : null, amount, fee, reference: v.reference.trim(), notes: v.notes || null };
      }
    },
    async save(tx, ctx, rows) {
      for (const r of rows) await createTransfer(tx, ctx, r.data as never);
      return rows.length;
    },
  },
};

function chequeType(dir: 'IN' | 'OUT'): ImportType {
  return {
    title: dir === 'IN' ? 'شيكات واردة (سندات قبض بشيك)' : 'شيكات صادرة (سندات صرف بشيك)', perm: 'accounting.vouchers.create',
    columns: [
      { key: 'number', header: 'رقم الشيك', required: true, note: '' },
      { key: 'bank', header: 'البنك', required: true, note: dir === 'IN' ? 'بنك الشيك' : 'اسم بنك الدفع' },
      ...(dir === 'OUT' ? [{ key: 'treasury', header: 'الحساب البنكي المسحوب عليه', required: true, note: 'اسم الحساب البنكي في النظام' }] : []),
      { key: 'amount', header: 'المبلغ', required: true, note: '' },
      { key: 'date', header: 'تاريخ الاستلام/الإصدار', required: true, note: 'YYYY-MM-DD' },
      { key: 'due', header: 'تاريخ الاستحقاق', required: true, note: 'YYYY-MM-DD' },
      { key: 'party', header: dir === 'IN' ? 'الساحب / الدافع' : 'المستفيد', required: true, note: '' },
      { key: 'account', header: 'رقم الحساب المقابل', required: true, note: dir === 'IN' ? 'مثل ذمم المرضى أو إيرادات أخرى' : 'مثل الموردون أو مصروف' },
      { key: 'purpose', header: 'البيان', required: true, note: '' },
    ],
    async check(rows, db) {
      const L = await lookups(db);
      const seen = new Set<string>();
      for (const r of rows) {
        need(r, ...this.columns.filter((c) => c.required).map((c) => c.key));
        const v = r.values, dt = dateOf(v.date), due = dateOf(v.due), amount = num(v.amount), a = v.account && L.account(v.account);
        const t = dir === 'OUT' && v.treasury ? L.treasury(v.treasury) : undefined;
        if ((v.date && !dt) || (v.due && !due)) r.errors.push('تاريخ غير صالح');
        if (Number.isNaN(amount) || amount <= 0) r.errors.push('مبلغ غير صالح');
        if (v.account && (!a || a.isGroup)) r.errors.push(`الحساب ${v.account} غير موجود أو رئيسي`);
        if (dir === 'OUT' && v.treasury && (!t || t.kind !== 'BANK')) r.errors.push(`«${v.treasury}» ليس حساباً بنكياً`);
        const key = `${v.number.trim()}|${v.bank.trim()}`;
        if (seen.has(key)) r.errors.push('شيك مكرر في الملف');
        seen.add(key);
        if (v.number && await db.cheque.findFirst({ where: { direction: dir, number: v.number.trim(), bankName: v.bank.trim(), status: { not: 'CANCELLED' } } })) { r.skip = true; r.warnings.push('الشيك موجود؛ سيُتجاوز'); }
        r.data = {
          kind: dir === 'IN' ? 'RECEIPT' : 'PAYMENT', method: 'CHEQUE', date: dt, treasuryId: t?.id ?? null, amount, counterAccountId: a ? a.id : null,
          partyName: v.party.trim(), purpose: v.purpose.trim(), reference: null, notes: 'مستورد من Excel',
          cheques: [{ number: v.number.trim(), bankName: v.bank.trim(), drawer: dir === 'IN' ? v.party.trim() : null, dueDate: due, issueDate: dt, amount }],
        };
      }
    },
    async save(tx, ctx, rows) {
      for (const r of rows) await issueVoucher(tx, ctx, r.data as never);
      return rows.length;
    },
  };
}

function typeOf(key: string, ctx: Ctx) {
  const t = T[key];
  if (!t) throw badRequest('نوع استيراد غير معروف');
  if (!can(ctx, t.perm)) throw forbidden();
  return t;
}

importsRouter.get('/imports', requirePerm('accounting.import'), ah(async (req, res) => {
  res.json(Object.entries(T).map(([key, t]) => ({ key, title: t.title, columns: t.columns, allowed: can(req.ctx, t.perm) })));
}));

/** Empty template: the data sheet (headers only — no sample rows) and a sheet explaining each column. */
importsRouter.get('/imports/:type/template', requirePerm('accounting.import'), ah(async (req, res) => {
  const t = typeOf(req.params.type, req.ctx);
  const wb = new ExcelJS.Workbook();
  addSheet(wb, 'البيانات', t.columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 6) })), []);
  addSheet(wb, 'شرح الأعمدة', [{ header: 'العمود', key: 'h', width: 30 }, { header: 'إلزامي', key: 'r', width: 10 }, { header: 'ملاحظات', key: 'n', width: 70 }], t.columns.map((c) => ({ h: c.header, r: c.required ? 'نعم' : '', n: c.note })));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="import-${req.params.type}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

async function readRows(t: ImportType, file?: Express.Multer.File) {
  if (!file || !/\.(xlsx|csv)$/i.test(file.originalname)) throw badRequest('اختر ملف Excel (.xlsx) أو CSV');
  const { sheets } = await readTable(file.buffer, file.originalname);
  const rows = sheets[0]?.rows ?? [];
  const hi = rows.findIndex((r) => t.columns.filter((c) => c.required).every((c) => r.some((x) => String(x ?? '').trim() === c.header)));
  if (hi < 0) throw badRequest(`لم يُعثر على صف العناوين؛ استخدم قالب «${t.title}»`);
  const head = rows[hi].map((x) => String(x ?? '').trim());
  const out: Checked[] = [];
  rows.slice(hi + 1).forEach((r, i) => {
    if (!r.some((x) => x != null && String(x).trim() !== '')) return;
    const values: Values = {};
    for (const c of t.columns) { const j = head.indexOf(c.header); const v = j >= 0 ? r[j] : ''; values[c.key] = v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim(); }
    out.push({ line: hi + 2 + i, values, errors: [], warnings: [] });
  });
  if (!out.length) throw badRequest('الملف لا يحتوي على بيانات');
  if (out.length > 5000) throw badRequest('الحد الأقصى 5000 سطر في الملف الواحد');
  return out;
}

const summary = (rows: Checked[]) => ({ total: rows.length, errors: rows.filter((r) => r.errors.length).length, skipped: rows.filter((r) => r.skip && !r.errors.length).length, ready: rows.filter((r) => !r.skip && !r.errors.length).length });

/** Checks the file. Nothing is saved. */
importsRouter.post('/imports/:type/preview', requirePerm('accounting.import'), upload.single('file'), ah(async (req, res) => {
  const t = typeOf(req.params.type, req.ctx);
  const rows = await readRows(t, req.file);
  await t.check(rows, prisma);
  res.json({ rows: rows.map(({ data: _d, ...r }) => r), summary: summary(rows) });
}));

/** Imports the same file after confirmation: everything or nothing; any row with an error stops it. */
importsRouter.post('/imports/:type/commit', requirePerm('accounting.import'), upload.single('file'), ah(async (req, res) => {
  const t = typeOf(req.params.type, req.ctx);
  const rows = await readRows(t, req.file);
  const r = await prisma.$transaction(async (tx) => {
    await t.check(rows, tx);
    const s = summary(rows);
    if (s.errors) throw badRequest(`في الملف ${s.errors} سطر فيه أخطاء؛ صحّحها ثم أعد المعاينة`);
    const todo = rows.filter((x) => !x.skip);
    const n = todo.length ? await t.save(tx, req.ctx, todo) : 0;
    await audit(tx, req.ctx, { action: 'accounting.import', entityType: 'report', entityId: req.params.type, summary: `استيراد ${t.title} من «${req.file!.originalname}»: ${n} مُضاف، ${s.skipped} متجاوز` });
    return { imported: n, ...s };
  }, { timeout: 120_000 });
  res.json(r);
}));
