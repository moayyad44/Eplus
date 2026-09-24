export default {
  settings: {
    title: 'الإعدادات', subtitle: 'إعدادات العيادة والقوائم والصلاحيات',
    tabs: { clinic: 'العيادة', financial: 'المالية', paymentMethods: 'طرق الدفع', templates: 'نماذج الفواتير', services: 'الخدمات والمواد', medical: 'الطبية', visitTypes: 'أنواع الزيارات', labTests: 'التحاليل', diagnoses: 'التشخيصات ICD-10', drugs: 'الأدوية', inventory: 'المخزون', expenses: 'تصنيفات المصروفات', shifts: 'الشفتات', roles: 'الأدوار والصلاحيات' },
    clinic: { name: 'اسم العيادة', nameEn: 'الاسم بالإنجليزية', address: 'العنوان', phone: 'الهاتف', email: 'البريد', website: 'الموقع', workingHours: 'ساعات العمل', taxNumber: 'الرقم الضريبي', reportFooter: 'تذييل التقارير', logo: 'الشعار', uploadLogo: 'رفع شعار' },
    financial: { currency: 'رمز العملة', currencySymbol: 'رمز العرض', decimals: 'الخانات العشرية', defaultTaxRate: 'نسبة الضريبة الافتراضية %', invoicePrefix: 'بادئة رقم الفاتورة', receiptPrefix: 'بادئة رقم الإيصال', invoiceDueDays: 'أيام الاستحقاق (بعدها تصبح الفاتورة متأخرة)', invoiceFooter: 'تذييل الفاتورة', thermalReceipt: 'استخدام الطابعة الحرارية للإيصالات افتراضياً' },
    medicalS: { defaultAppointmentMinutes: 'مدة الموعد الافتراضية (دقيقة)', prescriptionFooter: 'تذييل الوصفة الطبية' },
    inventoryS: { expiryAlertDays: 'التنبيه قبل انتهاء الصلاحية بـ (يوم)', defaultMinQuantity: 'الحد الأدنى الافتراضي' },
    attendanceS: { graceMinutes: 'فترة السماح للتأخير (دقيقة)' },
    fields: { name: 'الاسم', code: 'الرمز', price: 'السعر', category: 'التصنيف', taxRate: 'الضريبة %', allowPriceEdit: 'يسمح بتعديل السعر', inventoryItem: 'صنف المخزون المرتبط (للبيع)', color: 'اللون', duration: 'المدة (دقيقة)', order: 'الترتيب', requiresReference: 'يتطلب رقم عملية', symbol: 'الرمز المختصر', genericName: 'الاسم العلمي', form: 'الشكل الدوائي', strength: 'التركيز', defaultDose: 'الجرعة الافتراضية', defaultFrequency: 'عدد المرات', defaultRoute: 'طريقة الاستخدام', nameAr: 'الاسم بالعربية', sampleType: 'نوع العينة', unit: 'الوحدة', referenceRange: 'المعدل الطبيعي', parameters: 'فحوصات فرعية (سطر لكل فحص: الاسم | الوحدة | المعدل)', service: 'المادة المرتبطة للفوترة', startTime: 'البداية', endTime: 'النهاية', type: 'النوع', active: 'فعال' },
    templates: { name: 'اسم النموذج', isDefault: 'النموذج الافتراضي', items: 'المواد', mandatory: 'إجبارية', addItem: 'إضافة مادة', hint: 'المواد الإجبارية تُضاف تلقائياً لكل فاتورة من هذا النموذج ولا يمكن حذفها. جميع النماذج تشترك في نفس الترقيم التسلسلي.', new: 'نموذج جديد' },
    roles: { new: 'دور جديد', key: 'المعرف (إنجليزي)', name: 'اسم الدور', description: 'الوصف', users: 'مستخدمين', system: 'أساسي', permissionsCount: '{{count}} صلاحية', selectAll: 'تحديد الكل' },
    modules: { dashboard: 'لوحة التحكم', users: 'المستخدمون', patients: 'المرضى', medical: 'الملف الطبي', queue: 'قائمة الانتظار', appointments: 'المواعيد', lab: 'المختبر', billing: 'الفواتير والمدفوعات', expenses: 'المصروفات', inventory: 'المخزون', staff: 'الدوام', reports: 'التقارير', settings: 'النظام' },
    add: 'إضافة', noEditPermission: 'لديك صلاحية عرض فقط',
  },
};
