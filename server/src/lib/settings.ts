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
    /** Quick nursing procedures shown in the visit; their linked services (with quantities) are added to the visit's invoice. */
    nursingProcedures: z.array(z.preprocess(
      // Lists saved by the single-service version ({ serviceId }) are read as one service.
      (v) => {
        const o = v as { name?: string; serviceId?: string | null; services?: unknown };
        return o && typeof o === 'object' && o.services === undefined && 'serviceId' in o ? { name: o.name, services: o.serviceId ? [{ serviceId: o.serviceId, quantity: 1 }] : [] } : v;
      },
      z.object({ name: z.string().trim().min(2).max(100), services: z.array(z.object({ serviceId: z.string().uuid(), quantity: z.number().positive().max(100).default(1) })).max(15).default([]) }),
    )).max(60)
      .default(['حقنة عضل', 'حقنة وريد', 'تركيب كانيولا', 'تركيب محلول وريدي', 'جلسة بخار', 'غيار جرح', 'قياس سكر', 'تخطيط قلب ECG', 'سحب عينة دم'].map((name) => ({ name, services: [] }))),
  }),
  /** EmergencyPlus Accounting */
  accounting: z.object({
    /** Entries by users without the approve permission wait for approval (else they post on save). */
    requireApproval: z.boolean().default(true),
    /** Operations of EmergencyPlus from this day on are posted automatically (null = not started yet). */
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    currency: z.string().default('JOD'),
    /** PERPETUAL: every stock movement is valued in the books (inventory / cost of sales). PERIODIC: purchases go to expenses. */
    inventoryMethod: z.enum(['PERPETUAL', 'PERIODIC']).default('PERPETUAL'),
    /** A reason must be given when editing an entry or a voucher. */
    requireReason: z.boolean().default(false),
    /** Alerts: card payments not reaching the bank after N days; cheques due within N days; under collection longer than N days. */
    visaLateDays: z.number().int().min(1).max(60).default(3),
    chequeDueDays: z.number().int().min(1).max(60).default(7),
    collectionLateDays: z.number().int().min(1).max(90).default(10),
    /** Account chosen for each role used by the automatic entries (empty = the starting account of that role). */
    accountMap: z.record(z.string(), z.string().uuid()).default({}),
    /** Account that receives each payment method (cash box, bank, Visa clearing…). */
    methodAccounts: z.record(z.string(), z.string().uuid()).default({}),
    /** Expense account of each expense category. */
    expenseAccounts: z.record(z.string(), z.string().uuid()).default({}),
    /** Revenue account of each service type. */
    revenueAccounts: z.record(z.string(), z.string().uuid()).default({}),
    /** Receivable sub-account of each insurance company (used when «ذمم شركات التأمين» is a main account with sub-accounts). */
    insuranceAccounts: z.record(z.string(), z.string().uuid()).default({}),
  }),
  inventory: z.object({
    expiryAlertDays: z.number().int().min(1).max(365).default(60),
    defaultMinQuantity: z.number().min(0).default(5),
    /** Warehouse stock sold through invoices comes out of (null = the default warehouse). */
    saleWarehouseId: z.string().uuid().nullable().default(null),
  }),
  /** Staff, attendance and payroll policies (Settings → الدوام والرواتب). Each policy is independent of the others. */
  attendance: z.object({
    /** CLOCK: the employee's check-in/out are the source of the worked time. SCHEDULE: the shift schedule is the
     *  source; actual check-in/out (when recorded) only measure lateness, early leave and overtime. */
    method: z.enum(['CLOCK', 'SCHEDULE']).default('CLOCK'),
    graceMinutes: z.number().int().min(0).max(120).default(10),
    /** A scheduled shift with nothing recorded the next day: ABSENT automatically, or NO_RECORD (needs review). */
    autoAbsent: z.boolean().default(true),
    late: z.object({
      deduct: z.boolean().default(false),
      /** MINUTE / Q15 / Q30 / HOUR: each started block counts in full. */
      rounding: z.enum(['MINUTE', 'Q15', 'Q30', 'HOUR']).default('MINUTE'),
      /** HOUR_VALUE: the late time × the hour value; FIXED: an amount per late arrival; PERCENT: % of the day's wage per late arrival. */
      method: z.enum(['HOUR_VALUE', 'FIXED', 'PERCENT']).default('HOUR_VALUE'),
      fixedAmount: z.number().min(0).max(1000).default(0),
      percent: z.number().min(0).max(100).default(0),
      /** AUTO: deducted when the payroll is prepared; APPROVAL: only lateness a manager approved for deduction. */
      mode: z.enum(['AUTO', 'APPROVAL']).default('AUTO'),
      allowExemption: z.boolean().default(true),
      allowExcuse: z.boolean().default(true),
    }).default({}),
    early: z.object({
      /** Early leave uses the lateness rounding and method. */
      deduct: z.boolean().default(false),
    }).default({}),
    overtime: z.object({
      enabled: z.boolean().default(false),
      /** Overtime is proven only by an actual leave time; otherwise a shift extension recorded at handover also counts. */
      requireCheckout: z.boolean().default(true),
      minMinutes: z.number().int().min(0).max(240).default(30),
      method: z.enum(['HOUR_VALUE', 'MULTIPLIER', 'FIXED']).default('MULTIPLIER'),
      multiplier: z.number().min(1).max(5).default(1.25),
      fixedRate: z.number().min(0).max(1000).default(0),
      holidayEnabled: z.boolean().default(false),
      holidayMultiplier: z.number().min(1).max(5).default(1.5),
      /** Weekly rest days (0 = Sunday … 6 = Saturday) and official holidays (YYYY-MM-DD). */
      holidayWeekdays: z.array(z.number().int().min(0).max(6)).max(7).default([5]),
      holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).default([]),
      needsApproval: z.boolean().default(true),
    }).default({}),
    payroll: z.object({
      /** Pay type proposed for a new salary profile (each employee keeps his own). */
      defaultPayType: z.enum(['MONTHLY', 'HOURLY']).default('MONTHLY'),
      /** Day value = monthly salary ÷ dayDivisor; hour value = day value ÷ dailyHours. */
      dayDivisor: z.number().int().min(20).max(31).default(30),
      dailyHours: z.number().min(1).max(24).default(8),
      absenceAffects: z.boolean().default(true),
      autoAllowances: z.boolean().default(true),
      adjustmentsNeedApproval: z.boolean().default(false),
      lockOnApproval: z.boolean().default(true),
    }).default({}),
    leaves: z.object({
      needsApproval: z.boolean().default(true),
      /** Effect of each leave type and of a justified / unjustified absence: PAID (no deduction), HALF, UNPAID (a day's wage). */
      pay: z.object({
        ANNUAL: z.enum(['PAID', 'HALF', 'UNPAID']).default('PAID'),
        SICK: z.enum(['PAID', 'HALF', 'UNPAID']).default('PAID'),
        UNPAID: z.enum(['PAID', 'HALF', 'UNPAID']).default('UNPAID'),
        EMERGENCY: z.enum(['PAID', 'HALF', 'UNPAID']).default('PAID'),
        OTHER: z.enum(['PAID', 'HALF', 'UNPAID']).default('PAID'),
      }).default({}),
      excusedAbsence: z.enum(['PAID', 'HALF', 'UNPAID']).default('PAID'),
      unexcusedAbsence: z.enum(['PAID', 'HALF', 'UNPAID']).default('UNPAID'),
      annualDays: z.number().int().min(0).max(60).default(14),
      sickDays: z.number().int().min(0).max(60).default(14),
    }).default({}),
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
