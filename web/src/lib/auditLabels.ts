/** Arabic name of an audit action code such as "invoice.cancel" (unknown codes fall back to the code itself). */
const FULL: Record<string, string> = {
  'auth.login': 'تسجيل دخول', 'auth.login_failed': 'محاولة دخول فاشلة', 'auth.password_changed': 'تغيير كلمة المرور',
  'backup.download': 'تنزيل نسخة احتياطية', 'backup.request': 'طلب نسخة احتياطية', 'settings.logo': 'تغيير الشعار', 'settings.update': 'تعديل الإعدادات',
  'inventory.movement': 'حركة مخزون', 'invoice.issue': 'إصدار فاتورة', 'invoice.date_change': 'تغيير تاريخ فاتورة', 'payment.date_change': 'تغيير تاريخ دفعة',
  'einvoice.resend': 'إعادة إرسال للفوترة الوطنية', 'einvoice.return': 'فاتورة إرجاع (الفوترة الوطنية)', 'einvoice.settings': 'إعدادات الفوترة الوطنية',
  'ecoin.adjust': 'تعديل رصيد E Coin', 'ecoin.reverse': 'إلغاء عملية E Coin', 'lab_test.import': 'استيراد تحاليل', 'leave.decision': 'قرار إجازة',
  'insurance.patient.payer_type': 'تغيير جهة الدفع', 'insurance.membership.verify': 'تحقق من تأمين', 'insurance.authorization.decide': 'رد على موافقة مسبقة',
  'insurance.authorization.submit': 'إرسال موافقة مسبقة', 'insurance.claim.note': 'ملاحظة على مطالبة', 'role.permissions_change': 'تغيير صلاحيات دور',
  'user.permissions_change': 'تغيير صلاحيات مستخدم', 'user.password_reset': 'إعادة تعيين كلمة المرور', 'user.role_change': 'تغيير دور مستخدم',
  'schedule.bulk_create': 'توزيع شفتات', 'shift.cover': 'رد على طلب تغطية', 'shift.cover_request': 'طلب تغطية جزئية', 'shift.handover': 'تسجيل تأخير/تمديد',
  'shift.purchase': 'شراء شفت', 'shift.reassign': 'إعادة توزيع شفت', 'shift.release': 'تنازل عن شفت', 'shift.secure': 'تأمين شفت', 'shift.swap': 'رد على طلب تبديل',
  'shift.swap_request': 'طلب تبديل شفت', 'visit.create_direct': 'زيارة مباشرة', 'visit.payer': 'تغيير جهة الدفع للزيارة', 'visit.reorder': 'إعادة ترتيب الانتظار',
  'stock_transfer.create': 'نقل بضاعة بين المستودعات', 'appointment.reschedule': 'تغيير موعد',
};
const VERB: Record<string, string> = {
  create: 'إضافة', update: 'تعديل', delete: 'حذف', remove: 'حذف', archive: 'أرشفة', void: 'إلغاء', cancel: 'إلغاء', status: 'تغيير حالة',
  approve: 'اعتماد', deactivate: 'إيقاف', upload: 'رفع', submit: 'إرسال',
};
const ENTITY: Record<string, string> = {
  appointment: 'موعد', attachment: 'مرفق', diagnosis: 'تشخيص', expense: 'مصروف', invoice: 'فاتورة', invoice_template: 'نموذج فاتورة', payment: 'دفعة',
  patient: 'مريض', visit: 'زيارة', vitals: 'علامات حيوية', consultation: 'كشف طبي', prescription: 'وصفة', medical_report: 'تقرير طبي', nursing_note: 'ملاحظة تمريضية',
  lab_order: 'طلب تحاليل', leave: 'إجازة', attendance: 'حضور', schedule: 'شفت', role: 'دور', user: 'مستخدم', supplier: 'مورد', supplier_payment: 'دفعة مورد',
  purchase_order: 'أمر شراء', stock_count: 'جرد', inventory_item: 'صنف', warehouse: 'مستودع', 'insurance.authorization': 'موافقة مسبقة', 'insurance.claim': 'مطالبة',
  'insurance.company': 'شركة تأمين', 'insurance.contract': 'عقد تأمين', 'insurance.membership': 'تأمين مريض', 'insurance.payment': 'دفعة شركة تأمين',
  'ecoin.price_rule': 'سعر شفت خاص', visit_type: 'نوع زيارة', expense_category: 'تصنيف مصروف', inventory_category: 'تصنيف مخزون', unit: 'وحدة', drug: 'دواء',
  diagnosis_code: 'رمز تشخيص', payment_method: 'طريقة دفع', service: 'خدمة', lab_test: 'تحليل', shift: 'شفت',
};
export function auditActionLabel(action: string) {
  if (FULL[action]) return FULL[action];
  const i = action.lastIndexOf('.');
  const entity = ENTITY[action.slice(0, i)], verb = VERB[action.slice(i + 1)];
  return entity && verb ? `${verb} ${entity}` : action;
}
