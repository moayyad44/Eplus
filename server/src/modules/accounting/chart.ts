/**
 * Starting chart of accounts (Arabic). Created once, on the first bootstrap that has no accounts; afterwards it
 * belongs to the accountant (renamed, extended, stopped from the accounting screens). `key` marks the accounts
 * that automatic entries use; they can be renamed or moved but are never deleted.
 */
export type SeedAccount = { code: string; name: string; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'; nature?: 'DEBIT' | 'CREDIT'; group?: boolean; key?: string; parent?: string };

const A = 'ASSET', L = 'LIABILITY', E = 'EQUITY', R = 'REVENUE', X = 'EXPENSE';
export const CHART_OF_ACCOUNTS: SeedAccount[] = [
  { code: '1', name: 'الأصول', type: A, group: true },
  { code: '11', name: 'الأصول المتداولة', type: A, group: true, parent: '1' },
  { code: '1101', name: 'النقدية في الصناديق', type: A, group: true, parent: '11', key: 'CASH_GROUP' },
  { code: '110101', name: 'الصندوق الرئيسي', type: A, parent: '1101', key: 'CASH_MAIN' },
  { code: '1102', name: 'الحسابات البنكية', type: A, group: true, parent: '11', key: 'BANK_GROUP' },
  { code: '1103', name: 'الفيزا قيد التسوية (Visa Clearing)', type: A, parent: '11', key: 'VISA_CLEARING' },
  { code: '1104', name: 'CliQ والدفع الإلكتروني قيد التسوية', type: A, parent: '11', key: 'EPAY_CLEARING' },
  { code: '1105', name: 'الشيكات الواردة في الخزنة', type: A, parent: '11', key: 'CHEQUES_ON_HAND' },
  { code: '1106', name: 'الشيكات المودعة قيد التحصيل', type: A, parent: '11', key: 'CHEQUES_UNDER_COLLECTION' },
  { code: '1107', name: 'ذمم المرضى', type: A, parent: '11', key: 'AR_PATIENTS' },
  { code: '1108', name: 'ذمم شركات التأمين', type: A, parent: '11', key: 'AR_INSURANCE' },
  { code: '1109', name: 'سلف الموظفين', type: A, parent: '11', key: 'EMPLOYEE_ADVANCES' },
  { code: '1110', name: 'المخزون', type: A, parent: '11', key: 'INVENTORY' },
  { code: '1111', name: 'ذمم مدينة أخرى', type: A, parent: '11', key: 'AR_OTHER' },
  { code: '12', name: 'الأصول الثابتة', type: A, group: true, parent: '1', key: 'FIXED_ASSETS_GROUP' },
  { code: '1201', name: 'الأجهزة والمعدات الطبية', type: A, parent: '12', key: 'FA_MEDICAL' },
  { code: '1202', name: 'الأثاث', type: A, parent: '12', key: 'FA_FURNITURE' },
  { code: '1203', name: 'أجهزة الكمبيوتر', type: A, parent: '12', key: 'FA_COMPUTERS' },
  { code: '1204', name: 'أصول ثابتة أخرى', type: A, parent: '12', key: 'FA_OTHER' },
  { code: '1209', name: 'مجمع الإهلاك', type: A, nature: 'CREDIT', parent: '12', key: 'ACCUM_DEPRECIATION' },

  { code: '2', name: 'الالتزامات', type: L, group: true },
  { code: '21', name: 'الالتزامات المتداولة', type: L, group: true, parent: '2' },
  { code: '2101', name: 'الموردون', type: L, parent: '21', key: 'AP_SUPPLIERS' },
  { code: '2102', name: 'الشيكات الصادرة', type: L, parent: '21', key: 'CHEQUES_ISSUED' },
  { code: '2103', name: 'الرواتب المستحقة', type: L, parent: '21', key: 'SALARIES_PAYABLE' },
  { code: '2104', name: 'المصروفات المستحقة', type: L, parent: '21', key: 'ACCRUED_EXPENSES' },
  { code: '2105', name: 'مبالغ مدفوعة بالزيادة من المرضى', type: L, parent: '21', key: 'PATIENT_CREDITS' },
  { code: '2106', name: 'ضريبة المبيعات المستحقة', type: L, parent: '21', key: 'SALES_TAX' },
  { code: '2109', name: 'التزامات أخرى', type: L, parent: '21', key: 'OTHER_LIABILITIES' },

  { code: '3', name: 'حقوق الملكية', type: E, group: true },
  { code: '3101', name: 'رأس المال', type: E, parent: '3', key: 'CAPITAL' },
  { code: '3102', name: 'الأرباح المحتجزة', type: E, parent: '3', key: 'RETAINED_EARNINGS' },
  { code: '3103', name: 'صافي أرباح السنة', type: E, parent: '3', key: 'CURRENT_YEAR_PROFIT' },
  { code: '3104', name: 'المسحوبات الشخصية', type: E, nature: 'DEBIT', parent: '3', key: 'DRAWINGS' },
  { code: '3105', name: 'حساب الأرصدة الافتتاحية', type: E, parent: '3', key: 'OPENING_BALANCES' },

  { code: '4', name: 'الإيرادات', type: R, group: true },
  { code: '4101', name: 'إيرادات الكشف الطبي', type: R, parent: '4', key: 'REV_CONSULTATION' },
  { code: '4102', name: 'إيرادات التحاليل المخبرية', type: R, parent: '4', key: 'REV_LAB' },
  { code: '4103', name: 'إيرادات الخدمات الطبية', type: R, parent: '4', key: 'REV_SERVICES' },
  { code: '4104', name: 'إيرادات الأدوية والمستلزمات', type: R, parent: '4', key: 'REV_MEDICATION' },
  { code: '4109', name: 'إيرادات أخرى', type: R, parent: '4', key: 'REV_OTHER' },
  { code: '4190', name: 'خصومات ممنوحة للمرضى', type: R, nature: 'DEBIT', parent: '4', key: 'DISCOUNTS_GIVEN' },

  { code: '5', name: 'المصروفات', type: X, group: true },
  { code: '5101', name: 'الرواتب والأجور', type: X, parent: '5', key: 'SALARIES' },
  { code: '5102', name: 'الإيجار', type: X, parent: '5', key: 'EXP_RENT' },
  { code: '5103', name: 'الكهرباء والمياه', type: X, parent: '5', key: 'EXP_UTILITIES' },
  { code: '5104', name: 'الإنترنت والاتصالات', type: X, parent: '5', key: 'EXP_TELECOM' },
  { code: '5105', name: 'المستلزمات الطبية', type: X, parent: '5', key: 'EXP_MEDICAL_SUPPLIES' },
  { code: '5106', name: 'المشتريات', type: X, parent: '5', key: 'EXP_PURCHASES' },
  { code: '5107', name: 'الصيانة', type: X, parent: '5', key: 'EXP_MAINTENANCE' },
  { code: '5108', name: 'التسويق والإعلانات', type: X, parent: '5', key: 'EXP_MARKETING' },
  { code: '5109', name: 'العمولات البنكية', type: X, parent: '5', key: 'BANK_CHARGES' },
  { code: '5110', name: 'مصروفات الفيزا', type: X, parent: '5', key: 'VISA_FEES' },
  { code: '5111', name: 'الإهلاك', type: X, parent: '5', key: 'DEPRECIATION' },
  { code: '5112', name: 'المصروفات الإدارية', type: X, parent: '5', key: 'EXP_ADMIN' },
  { code: '5113', name: 'تكلفة الأدوية والمستلزمات المباعة', type: X, parent: '5', key: 'COGS' },
  { code: '5114', name: 'ديون مشطوبة', type: X, parent: '5', key: 'BAD_DEBTS' },
  { code: '5115', name: 'فروقات الجرد', type: X, parent: '5', key: 'COUNT_DIFFERENCES' },
  { code: '5199', name: 'مصروفات أخرى', type: X, parent: '5', key: 'EXP_OTHER' },
];

/** Natural side of each account type (an account may override it, e.g. accumulated depreciation). */
export const NATURE_OF = { ASSET: 'DEBIT', EXPENSE: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT' } as const;
