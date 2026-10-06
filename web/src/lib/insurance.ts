import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { ServiceCategory } from './types';

export type EffectiveStatus = 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'NOT_STARTED' | 'ARCHIVED';
export type PayerType = 'SELF_PAY' | 'INSURANCE' | 'CORPORATE' | 'GOVERNMENT' | 'OTHER';
export type ClaimStatus = 'DRAFT' | 'READY' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED' | 'RESUBMISSION_REQUIRED' | 'PAID' | 'PARTIALLY_PAID' | 'CLOSED' | 'CANCELLED';

export interface ContractLite { id: string; name: string; contractNumber: string | null; isActive: boolean; startDate: string | null; endDate: string | null; coveragePercent: number; annualLimit: number | null }
export interface Company {
  id: string; code: string; nameAr: string; nameEn: string | null; phone: string | null; email: string | null; address: string | null; contactPerson: string | null;
  contractNumber: string | null; contractStart: string | null; contractEnd: string | null; openingBalance: number; isActive: boolean; notes: string | null;
  contracts: ContractLite[]; _count?: { memberships: number; claims: number }; outstanding?: number;
}
export interface Rule {
  id?: string; serviceId: string | null; category: ServiceCategory | null; covered: boolean; coveragePercent: number | null; patientFixed: number | null;
  maxAmount: number | null; price: number | null; requiresApproval: boolean; requiresReport: boolean; notes: string | null;
  service?: { id: string; name: string; code: string; category: ServiceCategory; price: number } | null;
}
export interface Contract extends ContractLite { companyId: string; terms: string | null; coveredServices: string | null; excludedServices: string | null; notes: string | null; rules: Rule[]; _count?: { memberships: number } }

export interface Membership {
  id: string; patientId: string; companyId: string; contractId: string; priority: 'PRIMARY' | 'SECONDARY'; cardNumber: string | null; policyNumber: string | null; memberId: string;
  subscriberName: string | null; relation: string; startDate: string | null; endDate: string | null; status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
  network: string | null; notes: string | null; verifiedAt: string | null; verifiedByName: string | null;
  effectiveStatus: EffectiveStatus; daysToExpiry: number | null; coveragePercent: number; patientPercent: number;
  annualLimit: number | null; used: number; remaining: number | null; periodStart: string;
  company: { id: string; nameAr: string; nameEn: string | null; isActive: boolean };
  contract: { id: string; name: string; contractNumber: string | null; coveragePercent: number; annualLimit: number | null; coveredServices: string | null; excludedServices: string | null };
  lastClaim: { id: string; claimNumber: string; status: ClaimStatus; insuranceAmount: number; createdAt: string } | null;
  lastVisit: { id: string; visitNumber: string; arrivedAt: string } | null;
  attachments: { id: string; fileName: string; mimeType: string; description: string | null; createdAt: string }[];
  /** Stored overrides (null = contract default), for editing. */
  ownCoveragePercent: number | null; ownAnnualLimit: number | null;
}
export interface InsuranceSummary { patientId: string; payerType: PayerType; memberships: Membership[]; primary: Membership | null; active: Membership | null }

export interface Authorization {
  id: string; requestNumber: string; status: string; effectiveStatus: string; quantity: number; diagnosis: string | null; reason: string | null; approvalNumber: string | null;
  approvedQuantity: number | null; approvedAmount: number | null; validUntil: string | null; rejectReason: string | null; notes: string | null; requestedAt: string; decidedAt: string | null;
  patient: { id: string; fullName: string; phone: string; fileNumber: string }; company: { id: string; nameAr: string }; contract: { id: string; name: string };
  patientInsurance: { id: string; memberId: string; cardNumber: string | null }; service: { id: string; name: string; code: string; price: number };
  visit: { id: string; visitNumber: string } | null; _count: { invoiceItems: number };
}

export interface ClaimRow {
  id: string; claimNumber: string; status: ClaimStatus; memberId: string; createdAt: string; submittedAt: string | null; insuranceAmount: number; approvedAmount: number;
  rejectedAmount: number; paidAmount: number; outstandingAmount: number; pendingAmount: number; patientAmount: number; totalAmount: number;
  patient: { id: string; fullName: string; phone: string; fileNumber: string }; company: { id: string; nameAr: string }; contract: { id: string; name: string };
  invoice: { id: string; invoiceNumber: string | null; issuedAt: string | null };
}

/** Effective status of a membership → badge tone. Expiring within 30 days is a warning. */
export const statusTone = (m: Pick<Membership, 'effectiveStatus' | 'daysToExpiry'>) =>
  m.effectiveStatus === 'ACTIVE' ? (m.daysToExpiry != null && m.daysToExpiry <= 30 ? 'warning' : 'success') : m.effectiveStatus === 'NOT_STARTED' ? 'warning' : 'danger';

export function useInsuranceSummary(patientId: string | undefined | null) {
  const { canAny } = useAuth();
  return useQuery({
    queryKey: ['insurance', 'patient', patientId],
    queryFn: () => api.get<InsuranceSummary>(`/insurance/patients/${patientId}`),
    enabled: !!patientId && canAny('insurance.view', 'insurance.create', 'insurance.update'),
  });
}

export function useInsuranceCompanies(activeOnly = false) {
  return useQuery({ queryKey: ['insurance', 'companies', activeOnly], queryFn: () => api.get<Company[]>('/insurance/companies', activeOnly ? { active: 'true' } : {}), staleTime: 60_000 });
}
