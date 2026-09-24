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
  }),
  inventory: z.object({
    expiryAlertDays: z.number().int().min(1).max(365).default(60),
    defaultMinQuantity: z.number().min(0).default(5),
  }),
  attendance: z.object({
    graceMinutes: z.number().int().min(0).max(120).default(10),
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
