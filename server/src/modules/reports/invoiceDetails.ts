import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { requirePerm } from '../../middleware/auth';
import { ageFrom, rangeFromQuery, ymd } from '../../lib/dates';
import { num } from '../../lib/money';
import { audit } from '../../lib/audit';
import { addSheet } from '../accounting/xlsx';

/**
 * Detailed invoice register: one row per invoice with the patient, visit, doctor, nurse, services, tests, materials,
 * payments, insurance, prescription, medical report, diagnoses and lab value. Screen (JSON) or Excel.
 */
export const invoiceDetailsRouter = Router();
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const LIMIT = 3000;
const GENDER: Record<string, string> = { MALE: 'ذكر', FEMALE: 'أنثى' };
const STATUS: Record<string, string> = { DRAFT: 'مسودة', ISSUED: 'صادرة', PARTIALLY_PAID: 'مدفوعة جزئياً', PAID: 'مدفوعة', OVERDUE: 'متأخرة', CANCELLED: 'ملغاة', REFUNDED: 'مرتجعة' };
const PAYER: Record<string, string> = { SELF_PAY: 'نقدي', INSURANCE: 'تأمين', CORPORATE: 'شركة' };

const query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  doctorId: z.string().uuid().optional(), companyId: z.string().uuid().optional(), payer: z.enum(['SELF_PAY', 'INSURANCE']).optional(),
  status: z.enum(['open', 'paid', 'cancelled']).optional(), q: z.string().trim().optional(), format: z.enum(['json', 'xlsx']).default('json'),
});

async function build(q: z.infer<typeof query>) {
  const { from, to } = rangeFromQuery(q.from, q.to);
  const where: Prisma.InvoiceWhereInput = {
    status: q.status === 'cancelled' ? 'CANCELLED' : q.status === 'paid' ? 'PAID' : q.status === 'open' ? { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } : { not: 'DRAFT' },
    issuedAt: { gte: from, lte: to },
    ...(q.doctorId && { doctorId: q.doctorId }), ...(q.companyId && { insuranceCompanyId: q.companyId }), ...(q.payer && { payerType: q.payer }),
    ...(q.q && { OR: [{ invoiceNumber: { contains: q.q, mode: 'insensitive' } }, { patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { patient: { phone: { contains: q.q } } }, { patient: { fileNumber: { contains: q.q } } }] }),
  };
  const inv = await prisma.invoice.findMany({
    where, orderBy: { issuedAt: 'asc' }, take: LIMIT,
    include: {
      patient: { select: { id: true, fullName: true, phone: true, fileNumber: true, gender: true, dateOfBirth: true, nationalId: true } },
      doctor: { select: { fullName: true } },
      items: { orderBy: { sortOrder: 'asc' }, include: { service: { select: { code: true, inventoryItemId: true } } } },
      payments: { where: { voidedAt: null }, orderBy: { paidAt: 'asc' }, include: { method: { select: { name: true } } } },
      insuranceCompany: { select: { nameAr: true } }, insuranceContract: { select: { name: true } },
      patientInsurance: { select: { memberId: true, cardNumber: true, policyNumber: true } },
      claim: { select: { claimNumber: true, status: true, approvedAmount: true, paidAmount: true } },
      einvoices: { select: { kind: true, status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      visit: {
        select: {
          visitNumber: true, arrivedAt: true, completedAt: true, chiefComplaint: true, visitType: { select: { name: true } },
          vitalSigns: { select: { recordedById: true, bpSystolic: true, bpDiastolic: true, heartRate: true, temperature: true, oxygenSaturation: true }, orderBy: { recordedAt: 'desc' } },
          nursingNotes: { select: { performedById: true, procedure: true } },
          statusLogs: { where: { toStatus: 'WITH_NURSE' }, select: { userId: true } },
          diagnoses: { where: { deletedAt: null }, select: { icd10Code: true, description: true, type: true } },
          prescriptions: { select: { items: { orderBy: { sortOrder: 'asc' }, select: { drugName: true, dose: true, frequency: true, duration: true, route: true } } } },
          medicalReports: { select: { title: true, content: true } },
          consultation: { select: { examination: true, treatmentPlan: true } },
          labOrders: { where: { status: { not: 'CANCELLED' } }, select: { orderNumber: true, items: { select: { testName: true, labCost: true, labTest: { select: { labCost: true } } } } } },
        },
      },
    },
  });
  // Nurses: whoever took vitals, did a nursing procedure or received the patient at the nurse station.
  const staffIds = new Set<string>();
  for (const i of inv) {
    for (const v of i.visit?.vitalSigns ?? []) if (v.recordedById) staffIds.add(v.recordedById);
    for (const n of i.visit?.nursingNotes ?? []) if (n.performedById) staffIds.add(n.performedById);
    for (const s of i.visit?.statusLogs ?? []) if (s.userId) staffIds.add(s.userId);
    for (const p of i.payments) if (p.receivedById) staffIds.add(p.receivedById);
    if (i.createdById) staffIds.add(i.createdById);
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...staffIds] } }, select: { id: true, fullName: true, staffType: true } });
  const user = (id: string | null | undefined) => users.find((u) => u.id === id);
  // Materials actually taken from stock for the invoice (sales minus reversals) with their cost.
  const moves = await prisma.inventoryTransaction.findMany({ where: { referenceType: 'invoice', referenceId: { in: inv.map((i) => i.id) }, type: { in: ['SALE', 'SALE_REVERSAL'] } }, select: { referenceId: true, type: true, quantity: true, unitCost: true, item: { select: { name: true } } } });

  return inv.map((i) => {
    const v = i.visit;
    const nurses = [...new Set([...(v?.vitalSigns ?? []).map((x) => x.recordedById), ...(v?.nursingNotes ?? []).map((x) => x.performedById), ...(v?.statusLogs ?? []).map((x) => x.userId)]
      .map((id) => user(id)).filter((u) => u?.staffType === 'NURSE').map((u) => u!.fullName))];
    const line = (it: (typeof i.items)[number]) => `${it.description}${num(it.quantity) !== 1 ? ` ×${num(it.quantity)}` : ''}`;
    const isMaterial = (it: (typeof i.items)[number]) => it.category === 'MEDICATION' || !!it.service.inventoryItemId;
    const procedures = i.items.filter((it) => ['PROCEDURE', 'NURSING'].includes(it.category) && !isMaterial(it));
    const services = i.items.filter((it) => ['EXAMINATION', 'CONSULTATION', 'OTHER'].includes(it.category) && !isMaterial(it));
    const labItems = i.items.filter((it) => it.category === 'LAB');
    const materials = i.items.filter(isMaterial);
    const myMoves = moves.filter((m) => m.referenceId === i.id);
    const materialsCost = r3(myMoves.reduce((t, m) => t + Math.abs(num(m.quantity)) * num(m.unitCost) * (m.type === 'SALE' ? 1 : -1), 0));
    const labTests = (v?.labOrders ?? []).flatMap((o) => o.items);
    const labCost = r3(labTests.reduce((t, x) => t + num(x.labCost ?? x.labTest.labCost), 0));
    const payments = i.payments.filter((p) => p.type === 'PAYMENT'), refunds = i.payments.filter((p) => p.type === 'REFUND');
    const vs = v?.vitalSigns[0];
    return {
      id: i.id, invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt, recordedAt: i.issuedRecordedAt, status: i.status, statusLabel: STATUS[i.status] ?? i.status,
      payer: i.payerType, payerLabel: PAYER[i.payerType] ?? i.payerType,
      patient: { id: i.patient.id, name: i.patient.fullName, phone: i.patient.phone, fileNumber: i.patient.fileNumber, gender: GENDER[i.patient.gender] ?? i.patient.gender, dateOfBirth: i.patient.dateOfBirth ? ymd(i.patient.dateOfBirth) : null, age: ageFrom(i.patient.dateOfBirth), nationalId: i.patient.nationalId },
      visitNumber: v?.visitNumber ?? null, visitType: v?.visitType?.name ?? null, arrivedAt: v?.arrivedAt ?? null, chiefComplaint: v?.chiefComplaint ?? null,
      doctor: i.doctor?.fullName ?? null, nurses, createdBy: user(i.createdById)?.fullName ?? null,
      services: services.map(line), procedures: procedures.map(line), labTests: labItems.map(line), orderedTests: labTests.map((x) => x.testName), materials: materials.map(line),
      materialsFromStock: myMoves.map((m) => `${m.item.name} ${m.type === 'SALE' ? '' : '(إرجاع) '}×${Math.abs(num(m.quantity))}`),
      items: i.items.map((it) => ({ description: it.description, category: it.category, quantity: num(it.quantity), unitPrice: num(it.unitPrice), discount: num(it.discount), total: num(it.lineTotal), insurance: num(it.insuranceShare), patient: num(it.patientShare) })),
      subtotal: num(i.subtotal), discount: num(i.discountTotal), tax: num(i.taxTotal), total: num(i.total), insuranceShare: num(i.insuranceShare), patientShare: num(i.patientShare),
      paid: num(i.paidAmount), refunded: num(i.refundedAmount), balance: num(i.balance),
      payments: payments.map((p) => ({ date: p.paidAt, method: p.method.name, amount: num(p.amount), reference: p.reference, receipt: p.receiptNumber, by: user(p.receivedById)?.fullName ?? null })),
      refunds: refunds.map((p) => ({ date: p.paidAt, method: p.method.name, amount: num(p.amount), reference: p.reference, notes: p.notes })),
      methods: [...new Set(payments.map((p) => p.method.name))], references: payments.map((p) => p.reference).filter(Boolean) as string[],
      insurance: i.insuranceCompany ? { company: i.insuranceCompany.nameAr, program: i.insuranceContract?.name ?? null, memberId: i.patientInsurance?.memberId ?? null, cardNumber: i.patientInsurance?.cardNumber ?? null, policyNumber: i.patientInsurance?.policyNumber ?? null } : null,
      claim: i.claim ? { number: i.claim.claimNumber, status: i.claim.status, approved: num(i.claim.approvedAmount), paid: num(i.claim.paidAmount) } : null,
      diagnoses: (v?.diagnoses ?? []).map((d) => `${d.icd10Code ? `${d.icd10Code} ` : ''}${d.description}`),
      prescription: (v?.prescriptions ?? []).flatMap((p) => p.items.map((x) => [x.drugName, x.dose, x.frequency, x.duration, x.route].filter(Boolean).join(' — '))),
      reports: (v?.medicalReports ?? []).map((r) => ({ title: r.title, content: r.content })),
      examination: v?.consultation?.examination ?? null, treatmentPlan: v?.consultation?.treatmentPlan ?? null,
      vitals: vs ? [vs.bpSystolic && vs.bpDiastolic ? `ضغط ${vs.bpSystolic}/${vs.bpDiastolic}` : null, vs.heartRate ? `نبض ${vs.heartRate}` : null, vs.temperature ? `حرارة ${num(vs.temperature)}` : null, vs.oxygenSaturation ? `أكسجين ${vs.oxygenSaturation}%` : null].filter(Boolean).join('، ') : null,
      labRevenue: r3(labItems.reduce((t, x) => t + num(x.lineTotal), 0)), labCost, materialsCost,
      einvoice: i.einvoices[0]?.status ?? null, notes: i.notes, cancelReason: i.cancelReason,
    };
  });
}

invoiceDetailsRouter.get('/invoice-details', requirePerm('reports.financial'), ah(async (req, res) => {
  const q = parse(query, req.query);
  const rows = await build(q);
  const sum = (k: 'total' | 'discount' | 'insuranceShare' | 'patientShare' | 'paid' | 'balance' | 'labRevenue' | 'labCost' | 'materialsCost') => r3(rows.filter((r) => r.status !== 'CANCELLED').reduce((t, r) => t + r[k], 0));
  const totals = { invoices: rows.length, cancelled: rows.filter((r) => r.status === 'CANCELLED').length, total: sum('total'), discount: sum('discount'), insuranceShare: sum('insuranceShare'), patientShare: sum('patientShare'), paid: sum('paid'), balance: sum('balance'), labRevenue: sum('labRevenue'), labCost: sum('labCost'), materialsCost: sum('materialsCost') };
  if (q.format === 'json') return res.json({ rows, totals, truncated: rows.length >= LIMIT });

  const dt = (d: Date | null) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Amman', hour12: false }).replace(',', '') : '');
  const j = (a: (string | null)[]) => a.filter(Boolean).join(' | ');
  const cols = [
    ['رقم الفاتورة', 'invoiceNumber'], ['التاريخ والوقت', 'date'], ['الحالة', 'statusLabel'], ['رقم الزيارة', 'visitNumber'], ['نوع الزيارة', 'visitType'],
    ['رقم الملف', 'file'], ['اسم المريض', 'name'], ['الهاتف', 'phone'], ['تاريخ الميلاد', 'dob'], ['العمر', 'age'], ['الجنس', 'gender'], ['الرقم الوطني', 'nid'],
    ['الطبيب', 'doctor'], ['الممرض', 'nurses'], ['الشكوى', 'chiefComplaint'], ['العلامات الحيوية', 'vitals'], ['التشخيص', 'diagnoses'],
    ['الخدمات (كشف/استشارة)', 'services'], ['الإجراءات', 'procedures'], ['الفحوصات المفوترة', 'labTests'], ['الفحوصات المطلوبة', 'orderedTests'], ['المواد', 'materials'], ['المواد المصروفة من المخزون', 'stock'],
    ['المبلغ قبل الخصم', 'subtotal', 1], ['الخصم', 'discount', 1], ['الضريبة', 'tax', 1], ['الإجمالي', 'total', 1], ['حصة التأمين', 'insuranceShare', 1], ['حصة المريض', 'patientShare', 1],
    ['المدفوع', 'paid', 1], ['المرتجع', 'refunded', 1], ['المتبقي', 'balance', 1], ['طريقة الدفع', 'methods'], ['رقم المرجع', 'references'], ['أرقام الإيصالات', 'receipts'], ['المستلم', 'cashiers'],
    ['الجهة الدافعة', 'payerLabel'], ['شركة التأمين', 'company'], ['برنامج التأمين', 'program'], ['رقم المنتفع', 'memberId'], ['رقم البطاقة', 'card'], ['رقم المطالبة', 'claim'], ['حالة المطالبة', 'claimStatus'],
    ['الروشيتة', 'prescription'], ['التقرير الطبي', 'report'], ['الفحص السريري', 'examination'], ['الخطة العلاجية', 'treatmentPlan'],
    ['قيمة المختبر (للمريض)', 'labRevenue', 1], ['كلفة المختبر الخارجي', 'labCost', 1], ['كلفة المواد', 'materialsCost', 1],
    ['الفوترة الوطنية', 'einvoice'], ['أنشأها', 'createdBy'], ['سبب الإلغاء', 'cancelReason'], ['ملاحظات', 'notes'],
  ] as const;
  const data = rows.map((r) => ({
    ...r, date: dt(r.issuedAt), file: r.patient.fileNumber, name: r.patient.name, phone: r.patient.phone, dob: r.patient.dateOfBirth, age: r.patient.age, gender: r.patient.gender, nid: r.patient.nationalId,
    nurses: j(r.nurses), diagnoses: j(r.diagnoses), services: j(r.services), procedures: j(r.procedures), labTests: j(r.labTests), orderedTests: j(r.orderedTests), materials: j(r.materials), stock: j(r.materialsFromStock),
    methods: j(r.methods), references: j(r.references), receipts: j(r.payments.map((p) => p.receipt)), cashiers: j([...new Set(r.payments.map((p) => p.by))]),
    company: r.insurance?.company, program: r.insurance?.program, memberId: r.insurance?.memberId, card: r.insurance?.cardNumber, claim: r.claim?.number, claimStatus: r.claim?.status,
    prescription: j(r.prescription), report: j(r.reports.map((x) => `${x.title}: ${x.content}`.slice(0, 2000))),
  }));
  const wb = new ExcelJS.Workbook();
  const ws = addSheet(wb, 'الفواتير المفصلة', cols.map(([header, key, m]) => ({ header, key, money: !!m, width: ['report', 'prescription', 'diagnoses', 'services', 'procedures', 'labTests', 'materials', 'stock', 'examination', 'treatmentPlan', 'orderedTests'].includes(key) ? 40 : undefined })), data as never, { title: `تقرير الفواتير المفصل ${q.from} → ${q.to}`, totals: cols.filter((c) => c[2]).map((c) => c[1]) });
  ws.eachRow((row, n) => { if (n > 2) row.alignment = { vertical: 'top', wrapText: true }; });
  await audit(prisma, req.ctx, { action: 'report.export', entityType: 'report', entityId: 'invoice-details', summary: `تصدير تقرير الفواتير المفصل ${q.from} → ${q.to} (${rows.length})` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-details-${q.from}-${q.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));
