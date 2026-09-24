export default {
  expenses: {
    title: 'المصروفات', subtitle: 'تسجيل ومتابعة مصروفات العيادة', new: 'مصروف جديد', edit: 'تعديل المصروف', category: 'التصنيف', amount: 'المبلغ', date: 'التاريخ',
    method: 'طريقة الدفع', supplier: 'المورد', description: 'الوصف', reference: 'رقم الفاتورة / المرجع', attachment: 'المرفقات', void: 'إلغاء المصروف', voidReason: 'سبب الإلغاء',
    total: 'إجمالي الفترة', voided: 'ملغى', includeVoided: 'إظهار الملغاة', createdBy: 'سجله',
  },
  inventory: {
    title: 'الأصناف والمخزون', subtitle: 'إدارة الأصناف والكميات — الكمية تتغير فقط عبر حركات المخزون', newItem: 'صنف جديد', editItem: 'تعديل الصنف', name: 'اسم الصنف',
    sku: 'SKU', barcode: 'الباركود', category: 'التصنيف', unit: 'الوحدة', quantity: 'الكمية الحالية', minQuantity: 'الحد الأدنى', purchasePrice: 'سعر الشراء',
    salePrice: 'سعر البيع', supplier: 'المورد', expiryDate: 'تاريخ الانتهاء', batch: 'رقم التشغيلة', location: 'الموقع', openingQuantity: 'الكمية الافتتاحية',
    stockValue: 'قيمة المخزون', filters: { all: 'الكل', low: 'منخفض', out: 'نفد', expiring: 'قريب الانتهاء', expired: 'منتهي', inactive: 'غير فعال' },
    movement: 'حركة مخزون', newMovement: 'تسجيل حركة', movementType: 'نوع الحركة', movementQty: 'الكمية', adjustHint: 'للتعديل: رقم موجب للزيادة وسالب للنقص', unitCost: 'تكلفة الوحدة',
    reason: 'السبب', reference: 'المرجع', balanceAfter: 'الرصيد بعد', movements: 'حركات المخزون', movementsSubtitle: 'سجل كامل لكل تغيير في الكميات', lastMovements: 'آخر الحركات',
    low: 'منخفض', expired: 'منتهي', expiringSoon: 'قريب الانتهاء', archiveHint: 'لا يمكن أرشفة صنف له رصيد', qtyLocked: 'الكمية لا تُعدّل مباشرة — استخدم حركة مخزون',
    stockCounts: 'جلسات الجرد', stockCountsSubtitle: 'لا يتغير المخزون إلا بعد اعتماد الجرد', newCount: 'جلسة جرد جديدة', countTitle: 'عنوان الجلسة', allItems: 'كل الأصناف الفعالة',
    byCategory: 'حسب التصنيف', systemQty: 'كمية النظام', countedQty: 'الكمية الفعلية', difference: 'الفرق', diffValue: 'قيمة الفرق', approve: 'اعتماد الجرد', approveConfirm: 'اعتماد الجرد سيعدّل كميات المخزون حسب الفروقات. متابعة؟',
    approved: 'تم اعتماد الجرد — تعديل {{count}} صنف', saveCounts: 'حفظ الكميات', cancelCount: 'إلغاء الجلسة', itemsCount: 'عدد الأصناف', counted: 'تم عدّه', progress: 'التقدم',
  },
  suppliers: {
    title: 'الموردون', subtitle: 'بيانات الموردين والمشتريات والمبالغ المستحقة', new: 'مورد جديد', edit: 'تعديل المورد', name: 'اسم المورد', contactPerson: 'الشخص المسؤول',
    taxNumber: 'الرقم الضريبي', purchases: 'المشتريات المستلمة', paid: 'المدفوع', balance: 'المستحق للمورد', payments: 'دفعات المورد', addPayment: 'تسجيل دفعة للمورد',
    orders: 'أوامر الشراء', purchaseOrder: 'أمر شراء', newPO: 'أمر شراء جديد', poNumber: 'رقم الأمر', orderDate: 'تاريخ الطلب', markOrdered: 'تأكيد الطلب',
    receive: 'استلام البضاعة', receiveConfirm: 'سيتم إدخال الكميات إلى المخزون. متابعة؟', received: 'تم الاستلام وإدخال الكميات للمخزون', cancelPO: 'إلغاء الأمر', addLine: 'إضافة صنف',
    item: 'الصنف', qty: 'الكمية', cost: 'التكلفة', lineTotal: 'المجموع', purchasesTitle: 'أوامر الشراء', purchasesSubtitle: 'الطلب من الموردين واستلام البضاعة',
  },
};
