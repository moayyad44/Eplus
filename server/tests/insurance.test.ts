import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { login, type Client } from './helpers';

let admin: Client, reception: Client, doctor: Client;
let companyId: string, contractId: string, membershipId: string, patientId: string, visitId: string;
let svc: Record<'exam' | 'proc' | 'lab' | 'cosm', { id: string; price: number }>;
let cashId: string, bankId: string, templateId: string;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const n = (v: unknown) => Number(v);

beforeAll(async () => {
  [admin, reception, doctor] = await Promise.all([login('admin'), login('reception'), login('dr.ahmad')]);
  const mk = async (code: string, name: string, category: string, price: number, extra: object = {}) => {
    const r = await admin.post('/api/settings/services', { code, name, category, price, ...extra });
    expect(r.status).toBe(201);
    return { id: r.body.id as string, price };
  };
  svc = {
    exam: await mk('INS-EXAM', 'كشف تأمين', 'EXAMINATION', 20),
    proc: await mk('INS-PROC', 'إجراء تأمين', 'PROCEDURE', 50),
    lab: await mk('INS-LAB', 'تحليل يحتاج موافقة', 'LAB', 30, { insRequiresApproval: true }),
    cosm: await mk('INS-COS', 'خدمة تجميلية', 'OTHER', 40),
  };
  cashId = (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CASH' } })).id;
  bankId = (await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CLIQ' } })).id;
  // Template without the mandatory consultation fee, so the numbers below are only the test services.
  templateId = (await prisma.invoiceTemplate.findFirstOrThrow({ where: { isDefault: false, items: { none: {} } } })).id;
});

describe('insurance setup', () => {
  it('admin manages companies and contracts; reception and doctors cannot', async () => {
    const body = { nameAr: 'شركة الاختبار للتأمين', nameEn: 'Test Insurance', phone: '065000000', contractNumber: 'C-1' };
    expect((await reception.post('/api/insurance/companies', body)).status).toBe(403);
    const c = await admin.post('/api/insurance/companies', body);
    expect(c.status).toBe(201);
    companyId = c.body.id;

    const contract = {
      name: 'البرنامج الذهبي', coveragePercent: 80, annualLimit: 1000, startDate: day(-30), endDate: day(365),
      rules: [
        { category: 'EXAMINATION', covered: true, patientFixed: 2 }, // patient pays 2 JD per consultation
        { category: 'PROCEDURE', covered: true, coveragePercent: 90 }, // patient pays 10 %
        { serviceId: svc.cosm.id, covered: false }, // not covered at all
      ],
    };
    expect((await reception.post(`/api/insurance/companies/${companyId}/contracts`, contract)).status).toBe(403);
    expect((await admin.post(`/api/insurance/companies/${companyId}/contracts`, { ...contract, rules: [...contract.rules, { category: 'PROCEDURE', covered: true }] })).status).toBe(400); // duplicate rule
    const k = await admin.post(`/api/insurance/companies/${companyId}/contracts`, contract);
    expect(k.status).toBe(201);
    contractId = k.body.id;
    expect(k.body.rules).toHaveLength(3);
  });

  it('reception adds a primary insurance to a patient and sees it as active', async () => {
    const p = await reception.post('/api/patients', { fullName: 'منى المؤمَّنة', phone: '0791234500', gender: 'FEMALE' });
    patientId = p.body.id;
    const m = await reception.post(`/api/insurance/patients/${patientId}/memberships`, { contractId, memberId: 'M-777', cardNumber: 'CARD-1', policyNumber: 'POL-9', startDate: day(-10), endDate: day(200) });
    expect(m.status).toBe(201);
    expect(m.body.payerType).toBe('INSURANCE');
    const mem = m.body.memberships[0];
    membershipId = mem.id;
    expect(mem.priority).toBe('PRIMARY');
    expect(mem.effectiveStatus).toBe('ACTIVE');
    expect(mem.coveragePercent).toBe(80);
    expect(mem.patientPercent).toBe(20);
    expect(n(mem.annualLimit)).toBe(1000);

    const v = await reception.post(`/api/insurance/memberships/${membershipId}/verify`, {});
    expect(v.body.valid).toBe(true);
    expect(v.body.summary.memberships[0].verifiedAt).toBeTruthy();
  });

  it('a visit opened for an insured patient records the insurance', async () => {
    const v = await reception.post('/api/visits', { patientId });
    expect(v.status).toBe(201);
    expect(v.body.payerType).toBe('INSURANCE');
    expect(v.body.patientInsuranceId).toBe(membershipId);
    expect(v.body.insuranceMemberId).toBe('M-777');
    visitId = v.body.id;
  });
});

describe('insurance invoice split', () => {
  const items = () => [svc.exam, svc.proc, svc.lab, svc.cosm].map((s) => ({ serviceId: s.id, quantity: 1 }));
  let invoiceId: string, claimId: string;

  it('splits each line by the contract rules; a service needing approval is not covered without one', async () => {
    const p = await reception.post('/api/billing/invoices/preview', { patientId, visitId, templateId, items: items() });
    expect(p.status).toBe(200);
    const line = (id: string) => p.body.items.find((i: { serviceId: string }) => i.serviceId === id);
    expect(n(line(svc.exam.id).insuranceShare)).toBe(18); // 20 − 2 fixed
    expect(n(line(svc.exam.id).patientShare)).toBe(2);
    expect(n(line(svc.proc.id).insuranceShare)).toBe(45); // 90 %
    expect(n(line(svc.lab.id).insuranceShare)).toBe(0); // needs approval
    expect(line(svc.lab.id).coverageNote).toContain('موافقة');
    expect(n(line(svc.cosm.id).insuranceShare)).toBe(0); // excluded
    expect(p.body.warnings.join(' ')).toContain('موافقة مسبقة');
    expect(n(p.body.discountTotal)).toBe(0); // coverage is not a discount
    expect(n(p.body.total)).toBe(140);
    expect(n(p.body.insuranceShare)).toBe(63);
    expect(n(p.body.patientShare)).toBe(77);
  });

  it('only authorized users can cover a line without approval', async () => {
    const body = { patientId, visitId, templateId, items: items().map((i) => (i.serviceId === svc.lab.id ? { ...i, overrideApproval: true } : i)) };
    expect((await reception.post('/api/billing/invoices/preview', body)).status).toBe(400);
    const p = await admin.post('/api/billing/invoices/preview', body);
    expect(n(p.body.items.find((i: { serviceId: string }) => i.serviceId === svc.lab.id).insuranceShare)).toBe(24);
  });

  it('a recorded approval (with an approved amount) makes the service covered', async () => {
    const a = await reception.post('/api/insurance/authorizations', {
      patientInsuranceId: membershipId, visitId, serviceId: svc.lab.id, reason: 'اشتباه التهاب',
      decision: { status: 'APPROVED', approvalNumber: 'APR-55', approvedAmount: 22, validUntil: day(5) },
    });
    expect(a.status).toBe(201);
    expect(a.body.status).toBe('APPROVED');
    expect(a.body.requestNumber).toMatch(/^PA-/);
    const p = await reception.post('/api/billing/invoices/preview', { patientId, visitId, templateId, items: items() });
    const lab = p.body.items.find((i: { serviceId: string }) => i.serviceId === svc.lab.id);
    expect(n(lab.insuranceShare)).toBe(22); // capped by the approved amount (80 % would be 24)
    expect(lab.authorizationId).toBe(a.body.id);
  });

  it('issuing creates the claim: patient owes only their share, the rest is an insurance receivable', async () => {
    const r = await reception.post('/api/billing/invoices', { patientId, visitId, templateId, items: items() });
    expect(r.status).toBe(201);
    invoiceId = r.body.id;
    expect(r.body.payerType).toBe('INSURANCE');
    expect(n(r.body.insuranceShare)).toBe(85); // 18 + 45 + 22
    expect(n(r.body.patientShare)).toBe(55);
    expect(n(r.body.balance)).toBe(55);
    expect(r.body.claim.claimNumber).toMatch(/^CLM-/);
    expect(r.body.claim.status).toBe('DRAFT');
    expect(n(r.body.claim.outstandingAmount)).toBe(85);
    claimId = r.body.claim.id;

    // The patient pays their share → invoice PAID for the patient, receivable stays with the company.
    const pay = await reception.post(`/api/billing/invoices/${invoiceId}/payments`, { amount: 55, methodId: cashId, paidAt: `${day(-1)}T10:00:00` });
    expect(pay.status).toBe(201);
    expect(pay.body.invoice.status).toBe('PAID');
    const claim = await admin.get(`/api/insurance/claims/${claimId}`);
    expect(n(claim.body.outstandingAmount)).toBe(85);
    expect(claim.body.items).toHaveLength(3);
  });

  it('claim life cycle: submit → partial approval → partial payment → resubmit → paid → closed', async () => {
    expect((await doctor.post(`/api/insurance/claims/${claimId}/submit`, {})).status).toBe(403);
    expect((await admin.post(`/api/insurance/claims/${claimId}/submit`, {})).body.status).toBe('SUBMITTED');

    const claim = (await admin.get(`/api/insurance/claims/${claimId}`)).body;
    const item = (sid: string) => claim.items.find((i: { serviceId: string }) => i.serviceId === sid);
    // Company approves exam + procedure, rejects the lab test.
    const noReason = await admin.post(`/api/insurance/claims/${claimId}/decision`, { items: [{ claimItemId: item(svc.lab.id).id, approved: 0, rejected: 22 }] });
    expect(noReason.status).toBe(400);
    const d = await admin.post(`/api/insurance/claims/${claimId}/decision`, {
      approvalNumber: 'BATCH-1',
      items: [
        { claimItemId: item(svc.exam.id).id, approved: 18, rejected: 0 },
        { claimItemId: item(svc.proc.id).id, approved: 45, rejected: 0 },
        { claimItemId: item(svc.lab.id).id, approved: 0, rejected: 22, reason: 'التحليل غير مبرر طبياً' },
      ],
    });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('PARTIALLY_APPROVED');
    expect(n(d.body.approvedAmount)).toBe(63);
    expect(n(d.body.rejectedAmount)).toBe(22);
    expect(n(d.body.outstandingAmount)).toBe(63);

    // Company pays 40 of 63.
    const p1 = await admin.post('/api/insurance/payments', { companyId, methodId: bankId, reference: 'TRX-1', allocations: [{ claimId, amount: 40 }] });
    expect(p1.status).toBe(201);
    let c = (await admin.get(`/api/insurance/claims/${claimId}`)).body;
    expect(c.status).toBe('PARTIALLY_PAID');
    expect(n(c.outstandingAmount)).toBe(23);

    // Resubmit the rejected 22 with a report; history is kept.
    const rs = await admin.post(`/api/insurance/claims/${claimId}/resubmit`, { notes: 'مرفق تقرير طبي' });
    expect(rs.status).toBe(200);
    expect(n(rs.body.rejectedAmount)).toBe(0);
    expect(n(rs.body.pendingAmount)).toBe(22);
    expect(rs.body.submissionCount).toBe(2);

    // Company pays everything left (23 approved + 22 resubmitted: paying it approves it).
    const p2 = await admin.post('/api/insurance/payments', { companyId, methodId: bankId, reference: 'TRX-2', allocations: [{ claimId, amount: 45 }] });
    expect(p2.status).toBe(201);
    c = (await admin.get(`/api/insurance/claims/${claimId}`)).body;
    expect(c.status).toBe('CLOSED');
    expect(n(c.paidAmount)).toBe(85);
    expect(n(c.outstandingAmount)).toBe(0);
    const types = c.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['CREATED', 'SUBMITTED', 'DECISION', 'PAYMENT', 'RESUBMITTED']));

    // Voiding the second payment re-opens the receivable.
    expect((await admin.post(`/api/insurance/payments/${p2.body.id}/void`, { reason: 'تحويل خاطئ' })).status).toBe(200);
    c = (await admin.get(`/api/insurance/claims/${claimId}`)).body;
    expect(n(c.outstandingAmount)).toBe(45);
    expect(c.status).toBe('PARTIALLY_PAID');
    await admin.post('/api/insurance/payments', { companyId, methodId: bankId, reference: 'TRX-3', allocations: [{ claimId, amount: 45 }] });
    expect((await admin.get(`/api/insurance/claims/${claimId}`)).body.status).toBe('CLOSED');
  });

  it('a settled claim protects its invoice; claim history cannot be edited or deleted', async () => {
    const r = await admin.post(`/api/billing/invoices/${invoiceId}/refunds`, { amount: 55, methodId: cashId, notes: 'اختبار الإلغاء', paidAt: `${day(-1)}T11:00:00` });
    expect(r.status).toBe(201);
    const cancel = await admin.post(`/api/billing/invoices/${invoiceId}/cancel`, { reason: 'اختبار' });
    expect(cancel.status).toBe(409);
    const ev = await prisma.insuranceClaimEvent.findFirstOrThrow({ where: { claimId } });
    await expect(prisma.insuranceClaimEvent.update({ where: { id: ev.id }, data: { dPaid: 999 } })).rejects.toThrow();
    await expect(prisma.insuranceClaimEvent.delete({ where: { id: ev.id } })).rejects.toThrow();
  });
});

describe('rejections, transfers, limits and expiry', () => {
  let claimId: string, invoiceId: string;

  it('a rejected amount can be billed back to the patient (patient balance rises, receivable falls)', async () => {
    const v = await reception.post('/api/visits', { patientId, allowDuplicate: true });
    const inv = await reception.post('/api/billing/invoices', { patientId, visitId: v.body.id, templateId, items: [{ serviceId: svc.proc.id, quantity: 1 }] });
    invoiceId = inv.body.id;
    claimId = inv.body.claim.id;
    expect(n(inv.body.balance)).toBe(5);
    await admin.post(`/api/insurance/claims/${claimId}/submit`, {});
    const c = (await admin.get(`/api/insurance/claims/${claimId}`)).body;
    await admin.post(`/api/insurance/claims/${claimId}/decision`, { items: [{ claimItemId: c.items[0].id, approved: 0, rejected: 45, reason: 'خارج الشبكة' }] });
    expect((await admin.get(`/api/insurance/claims/${claimId}`)).body.status).toBe('REJECTED');
    const t = await admin.post(`/api/insurance/claims/${claimId}/transfer`, { reason: 'المريض يتحمل المرفوض' });
    expect(t.status).toBe(200);
    expect(t.body.status).toBe('CLOSED');
    expect(n(t.body.outstandingAmount)).toBe(0);
    const i = (await admin.get(`/api/billing/invoices/${invoiceId}`)).body;
    expect(n(i.transferredFromInsurance)).toBe(45);
    expect(n(i.balance)).toBe(50);
  });

  it('rejected report and company account statement add up', async () => {
    const rej = await admin.get('/api/insurance/reports/rejected');
    expect(rej.status).toBe(200);
    expect(rej.body.rows.some((r: { reason: string; resolution: string }) => r.reason.includes('خارج الشبكة') && r.resolution === 'TRANSFERRED')).toBe(true);

    const acc = await admin.get(`/api/insurance/reports/companies/${companyId}/account`);
    expect(acc.status).toBe(200);
    const outstanding = await prisma.insuranceClaim.aggregate({ where: { companyId, status: { not: 'CANCELLED' } }, _sum: { outstandingAmount: true } });
    expect(acc.body.closingBalance).toBe(Number(outstanding._sum.outstandingAmount ?? 0));
    expect(acc.body.payments).toBe(85); // 40 + 45; the voided 45 is excluded

    const dash = await admin.get('/api/insurance/reports/dashboard');
    expect(dash.body.insuredPatients).toBeGreaterThanOrEqual(1);
    expect(dash.body.totals.received).toBe(85);
    expect((await reception.get('/api/insurance/reports/dashboard')).status).toBe(403);

    const fin = await admin.get(`/api/reports/financial?from=${day(-1)}&to=${day(0)}`);
    expect(fin.status).toBe(200);
    expect(fin.body.summary.insuranceReceived).toBe(85);
    expect(fin.body.summary.cashCollected).toBe(fin.body.summary.netReceipts + 85);
    expect(fin.body.summary.insuranceReceivables).toBeGreaterThanOrEqual(0);
  });

  it('the yearly limit caps the company share; the excess goes to the patient', async () => {
    await admin.put(`/api/insurance/memberships/${membershipId}`, { contractId, memberId: 'M-777', startDate: day(-10), endDate: day(200), annualLimit: 140 });
    const p = await reception.post('/api/billing/invoices/preview', { patientId, templateId, payerType: 'INSURANCE', patientInsuranceId: membershipId, items: [{ serviceId: svc.proc.id, quantity: 2 }] });
    // used so far this policy year: 85 (first claim) + 0 (second, transferred) → 55 left of 140
    expect(n(p.body.insuranceShare)).toBe(55);
    expect(n(p.body.patientShare)).toBe(45);
    expect(p.body.warnings.join(' ')).toContain('الحد السنوي');
  });

  it('an expired insurance cannot be billed and is reported as expired', async () => {
    await admin.put(`/api/insurance/memberships/${membershipId}`, { contractId, memberId: 'M-777', startDate: day(-100), endDate: day(-1) });
    const s = await reception.get(`/api/insurance/patients/${patientId}`);
    expect(s.body.memberships[0].effectiveStatus).toBe('EXPIRED');
    const p = await reception.post('/api/billing/invoices/preview', { patientId, templateId, payerType: 'INSURANCE', patientInsuranceId: membershipId, items: [{ serviceId: svc.proc.id, quantity: 1 }] });
    expect(p.status).toBe(400);
    expect(p.body.error.message).toContain('منتهي');
    const v = await reception.post('/api/visits', { patientId, allowDuplicate: true });
    expect(v.body.payerType).toBe('SELF_PAY'); // no valid insurance → cash
    expect((await reception.post('/api/visits', { patientId, allowDuplicate: true, payerType: 'INSURANCE' })).status).toBe(400);
  });

  it('every insurance action is in the audit log', async () => {
    const actions = (await prisma.auditLog.findMany({ where: { action: { startsWith: 'insurance.' } }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([
      'insurance.company.create', 'insurance.contract.create', 'insurance.membership.create', 'insurance.membership.update', 'insurance.membership.verify',
      'insurance.authorization.create', 'insurance.claim.create', 'insurance.claim.submit', 'insurance.claim.decision', 'insurance.claim.resubmit',
      'insurance.claim.transfer', 'insurance.payment.create', 'insurance.payment.void',
    ]));
  });
});
