import { z } from 'zod';
import type { Db } from './prisma';
import { prisma } from './prisma';

export const settingSchemas = {
  clinic: z.object({
    name: z.string().min(1).max(120).default('EmergencyPlus'),
    nameEn: z.string().max(120).default('EmergencyPlus Clinic'),
    logoKey: z.string().max(200).nullable().default(null),
    address: z.string().max(300).default(''),
    phone: z.string().max(40).default(''),
    email: z.string().max(120).default(''),
    website: z.string().max(120).default(''),
    workingHours: z.string().max(300).default(''),
    taxNumber: z.string().max(60).default(''),
    reportFooter: z.string().max(500).default(''),
  }),
  financial: z.object({
    currency: z.string().min(1).max(10).default('JOD'),
    currencySymbol: z.string().max(10).default('د.أ'),
    decimals: z.number().int().min(0).max(3).default(3),
    defaultTaxRate: z.number().min(0).max(100).default(0),
    invoicePrefix: z.string().max(12).default('INV-'),
    receiptPrefix: z.string().max(12).default('RCP-'),
    invoiceDueDays: z.number().int().min(0).max(365).default(30),
    invoiceFooter: z.string().max(500).default('شكراً لثقتكم'),
    thermalReceipt: z.boolean().default(false),
  }),
  medical: z.object({
    defaultAppointmentMinutes: z.number().int().min(5).max(240).default(15),
    prescriptionFooter: z.string().max(500).default(''),
    /** Doctor name printed at the end of every medical report form, whoever wrote it. */
    reportDoctorName: z.string().max(120).default('Dr. Mus\u2019ab Odeh'),
  }),
  /** EmergencyPlus Accounting */
  accounting: z.object({
    /** Entries by users without the approve permission wait for approval (else they post on save). */
    requireApproval: z.boolean().default(true),
    /** Operations of EmergencyPlus from this day on are posted automatically (null = not started yet). */
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    currency: z.string().default('JOD'),
  }),
  inventory: z.object({
    expiryAlertDays: z.number().int().min(1).max(365).default(60),
    defaultMinQuantity: z.number().min(0).default(5),
    /** Warehouse stock sold through invoices comes out of (null = the default warehouse). */
    saleWarehouseId: z.string().uuid().nullable().default(null),
  }),
  attendance: z.object({
    graceMinutes: z.number().int().min(0).max(120).default(10),
    autoAbsent: z.boolean().default(true),
  }),
  /** E Coin: doctors' virtual coins (no cash value). Earned on lab invoices, spent on shifts. */
  ecoin: z.object({
    enabled: z.boolean().default(true),
    /** Coins per issued invoice containing lab tests (one per invoice, whatever the number of tests). */
    coinsPerLabInvoice: z.number().int().min(0).max(100).default(1),
    /** Each coin expires this many days after it was earned. */
    expiryDays: z.number().int().min(1).max(3650).default(30),
    /** Warn the doctor this many days before coins expire. */
    expiryWarnDays: z.number().int().min(0).max(60).default(5),
    /** Price for a doctor to secure (protect) a shift distributed to him. */
    securePrice: z.number().int().min(0).max(100).default(1),
    /** Default price by shift length; a duration not listed uses otherPrice. Per-shift rules override these. */
    durationPrices: z.array(z.object({ hours: z.number().min(0.5).max(24), price: z.number().int().min(0).max(100) })).max(20)
      .default([{ hours: 8, price: 2 }, { hours: 12, price: 3 }]),
    otherPrice: z.number().int().min(0).max(100).default(2),
    /** No purchase when the shift starts within this many minutes (or has started). */
    purchaseLeadMinutes: z.number().int().min(0).max(1440).default(60),
    /** Incentive rule: after N worked shifts with fewer than minCoins earned, the next purchases cost less. */
    penaltyEnabled: z.boolean().default(true),
    penaltyWindowShifts: z.number().int().min(1).max(50).default(5),
    penaltyMinCoins: z.number().int().min(1).max(100).default(1),
    penaltyDiscount: z.number().int().min(0).max(100).default(1),
    penaltyUses: z.number().int().min(1).max(50).default(5),
  }),
  /** Shift exchange between staff (doctors and nurses): swaps, release, partial coverage. */
  shiftExchange: z.object({
    swapEnabled: z.boolean().default(true),
    releaseEnabled: z.boolean().default(true),
    coverEnabled: z.boolean().default(true),
    /** Swaps and releases close this many minutes before the shift starts. */
    changeLeadMinutes: z.number().int().min(0).max(1440).default(60),
    minCoverMinutes: z.number().int().min(5).max(720).default(15),
    maxCoverMinutes: z.number().int().min(5).max(720).default(180),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;

export async function getSetting<K extends SettingKey>(key: K, db: Db = prisma): Promise<SettingValue<K>> {
  const row = await db.setting.findUnique({ where: { key } });
  const schema = settingSchemas[key] as z.ZodTypeAny;
  const parsed = schema.safeParse(row?.value ?? {});
  return (parsed.success ? parsed.data : schema.parse({})) as SettingValue<K>;
}

export async function getAllSettings(db: Db = prisma) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(settingSchemas) as SettingKey[]) out[key] = await getSetting(key, db);
  return out as { [K in SettingKey]: SettingValue<K> };
}
