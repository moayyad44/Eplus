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

const prisma = new PrismaClient();

async function main() {
  // Permissions catalog (sync)
  for (const [key, v] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, ...v }, update: v });
  }
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
        staffType: 'ADMIN', branchId: branch.id, mustChangePassword: generated,
      },
    });
    console.log(`\n  Admin account created → username: ${username}${generated ? `  password: ${password}  (change it after first login)` : ''}\n`);
  }
  // Staff created before branches existed get the main branch.
  await prisma.user.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });
  console.log('Bootstrap complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
