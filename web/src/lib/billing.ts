import type { PaymentMethod, Service } from './types';

export interface InvoiceItem {
  id: string; serviceId: string; description: string; category: string; quantity: number; unitPrice: number; discount: number; taxRate: number; taxAmount: number; lineTotal: number; isMandatory: boolean;
  insuranceShare: number; patientShare: number; coveragePercent: number | null; coverageNote: string | null; authorization: { id: string; requestNumber: string; approvalNumber: string | null } | null;
}
export interface Payment { id: string; receiptNumber: string; type: 'PAYMENT' | 'REFUND'; amount: number; method: { id: string; name: string; code: string }; reference: string | null; notes: string | null; paidAt: string; receivedById: string | null; voidedAt: string | null; voidReason: string | null; voidedById: string | null }
export interface Invoice {
  id: string; invoiceNumber: string | null; status: string; issuedAt: string | null; dueDate: string | null; createdAt: string; notes: string | null;
  subtotal: number; itemsDiscount: number; invoiceDiscount: number; discountTotal: number; taxTotal: number; total: number; paidAmount: number; refundedAmount: number; balance: number;
  cancelReason: string | null; cancelledAt: string | null; cancelledById: string | null; createdById: string | null;
  patient: { id: string; fullName: string; fileNumber: string; phone: string; address: string | null; age: number | null; gender: string };
  doctor: { id: string; fullName: string; specialty: string | null } | null; visit: { id: string; visitNumber: string; arrivedAt: string; status: string } | null;
  template: { id: string; name: string } | null; items: InvoiceItem[]; payments: Payment[]; userNames: Record<string, string>;
  payerType: 'SELF_PAY' | 'INSURANCE'; patientShare: number; insuranceShare: number; transferredFromInsurance: number;
  insuranceCompany: { id: string; nameAr: string; nameEn: string | null } | null; insuranceContract: { id: string; name: string } | null;
  patientInsurance: { id: string; memberId: string; cardNumber: string | null; policyNumber: string | null; priority: string; endDate: string | null; status: string } | null;
  claim: { id: string; claimNumber: string; status: string; insuranceAmount: number; approvedAmount: number; rejectedAmount: number; paidAmount: number; transferredAmount: number; writtenOffAmount: number; outstandingAmount: number } | null;
}
export interface InvoiceTemplate { id: string; name: string; description: string | null; isDefault: boolean; isActive: boolean; items: { id: string; serviceId: string; quantity: number; isMandatory: boolean; service: Service }[] }
export type { PaymentMethod };
