export default {
  reports: {
    title: 'التقارير', subtitle: 'تقارير مبنية على البيانات الفعلية — قابلة للطباعة والتصدير', tabs: { patients: 'المرضى', doctors: 'الأطباء', financial: 'المالية', 'lab-costs': 'المختبر الخارجي', inventory: 'المخزون', attendance: 'الدوام' },
    pdfHint: 'لحفظ PDF اختر "حفظ كـ PDF" من نافذة الطباعة', visits: 'عدد الزيارات', uniquePatients: 'عدد المرضى', newPatients: 'مرضى جدد', returning: 'مرضى عائدون',
    registered: 'ملفات جديدة مسجلة', byDay: 'الزيارات حسب اليوم', byGender: 'حسب الجنس', byAge: 'حسب الفئة العمرية', byType: 'حسب نوع الزيارة', topDx: 'أكثر التشخيصات',
    isNew: 'جديد', truncated: 'تم عرض أول 5000 سجل فقط — ضيّق الفترة', patients: 'المرضى', completed: 'مكتملة', avgMinutes: 'متوسط مدة الكشف (د)', invoices: 'الفواتير',
    revenue: 'الإيرادات', collected: 'المحصل', outstanding: 'غير المدفوع', revenueByCategory: 'الإيرادات حسب نوع الخدمة', expensesByCategory: 'المصروفات حسب التصنيف',
    invoicesList: 'الفواتير في الفترة', discountsList: 'الخصومات الممنوحة', items: 'عدد الأصناف', stockValue: 'قيمة المخزون', low: 'منخفضة', expired: 'منتهية', expiring: 'قريبة الانتهاء',
    currentStock: 'المخزون الحالي', movementsSummary: 'ملخص الحركات في الفترة', stockCounts: 'جلسات الجرد والفروقات', count: 'العدد', scheduled: 'أيام مجدولة', present: 'حضور',
    lateTimes: 'مرات التأخير', lateMinutes: 'دقائق التأخير', earlyTimes: 'مغادرة مبكرة', earlyMinutes: 'دقائق المغادرة المبكرة', absent: 'غياب', leaveDays: 'أيام إجازة', workedHours: 'ساعات العمل',
    lab: {
      owed: 'المستحق للمختبر', revenue: 'إيراد التحاليل من المرضى', margin: 'الفرق', unpriced: 'تحاليل بدون سعر مختبر', unpricedHint: 'حدّد سعر المختبر لها من الإعدادات ← التحاليل',
      tests: 'التحاليل', orders: 'الطلبات', byTest: 'حسب التحليل', byOrder: 'طلبات الفترة (للمطابقة مع كشف المختبر)', order: 'رقم الطلب', test: 'التحليل', count: 'العدد',
      hint: 'المستحق للمختبر محسوب بسعر المختبر يوم طلب التحليل (الطلبات الملغاة غير محسوبة). الإيراد من الفواتير الصادرة في الفترة.',
    },
  },
};
