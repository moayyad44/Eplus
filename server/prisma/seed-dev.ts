/**
 * DEVELOPMENT / DEMO DATA ONLY.
 * Creates demo staff accounts, catalog prices, lab tests, drugs, inventory and a few demo patients
 * so the system can be explored locally. Every demo record is tagged with "[DEMO]" where a free-text
 * field exists. Refuses to run when NODE_ENV=production.
 *
 *   npm run db:seed:dev
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, type ServiceCategory } from '@prisma/client';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev.ts must never run in production.');
  process.exit(1);
}

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'Test@12345';

async function counter(key: string) {
  const r = await prisma.$queryRaw<{ value: number }[]>`
    INSERT INTO counters (key, value) VALUES (${key}, 1) ON CONFLICT (key) DO UPDATE SET value = counters.value + 1 RETURNING value`;
  return Number(r[0].value);
}

async function main() {
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: 'MAIN' } });
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const staff = [
    { username: 'dr.ahmad', fullName: 'د. أحمد الخطيب', role: 'doctor', staffType: 'DOCTOR', specialty: 'طب عام وطوارئ', phone: '0791111111' },
    { username: 'dr.lina', fullName: 'د. لينا منصور', role: 'doctor', staffType: 'DOCTOR', specialty: 'طب الأطفال', phone: '0792222222' },
    { username: 'nurse.sara', fullName: 'سارة العلي', role: 'nurse', staffType: 'NURSE', specialty: null, phone: '0793333333' },
    { username: 'reception', fullName: 'محمد يوسف', role: 'receptionist', staffType: 'RECEPTIONIST', specialty: null, phone: '0794444444' },
  ] as const;
  for (const s of staff) {
    await prisma.user.upsert({
      where: { username: s.username },
      create: { username: s.username, fullName: s.fullName, roleId: roles[s.role], staffType: s.staffType, specialty: s.specialty, phone: s.phone, passwordHash: hash, branchId: branch.id },
      update: {},
    });
  }

  const services: [string, string, ServiceCategory, number][] = [
    ['CONS', 'استشارة طبية', 'CONSULTATION', 20],
    ['FOLLOW', 'مراجعة', 'EXAMINATION', 5],
    ['INJ-IM', 'حقنة عضل', 'NURSING', 3],
    ['IV-FLUID', 'تركيب محلول وريدي', 'NURSING', 12],
    ['NEB', 'جلسة بخار (Nebulizer)', 'NURSING', 5],
    ['DRESS', 'غيار جرح', 'NURSING', 5],
    ['SUTURE', 'تقطيب جرح', 'PROCEDURE', 25],
    ['ECG', 'تخطيط قلب ECG', 'PROCEDURE', 10],
    ['OTHER', 'خدمات أخرى', 'OTHER', 0],
  ];
  for (const [code, name, category, price] of services) {
    await prisma.service.upsert({ where: { code }, create: { code, name, category, price, allowPriceEdit: code === 'OTHER' }, update: {} });
  }

  const labs: [string, string, string, string | null, string | null, { name: string; unit?: string; referenceRange?: string }[] | null, number][] = [
    ['CBC', 'صورة دم كاملة CBC', 'Blood', null, null, [
      { name: 'WBC', unit: '10^3/uL', referenceRange: '4.0-11.0' }, { name: 'RBC', unit: '10^6/uL', referenceRange: '4.2-5.9' },
      { name: 'Hemoglobin', unit: 'g/dL', referenceRange: '12-17' }, { name: 'Platelets', unit: '10^3/uL', referenceRange: '150-400' },
    ], 8],
    ['FBS', 'سكر صائم', 'Blood', 'mg/dL', '70-100', null, 3],
    ['RBS', 'سكر عشوائي', 'Blood', 'mg/dL', '< 140', null, 3],
    ['HBA1C', 'السكر التراكمي HbA1c', 'Blood', '%', '4.0-5.6', null, 10],
    ['CRP', 'CRP', 'Blood', 'mg/L', '< 5', null, 7],
    ['URINE', 'تحليل بول كامل', 'Urine', null, null, [{ name: 'pH', referenceRange: '4.5-8' }, { name: 'Protein', referenceRange: 'Negative' }, { name: 'Glucose', referenceRange: 'Negative' }, { name: 'WBC', unit: '/HPF', referenceRange: '0-5' }], 5],
    ['LIPID', 'دهنيات الدم', 'Blood', null, null, [{ name: 'Cholesterol', unit: 'mg/dL', referenceRange: '< 200' }, { name: 'Triglycerides', unit: 'mg/dL', referenceRange: '< 150' }, { name: 'HDL', unit: 'mg/dL', referenceRange: '> 40' }, { name: 'LDL', unit: 'mg/dL', referenceRange: '< 100' }], 15],
  ];
  for (const [code, name, sampleType, unit, referenceRange, parameters, price] of labs) {
    const svc = await prisma.service.upsert({ where: { code: `LAB-${code}` }, create: { code: `LAB-${code}`, name: `تحليل: ${name}`, category: 'LAB', price }, update: {} });
    await prisma.labTest.upsert({ where: { code }, create: { code, name, category: 'مختبر', sampleType, unit, referenceRange, parameters: parameters ?? undefined, serviceId: svc.id }, update: {} });
  }

  const drugs = [
    ['Paracetamol 500mg', 'Paracetamol', 'Tablet', '500mg', '1 حبة', 'كل 6 ساعات عند اللزوم', 'فموي'],
    ['Ibuprofen 400mg', 'Ibuprofen', 'Tablet', '400mg', '1 حبة', '3 مرات يومياً بعد الأكل', 'فموي'],
    ['Amoxicillin 500mg', 'Amoxicillin', 'Capsule', '500mg', '1 كبسولة', 'كل 8 ساعات', 'فموي'],
    ['Augmentin 1g', 'Amoxicillin/Clavulanate', 'Tablet', '1g', '1 حبة', 'مرتين يومياً', 'فموي'],
    ['Azithromycin 500mg', 'Azithromycin', 'Tablet', '500mg', '1 حبة', 'مرة يومياً', 'فموي'],
    ['Omeprazole 20mg', 'Omeprazole', 'Capsule', '20mg', '1 كبسولة', 'مرة يومياً قبل الإفطار', 'فموي'],
    ['Loratadine 10mg', 'Loratadine', 'Tablet', '10mg', '1 حبة', 'مرة يومياً', 'فموي'],
    ['Ventolin Inhaler', 'Salbutamol', 'Inhaler', '100mcg', '2 بخة', 'عند اللزوم', 'استنشاق'],
  ];
  if (!(await prisma.drug.count())) {
    await prisma.drug.createMany({ data: drugs.map(([name, genericName, form, strength, defaultDose, defaultFrequency, defaultRoute]) => ({ name, genericName, form, strength, defaultDose, defaultFrequency, defaultRoute })) });
  }

  let supplier = await prisma.supplier.findFirst({ where: { name: 'شركة المستلزمات الطبية [DEMO]' } });
  if (!supplier) supplier = await prisma.supplier.create({ data: { name: 'شركة المستلزمات الطبية [DEMO]', phone: '065555555', notes: '[DEMO]' } });

  const cat = Object.fromEntries((await prisma.inventoryCategory.findMany()).map((c) => [c.name, c.id]));
  const unit = Object.fromEntries((await prisma.unit.findMany()).map((u) => [u.name, u.id]));
  const items: [string, string, string, string, number, number, number, number | null, number][] = [
    ['قفازات طبية (M)', 'GLV-M', 'مستلزمات طبية', 'علبة', 40, 10, 3.5, null, 400],
    ['سرنجات 5 مل', 'SYR-5', 'مستلزمات طبية', 'قطعة', 500, 100, 0.08, null, 300],
    ['شاش معقم', 'GAUZE', 'مواد تمريضية', 'علبة', 30, 10, 2.0, null, 200],
    ['محلول ملحي 500 مل', 'NS-500', 'مواد تمريضية', 'قطعة', 60, 20, 0.9, null, 120],
    ['أنابيب سحب دم', 'TUBE-EDTA', 'مواد مختبر', 'قطعة', 300, 50, 0.12, null, 365],
    ['Paracetamol 500mg (علبة)', 'MED-PARA', 'أدوية', 'علبة', 50, 15, 0.8, 1.5, 25],
    ['معقم يدين', 'SANIT', 'مواد تنظيف', 'قطعة', 8, 10, 2.5, null, 500],
  ];
  for (const [name, sku, c, u, qty, min, cost, sale, expiryDays] of items) {
    if (await prisma.inventoryItem.findUnique({ where: { sku } })) continue;
    const expiryDate = new Date(Date.now() + expiryDays * 86_400_000);
    const item = await prisma.inventoryItem.create({
      data: { name, sku, categoryId: cat[c], unitId: unit[u], quantity: qty, minQuantity: min, purchasePrice: cost, salePrice: sale, supplierId: supplier.id, expiryDate: new Date(expiryDate.toISOString().slice(0, 10)), batchNumber: `B-${sku}-01`, location: 'المستودع', notes: '[DEMO]' },
    });
    await prisma.inventoryTransaction.create({ data: { itemId: item.id, type: 'RECEIPT', quantity: qty, balanceAfter: qty, unitCost: cost, reason: 'رصيد افتتاحي [DEMO]' } });
    if (sku === 'MED-PARA') {
      await prisma.service.upsert({ where: { code: 'MED-PARA' }, create: { code: 'MED-PARA', name: 'Paracetamol 500mg (علبة)', category: 'MEDICATION', price: sale!, inventoryItemId: item.id }, update: {} });
    }
  }

  const patients: [string, string, 'MALE' | 'FEMALE', string][] = [
    ['خالد محمود العمري', '0795000001', 'MALE', '1985-03-12'],
    ['ريم أحمد حداد', '0795000002', 'FEMALE', '1992-07-25'],
    ['يوسف خالد العمري', '0795000001', 'MALE', '2016-11-02'],
    ['فاطمة سليم', '0785000003', 'FEMALE', '1960-01-30'],
  ];
  for (const [fullName, phone, gender, dob] of patients) {
    if (await prisma.patient.findFirst({ where: { fullName, phone } })) continue;
    const n = await counter('patient_file');
    await prisma.patient.create({ data: { fullName, phone, gender, dateOfBirth: new Date(dob), fileNumber: String(n).padStart(6, '0'), nationality: 'أردني', notes: '[DEMO] بيانات تجريبية' } });
  }

  console.log(`Demo data ready. Demo accounts (password ${DEMO_PASSWORD}): ${staff.map((s) => s.username).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
