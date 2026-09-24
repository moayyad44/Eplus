/**
 * Permission catalog. Keys are enforced on every API route (see middleware/auth.ts).
 * Roles are stored in the DB and fully editable from Settings → Roles & Permissions;
 * DEFAULT_ROLES is only used to bootstrap a fresh installation.
 */
export const PERMISSIONS = {
  // Dashboard
  'dashboard.admin': { module: 'dashboard', description: 'لوحة تحكم المدير' },
  // Users & roles
  'users.view': { module: 'users', description: 'عرض المستخدمين والموظفين' },
  'users.manage': { module: 'users', description: 'إضافة وتعديل المستخدمين' },
  'roles.manage': { module: 'users', description: 'إدارة الأدوار والصلاحيات' },
  // Patients
  'patients.view': { module: 'patients', description: 'البحث عن المرضى وعرض بياناتهم الأساسية' },
  'patients.create': { module: 'patients', description: 'تسجيل مريض جديد' },
  'patients.update': { module: 'patients', description: 'تعديل بيانات المريض الأساسية' },
  'patients.delete': { module: 'patients', description: 'أرشفة ملف مريض' },
  // Medical record
  'medical.view': { module: 'medical', description: 'عرض الملف الطبي (التشخيص، الوصفات، التقارير)' },
  'medical.history.manage': { module: 'medical', description: 'تعديل التاريخ المرضي والحساسية والأدوية' },
  'consultation.manage': { module: 'medical', description: 'إجراء الكشف: التشخيص، الملاحظات، الوصفة، التقرير' },
  'vitals.record': { module: 'medical', description: 'تسجيل العلامات الحيوية' },
  'nursing.record': { module: 'medical', description: 'تسجيل الإجراءات التمريضية' },
  'attachments.view': { module: 'medical', description: 'عرض المرفقات' },
  'attachments.upload': { module: 'medical', description: 'رفع المرفقات' },
  // Queue
  'queue.view': { module: 'queue', description: 'عرض قائمة الانتظار (الخاصة بالطبيب فقط)' },
  'queue.view_all': { module: 'queue', description: 'عرض قائمة الانتظار لجميع الأطباء' },
  'queue.manage': { module: 'queue', description: 'إضافة زيارة إلى قائمة الانتظار وتعديلها' },
  'queue.call': { module: 'queue', description: 'استدعاء المريض وتحويله بين المراحل' },
  'queue.reorder': { module: 'queue', description: 'إعادة ترتيب قائمة الانتظار' },
  'queue.revert': { module: 'queue', description: 'إرجاع الزيارة إلى حالة سابقة' },
  // Appointments
  'appointments.view': { module: 'appointments', description: 'عرض المواعيد' },
  'appointments.manage': { module: 'appointments', description: 'إنشاء وتعديل وإلغاء المواعيد' },
  // Laboratory
  'lab.view': { module: 'lab', description: 'عرض طلبات ونتائج التحاليل' },
  'lab.order': { module: 'lab', description: 'طلب التحاليل' },
  'lab.process': { module: 'lab', description: 'جمع العينات وإدخال النتائج' },
  // Billing
  'invoices.view': { module: 'billing', description: 'عرض الفواتير' },
  'invoices.create': { module: 'billing', description: 'إنشاء وإصدار الفواتير' },
  'invoices.update': { module: 'billing', description: 'تعديل الفواتير المسودة' },
  'invoices.discount': { module: 'billing', description: 'منح الخصومات' },
  'invoices.price_override': { module: 'billing', description: 'تعديل سعر البند' },
  'invoices.cancel': { module: 'billing', description: 'إلغاء الفواتير' },
  'payments.create': { module: 'billing', description: 'تسجيل المدفوعات' },
  'payments.refund': { module: 'billing', description: 'تسجيل المرتجعات' },
  'payments.void': { module: 'billing', description: 'إلغاء دفعة مسجلة' },
  'cashier.view': { module: 'billing', description: 'الصندوق والحسابات اليومية' },
  // Expenses
  'expenses.view': { module: 'expenses', description: 'عرض المصروفات' },
  'expenses.manage': { module: 'expenses', description: 'تسجيل وإلغاء المصروفات' },
  // Inventory
  'inventory.view': { module: 'inventory', description: 'عرض المخزون' },
  'inventory.manage': { module: 'inventory', description: 'إضافة وتعديل الأصناف' },
  'inventory.transact': { module: 'inventory', description: 'تسجيل حركات المخزون' },
  'stockcount.manage': { module: 'inventory', description: 'إنشاء جلسات الجرد وإدخال الكميات' },
  'stockcount.approve': { module: 'inventory', description: 'اعتماد الجرد' },
  'suppliers.view': { module: 'inventory', description: 'عرض الموردين' },
  'suppliers.manage': { module: 'inventory', description: 'إدارة الموردين وأوامر الشراء والدفعات' },
  // Staff
  'shifts.view': { module: 'staff', description: 'عرض جداول الدوام' },
  'shifts.manage': { module: 'staff', description: 'إدارة الشفتات والجداول والإجازات' },
  'attendance.view': { module: 'staff', description: 'عرض الحضور' },
  'attendance.manage': { module: 'staff', description: 'تسجيل وتعديل الحضور لجميع الموظفين' },
  // Reports
  'reports.patients': { module: 'reports', description: 'تقارير المرضى' },
  'reports.doctors': { module: 'reports', description: 'تقارير الأطباء' },
  'reports.financial': { module: 'reports', description: 'التقارير المالية' },
  'reports.inventory': { module: 'reports', description: 'تقارير المخزون' },
  'reports.attendance': { module: 'reports', description: 'تقارير الدوام' },
  // System
  'settings.view': { module: 'settings', description: 'عرض الإعدادات' },
  'settings.manage': { module: 'settings', description: 'تعديل الإعدادات' },
  'audit.view': { module: 'settings', description: 'عرض سجل العمليات' },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: PermissionKey[] }[] = [
  {
    key: 'admin',
    name: 'المدير',
    description: 'صلاحية كاملة على النظام',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'doctor',
    name: 'الطبيب',
    description: 'الكشف الطبي والتشخيص والوصفات والتحاليل',
    permissions: [
      'patients.view', 'medical.view', 'medical.history.manage', 'consultation.manage', 'vitals.record',
      'attachments.view', 'attachments.upload', 'queue.view', 'queue.call', 'appointments.view',
      'lab.view', 'lab.order', 'shifts.view', 'attendance.view', 'invoices.view',
    ],
  },
  {
    key: 'nurse',
    name: 'الممرض',
    description: 'العلامات الحيوية والإجراءات التمريضية وقائمة الانتظار',
    permissions: [
      'patients.view', 'medical.view', 'vitals.record', 'nursing.record', 'attachments.view', 'attachments.upload',
      'queue.view', 'queue.view_all', 'queue.call', 'lab.view', 'lab.process', 'appointments.view',
      'inventory.view', 'shifts.view', 'attendance.view',
    ],
  },
  {
    key: 'receptionist',
    name: 'موظف الاستقبال',
    description: 'تسجيل المرضى، قائمة الانتظار، المواعيد، الفواتير والمدفوعات',
    permissions: [
      'patients.view', 'patients.create', 'patients.update', 'queue.view', 'queue.view_all', 'queue.manage',
      'queue.call', 'queue.reorder', 'appointments.view', 'appointments.manage', 'invoices.view', 'invoices.create',
      'invoices.update', 'payments.create', 'attachments.upload', 'shifts.view', 'attendance.view',
    ],
  },
];
