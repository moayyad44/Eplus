export default {
  ins: {
    title: 'التأمين الطبي',
    dashboard: 'لوحة التأمين', dashboardSub: 'المطالبات والمستحقات على شركات التأمين',
    companies: 'شركات التأمين', companiesSub: 'الشركات وعقودها وتغطياتها', company: 'شركة التأمين', newCompany: 'شركة جديدة',
    contracts: 'العقود والبرامج', contract: 'العقد / البرنامج', newContract: 'عقد / برنامج جديد',
    claims: 'المطالبات', claimsSub: 'مطالبة لكل فاتورة تأمين — من الإنشاء حتى الإغلاق', claim: 'المطالبة',
    authorizations: 'الموافقات المسبقة', authorizationsSub: 'طلبات الموافقة على الخدمات قبل تقديمها',
    payments: 'دفعات شركات التأمين', paymentsSub: 'المبالغ المستلمة من الشركات وتوزيعها على المطالبات', newPayment: 'تسجيل دفعة من شركة',
    reports: 'تقارير التأمين', receivables: 'مستحقات شركات التأمين', rejectedReport: 'المطالبات المرفوضة', account: 'كشف حساب الشركة',
    alerts: 'تنبيهات التأمين',

    // company / contract fields
    f: {
      nameAr: 'الاسم بالعربي', nameEn: 'الاسم بالإنجليزي', code: 'الرمز', phone: 'الهاتف', email: 'البريد الإلكتروني', address: 'العنوان', contactPerson: 'جهة الاتصال',
      contractNumber: 'رقم العقد', contractStart: 'بداية العقد', contractEnd: 'نهاية العقد', openingBalance: 'رصيد افتتاحي (مستحق قبل البرنامج)', notes: 'ملاحظات', isActive: 'فعالة',
      name: 'اسم العقد / البرنامج', startDate: 'تاريخ البداية', endDate: 'تاريخ النهاية', terms: 'شروط العقد', coveragePercent: 'نسبة التغطية الافتراضية %',
      annualLimit: 'الحد السنوي للتغطية للمستفيد', coveredServices: 'الخدمات المشمولة (وصف)', excludedServices: 'الخدمات غير المشمولة (وصف)',
      patientPercent: 'نسبة تحمل المريض', unlimited: 'بدون حد',
    },
    rules: {
      title: 'قواعد التغطية', hint: 'لكل خدمة أو تصنيف: هل هي مشمولة، كم تغطي الشركة، أو مبلغ ثابت يدفعه المريض، الحد الأعلى، السعر التعاقدي، والحاجة لموافقة مسبقة. الترتيب: قاعدة الخدمة ← قاعدة التصنيف ← إعدادات الخدمة ← النسبة الافتراضية للعقد.',
      target: 'الخدمة / التصنيف', addService: 'قاعدة لخدمة', addCategory: 'قاعدة لتصنيف', covered: 'مشمولة', coveragePercent: 'تغطية الشركة %',
      patientFixed: 'المريض يدفع مبلغاً ثابتاً', maxAmount: 'أعلى تغطية للوحدة', price: 'السعر التعاقدي', requiresApproval: 'موافقة مسبقة', requiresReport: 'تقرير / وصفة',
      none: 'لا توجد قواعد — تُطبَّق النسبة الافتراضية على كل الخدمات المشمولة', category: 'تصنيف', service: 'خدمة', notCovered: 'غير مشمولة',
    },

    // patient insurance
    patientTab: 'التأمين', summary: 'ملخص التأمين', noInsurance: 'لا يوجد تأمين مسجل — المريض يدفع نقداً', addInsurance: 'إضافة تأمين', editInsurance: 'تعديل التأمين',
    payerType: 'حالة الدفع للمريض', primary: 'أساسي', secondary: 'ثانوي', priority: 'الأولوية',
    m: {
      company: 'شركة التأمين', contract: 'البرنامج التأميني', cardNumber: 'رقم البطاقة', policyNumber: 'رقم الوثيقة', memberId: 'رقم العضوية', subscriberName: 'اسم المؤمن له',
      relation: 'صلة القرابة', startDate: 'بداية التأمين', endDate: 'انتهاء التأمين', status: 'حالة التأمين', coveragePercent: 'نسبة التغطية % (اتركها فارغة لنسبة العقد)',
      annualLimit: 'الحد السنوي (فارغ = حد العقد)', network: 'الشبكة التأمينية', notes: 'ملاحظات', used: 'المستخدم من الحد', remaining: 'المتبقي', coverage: 'التغطية',
      patientShare: 'تحمل المريض', lastClaim: 'آخر مطالبة', lastVisit: 'آخر زيارة تأمينية', verifiedAt: 'آخر تحقق', verify: 'تحقق من التأمين', verified: 'تم التحقق: التأمين ساري',
      notVerified: 'لم يتم التحقق بعد', documents: 'مستندات التأمين', uploadHint: 'صورة البطاقة، الوثيقة، أو أي مستند متعلق بالتأمين', archive: 'أرشفة التأمين',
      archiveConfirm: 'أرشفة هذا التأمين؟ لن يُستخدم في الزيارات الجديدة، وتبقى مطالباته السابقة كما هي.', policyYear: 'سنة التأمين من {{date}}',
    },
    relation: { SELF: 'المؤمن له نفسه', SPOUSE: 'زوج / زوجة', CHILD: 'ابن / ابنة', PARENT: 'أب / أم', OTHER: 'أخرى' },
    status: {
      ACTIVE: 'التأمين ساري', EXPIRED: 'التأمين منتهي', SUSPENDED: 'التأمين موقوف', NOT_STARTED: 'لم يبدأ بعد', ARCHIVED: 'مؤرشف', SELF_PAY: 'نقدي',
      expiresIn: 'ينتهي خلال {{days}} يوم', expiredOn: 'انتهى بتاريخ {{date}}', expiredWarn: 'التأمين منتهي الصلاحية — لا يمكن استخدامه حتى يحدّث المستخدم المخول بياناته.',
      suspendedWarn: 'التأمين موقوف — لا يمكن استخدامه.', soonWarn: 'تنبيه: ينتهي التأمين خلال {{days}} يوم.',
    },

    // payer on visit / invoice
    payer: { label: 'طريقة الدفع', selfPay: 'نقدي (على المريض)', insurance: 'تأمين', change: 'تغيير طريقة الدفع', changed: 'تم تغيير طريقة الدفع', none: 'لا يوجد تأمين ساري', member: 'عضوية' },

    // invoice
    inv: {
      split: 'توزيع الفاتورة', insuranceShare: 'حصة التأمين', patientShare: 'حصة المريض', coverage: 'التغطية', total: 'إجمالي الخدمات',
      patientPaid: 'المدفوع من المريض', patientBalance: 'المتبقي على المريض', transferred: 'محوّل على المريض من المرفوض', claimLink: 'مطالبة التأمين',
      override: 'تغطية بدون موافقة', overrideHint: 'اعتماد يدوي — يتطلب صلاحية', notCoveredNote: 'ليست تغطية: خصم التأمين منفصل عن الخصم',
      approvalNeeded: 'هذه الخدمة تحتاج إلى موافقة مسبقة من شركة التأمين.', requestApproval: 'طلب / تسجيل موافقة', receivable: 'مستحق على الشركة',
      limitLeft: 'المتبقي من الحد السنوي', calculating: 'جارِ حساب التغطية…', insurancePrice: 'سعر تعاقدي',
    },

    // authorizations
    a: {
      new: 'طلب موافقة مسبقة', requestNumber: 'رقم الطلب', service: 'الخدمة', quantity: 'الكمية', diagnosis: 'التشخيص', reason: 'سبب طلب الخدمة', visit: 'الزيارة',
      approvalNumber: 'رقم الموافقة من الشركة', approvedQuantity: 'الكمية المعتمدة', approvedAmount: 'أعلى مبلغ معتمد', validUntil: 'صالحة حتى', rejectReason: 'سبب الرفض',
      decide: 'تسجيل ردّ الشركة', submit: 'إرسال للشركة', cancel: 'إلغاء الطلب', requestedAt: 'تاريخ الطلب', recordNow: 'وصل ردّ الشركة (تسجيل الموافقة الآن)',
      membership: 'التأمين', used: 'مستخدمة في فاتورة',
    },

    // claims
    c: {
      number: 'رقم المطالبة', member: 'رقم العضوية', policy: 'رقم الوثيقة', invoice: 'الفاتورة', visit: 'الزيارة', diagnosis: 'التشخيص', services: 'الخدمات',
      total: 'إجمالي الفاتورة', insuranceAmount: 'مبلغ التأمين', patientAmount: 'حصة المريض', submitted: 'المرسل', approved: 'المعتمد', rejected: 'المرفوض',
      paid: 'المدفوع', outstanding: 'المستحق', pending: 'قيد المطالبة', transferred: 'محوّل للمريض', writtenOff: 'مشطوب', submittedAt: 'تاريخ الإرسال',
      lastPaymentAt: 'آخر دفعة', claimDate: 'تاريخ المطالبة', submissionCount: 'مرات التقديم', history: 'سجل المطالبة', documents: 'مستندات المطالبة',
      checks: 'جاهزية المطالبة', check: { diagnosis: 'التشخيص مسجل', report: 'تقرير طبي أو وصفة للخدمات التي تتطلبها' },
      ready: 'جاهزة للإرسال', submit: 'إرسال للشركة', submitSelected: 'إرسال المحدد ({{count}})', review: 'قيد المراجعة لدى الشركة', decision: 'تسجيل قرار الشركة',
      resubmissionRequired: 'تحتاج إعادة تقديم', resubmit: 'إعادة تقديم المرفوض', transfer: 'تحويل المرفوض على المريض', writeOff: 'شطب', close: 'إغلاق المطالبة',
      addNote: 'إضافة ملاحظة', approveAll: 'اعتماد الكل', rejectAll: 'رفض الكل', approvedCol: 'معتمد', rejectedCol: 'مرفوض', reasonCol: 'سبب الرفض',
      companyApproval: 'رقم اعتماد الشركة', companyNotes: 'ملاحظات شركة التأمين', amountOptional: 'المبلغ (فارغ = كامل المبلغ المتاح)',
      writeOffSource: 'ماذا تشطب؟', woRejected: 'المبلغ المرفوض', woApproved: 'معتمد لن تدفعه الشركة', closeHint: 'أي مبلغ مرفوض متبقٍ سيُشطب عند الإغلاق.',
      printForm: 'طباعة نموذج المطالبة', exportList: 'تصدير القائمة', protected: 'لا يمكن حذف المطالبات. تُلغى فقط مع إلغاء فاتورتها قبل اعتمادها أو دفعها.',
      openOnly: 'المستحقة فقط', byUser: 'بواسطة', item: 'البند', note: 'ملاحظة',
    },
    ev: {
      CREATED: 'إنشاء المطالبة', READY: 'جاهزة للإرسال', SUBMITTED: 'إرسال للشركة', UNDER_REVIEW: 'قيد المراجعة', DECISION: 'قرار الشركة', RESUBMISSION_REQUIRED: 'تحتاج إعادة تقديم',
      RESUBMITTED: 'إعادة تقديم', PAYMENT: 'دفعة من الشركة', TRANSFER_TO_PATIENT: 'تحويل على المريض', WRITE_OFF: 'شطب', CLOSED: 'إغلاق', CANCELLED: 'إلغاء', NOTE: 'ملاحظة',
      voided: 'ملغاة (دفعة ملغاة)',
    },

    // payments
    p: {
      receipt: 'رقم الإيصال', company: 'الشركة', amount: 'المبلغ', method: 'طريقة الدفع', reference: 'رقم المرجع', paidAt: 'تاريخ الدفع', allocations: 'التوزيع على المطالبات',
      allocate: 'المبلغ المدفوع', due: 'المستحق', payAll: 'توزيع تلقائي', totalAllocated: 'مجموع التوزيع', noOpen: 'لا توجد مطالبات مستحقة لهذه الشركة',
      void: 'إلغاء الدفعة', voided: 'ملغاة', claims: 'مطالبات', implicitHint: 'دفع مبلغ أكبر من المعتمد يعني أن الشركة اعتمدت الفرق.',
    },

    // dashboard & reports
    d: {
      insuredPatients: 'مرضى مؤمّن عليهم', insuredVisits: 'زيارات تأمين في الفترة', totalClaims: 'إجمالي المطالبات', pendingClaims: 'مطالبات معلقة',
      rejectedClaims: 'مطالبات مرفوضة', approvedClaims: 'معتمدة (غير مدفوعة كلياً)', paidClaims: 'مدفوعة / مغلقة', outstanding: 'المستحق على شركات التأمين',
      received: 'المحصّل من الشركات (الفترة)', billed: 'مطالبات الفترة', approved: 'المعتمد (الفترة)', rejected: 'المرفوض (الفترة)', rejectionRate: 'نسبة الرفض',
      avgDays: 'متوسط مدة التحصيل', days: '{{n}} يوم', byCompany: 'المستحقات حسب الشركة', byStatus: 'المطالبات حسب الحالة', expiringSoon: 'تأمينات تنتهي خلال 30 يوم',
      writtenOff: 'المشطوب (الفترة)', transferred: 'المحوّل على المرضى (الفترة)',
    },
    r: {
      ageDays: 'أيام التأخير', bucket: { current: 'حالية (أقل من 30)', d30: '30+ يوم', d60: '60+ يوم', d90: '90+ يوم', d120: '120+ يوم' },
      rejectedAt: 'تاريخ الرفض', resolution: 'إعادة التقديم', res: { OPEN: 'لم تُعالج', RESUBMITTED: 'أعيد تقديمها', TRANSFERRED: 'حُوّلت على المريض', WRITTEN_OFF: 'شُطبت' },
      opening: 'الرصيد الافتتاحي', claimsSubmitted: '+ مطالبات الفترة', approvedInfo: 'المعتمد (للعلم)', rejectedLine: '− المرفوض', resubmittedLine: '+ المعاد تقديمه',
      writtenOffLine: '− المشطوب من المعتمد', cancelledLine: '− الملغى مع الفواتير', paymentsLine: '− دفعات الشركة', closing: '= الرصيد المستحق',
      ledger: 'الحركات', effect: 'الأثر على الرصيد', transferredInfo: 'المحوّل على المرضى (من المرفوض)',
    },
  },
};
