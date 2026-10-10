/**
 * Production bootstrap — safe to run on every deploy (idempotent).
 * Creates ONLY configuration/reference data: permissions, system roles, default branch,
 * settings, payment methods, base categories/units/visit types, ICD-10 reference codes,
 * the default invoice templates and the first admin account.
 * It never creates patients, invoices or any other operational/demo data (see seed-dev.ts for that).
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES, PERMISSIONS } from '../src/auth/permissions';
import { settingSchemas } from '../src/lib/settings';
import { ICD10_COMMON } from './data/icd10';
import { LAB_PACKAGES, LAB_TESTS, patientPrice } from './data/lab-catalog';
import { INV_CATEGORIES, SHEET_SERVICES, STOCK_ITEMS } from './data/inventory-catalog';

const prisma = new PrismaClient();

async function main() {
  // Permissions catalog (sync). Remember which keys are new in this release.
  const known = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
  const firstRun = known.size === 0;
  for (const [key, v] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, ...v }, update: v });
  }
  const added = Object.keys(PERMISSIONS).filter((k) => !known.has(k));
  await prisma.permission.deleteMany({ where: { key: { notIn: Object.keys(PERMISSIONS) } } });

  // System roles: created once; afterwards they are owned by the admin (editable in Settings).
  for (const r of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: r.key } });
    if (!existing) {
      await prisma.role.create({
        data: { key: r.key, name: r.name, description: r.description, isSystem: true, permissions: { create: r.permissions.map((permissionKey) => ({ permissionKey })) } },
      });
    } else if (r.key === 'admin') {
      // The admin role always holds every permission, including ones added in new releases.
      await prisma.rolePermission.createMany({ data: r.permissions.map((permissionKey) => ({ roleId: existing.id, permissionKey })), skipDuplicates: true });
    } else if (!firstRun && existing.isSystem) {
      // Permissions introduced by this release go to the system roles that have them by default.
      // Existing permissions are left alone, so the administrator's own choices are kept.
      const grant = r.permissions.filter((k) => added.includes(k));
      if (grant.length) await prisma.rolePermission.createMany({ data: grant.map((permissionKey) => ({ roleId: existing.id, permissionKey })), skipDuplicates: true });
    }
  }

  const branch = await prisma.branch.upsert({ where: { code: 'MAIN' }, create: { code: 'MAIN', name: 'الفرع الرئيسي' }, update: {} });

  for (const key of Object.keys(settingSchemas) as (keyof typeof settingSchemas)[]) {
    const value = (settingSchemas[key] as any).parse({});
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: {} });
  }

  const methods = [
    { code: 'CASH', name: 'نقداً (Cash)', requiresReference: false, sortOrder: 1 },
    { code: 'VISA', name: 'فيزا (Visa)', requiresReference: true, sortOrder: 2 },
    { code: 'CLIQ', name: 'كليك (CliQ)', requiresReference: true, sortOrder: 3 },
    { code: 'OTHER_DIGITAL', name: 'دفع إلكتروني آخر', requiresReference: false, sortOrder: 4 },
  ];
  for (const m of methods) await prisma.paymentMethod.upsert({ where: { code: m.code }, create: { ...m, isSystem: true }, update: {} });

  const ensureNamed = async (model: 'expenseCategory' | 'inventoryCategory' | 'visitType', names: string[]) => {
    for (const [i, name] of names.entries()) {
      const exists = await (prisma as any)[model].findFirst({ where: { name } });
      if (!exists) await (prisma as any)[model].create({ data: { name, ...(model === 'visitType' ? { sortOrder: i } : {}) } });
    }
  };
  await ensureNamed('expenseCategory', ['رواتب', 'إيجار', 'كهرباء', 'ماء', 'مستلزمات طبية', 'صيانة', 'مشتريات', 'مصروفات أخرى']);
  await ensureNamed('inventoryCategory', ['مستلزمات طبية', 'مواد تمريضية', 'مواد مختبر', 'أدوية', 'مواد تنظيف', 'قرطاسية', 'أصناف أخرى']);
  await ensureNamed('visitType', ['كشف جديد', 'مراجعة', 'طوارئ', 'إجراء', 'استشارة']);

  const units = [['حبة', 'حبة'], ['علبة', 'علبة'], ['قطعة', 'قطعة'], ['كرتونة', 'كرتونة'], ['مل', 'ml'], ['لتر', 'L'], ['غرام', 'g'], ['زوج', 'زوج'], ['رول', 'رول']];
  for (const [name, symbol] of units) if (!(await prisma.unit.findFirst({ where: { name } }))) await prisma.unit.create({ data: { name, symbol } });

  if (!(await prisma.shift.count())) {
    await prisma.shift.createMany({
      data: [
        { name: 'صباحي', type: 'MORNING', startTime: '08:00', endTime: '16:00', color: '#7cc4ec' },
        { name: 'مسائي', type: 'EVENING', startTime: '16:00', endTime: '00:00', color: '#f5b971' },
        { name: 'ليلي', type: 'NIGHT', startTime: '00:00', endTime: '08:00', color: '#8b8fd8' },
      ],
    });
  }

  await prisma.diagnosisCode.createMany({ data: ICD10_COMMON.map(([code, name, nameAr]) => ({ code, name, nameAr })), skipDuplicates: true });

  // Billing: the consultation fee ("كشفية") is the mandatory item of the default template.
  // Prices are configuration — review them in Settings → Services after installation.
  const exam = await prisma.service.upsert({
    where: { code: 'EXAM' },
    create: { code: 'EXAM', name: 'كشفية طبية', category: 'EXAMINATION', price: 15 },
    update: {},
  });
  if (!(await prisma.invoiceTemplate.findFirst())) {
    await prisma.invoiceTemplate.create({
      data: { name: 'فاتورة كشف (مع كشفية)', description: 'تتضمن الكشفية كمادة إجبارية', isDefault: true, items: { create: [{ serviceId: exam.id, quantity: 1, isMandatory: true }] } },
    });
    await prisma.invoiceTemplate.create({ data: { name: 'فاتورة خدمات (بدون كشفية)', description: 'للمراجعات والخدمات والمواد فقط — نفس الترقيم التسلسلي' } });
  }

  // First administrator
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'admin' } });
  const adminCount = await prisma.user.count({ where: { roleId: adminRole.id, deletedAt: null } });
  if (!adminCount) {
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    const generated = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url') + '9a';
    await prisma.user.create({
      data: {
        username, fullName: process.env.ADMIN_FULLNAME || 'مدير النظام', passwordHash: await bcrypt.hash(password, 12), roleId: adminRole.id,
        staffType: 'ADMIN', branchId: branch.id, mustChangePassword: generated || process.env.ADMIN_FORCE_CHANGE === 'true',
      },
    });
    console.log(`\n  Admin account created → username: ${username}${generated ? `  password: ${password}  (change it after first login)` : ''}\n`);
  }
  // Staff created before branches existed get the main branch.
  await prisma.user.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });
  await importLabCatalog();
  await importStockCatalog();
  console.log('Bootstrap complete.');
}

/**
 * One-time import of the referral-laboratory price list (prisma/data/lab-catalog.ts).
 * Each test becomes a lab test (with the lab's price as labCost) linked to a billable service at the
 * patient price. Tests that already exist by name only get their missing lab price; nothing is
 * duplicated, and once done it never runs again, so later edits and deletions are kept.
 */
async function importLabCatalog() {
  const marker = 'import:lab-catalog-2026-10';
  if (await prisma.counter.findUnique({ where: { key: marker } })) return;
  const rows: [string, string, number, string][] = [...LAB_TESTS, ...LAB_PACKAGES.map(([c, n, l]) => [c, n, l, 'باقات'] as [string, string, number, string])];
  let created = 0, priced = 0;
  for (const [code, name, lab, category] of rows) {
    const existing = await prisma.labTest.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      if (existing.labCost == null) { await prisma.labTest.update({ where: { id: existing.id }, data: { labCost: lab } }); priced++; }
      continue;
    }
    if (await prisma.labTest.findUnique({ where: { code } })) continue;
    const service = await prisma.service.upsert({ where: { code }, create: { code, name, category: 'LAB', price: patientPrice(lab) }, update: {} });
    await prisma.labTest.create({ data: { code, name, category, labCost: lab, serviceId: service.id } });
    created++;
  }
  await prisma.counter.create({ data: { key: marker, value: 1 } });
  console.log(`Lab price list imported: ${created} new tests, ${priced} existing tests priced.`);
}

/**
 * One-time import of the clinic's stock & price list (prisma/data/inventory-catalog.ts).
 * Stock items are created by category with quantity 0 (entered later by a stock count or receipt).
 * Items with a price also get a billable service; it is NOT linked to the stock item, because a
 * linked service cannot be invoiced while its stock is 0 — the link is made in Settings → Services
 * after the opening count. Items without a known price get an editable-price service.
 * Existing items/services with the same name are left alone; it never runs again once done.
 */
async function importStockCatalog() {
  const marker = 'import:stock-catalog-2026-10';
  if (await prisma.counter.findUnique({ where: { key: marker } })) return;
  const catId = new Map<string, string>();
  for (const name of Object.values(INV_CATEGORIES)) {
    const c = (await prisma.inventoryCategory.findFirst({ where: { name } })) ?? (await prisma.inventoryCategory.create({ data: { name } }));
    catId.set(name, c.id);
  }
  const unitId = new Map<string, string>();
  for (const name of new Set(STOCK_ITEMS.map((r) => r[4]))) {
    const u = (await prisma.unit.findFirst({ where: { name } })) ?? (await prisma.unit.create({ data: { name, symbol: name } }));
    unitId.set(name, u.id);
  }
  const serviceExists = async (code: string, name: string) =>
    !!(await prisma.service.findFirst({ where: { OR: [{ code }, { name: { equals: name, mode: 'insensitive' } }], deletedAt: null } }));
  let items = 0, services = 0;
  for (const [sku, name, price, category, unit] of STOCK_ITEMS) {
    const exists = await prisma.inventoryItem.findFirst({ where: { OR: [{ sku }, { name: { equals: name, mode: 'insensitive' } }], deletedAt: null } });
    if (!exists) {
      await prisma.inventoryItem.create({ data: { sku, name, categoryId: catId.get(category), unitId: unitId.get(unit), salePrice: price || null } });
      items++;
    }
    if (price === 0 || (await serviceExists(sku, name))) continue;
    const medication = category === INV_CATEGORIES.meds || category === INV_CATEGORIES.fluids;
    await prisma.service.create({ data: { code: sku, name, category: medication ? 'MEDICATION' : 'NURSING', price: price ?? 0, allowPriceEdit: price == null } });
    services++;
  }
  for (const [code, name, price, category] of SHEET_SERVICES) {
    if (await serviceExists(code, name)) continue;
    await prisma.service.create({ data: { code, name, category, price: price ?? 0, allowPriceEdit: price == null } });
    services++;
  }
  await prisma.counter.create({ data: { key: marker, value: 1 } });
  console.log(`Stock list imported: ${items} items, ${services} billable services.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
