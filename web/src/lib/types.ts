export type StaffType = 'ADMIN' | 'DOCTOR' | 'NURSE' | 'RECEPTIONIST' | 'LAB_TECHNICIAN' | 'ACCOUNTANT' | 'OTHER';
export type VisitStatus = 'WAITING' | 'CALLED' | 'WITH_NURSE' | 'WITH_DOCTOR' | 'IN_LAB' | 'WAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export type Priority = 'NORMAL' | 'URGENT' | 'EMERGENCY';
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'REFUNDED';
export type LabOrderStatus = 'REQUESTED' | 'SAMPLE_COLLECTED' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED';
export type AppointmentStatus = 'SCHEDULED' | 'CONFIRMED' | 'ARRIVED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export type Gender = 'MALE' | 'FEMALE';
export type ServiceCategory = 'EXAMINATION' | 'CONSULTATION' | 'PROCEDURE' | 'LAB' | 'NURSING' | 'MEDICATION' | 'OTHER';

export interface Me {
  user: {
    id: string; username: string; fullName: string; phone: string | null; email: string | null; staffType: StaffType; specialty: string | null;
    role: { id: string; key: string; name: string }; mustChangePassword: boolean; lastLoginAt: string | null;
  };
  permissions: string[];
  clinic: { name: string; nameEn: string; logoKey: string | null; phone: string; address: string };
  currency: { code: string; symbol: string; decimals: number };
}

export interface PatientLite {
  id: string; fileNumber: string; fullName: string; phone: string; altPhone?: string | null; gender: Gender; dateOfBirth: string | null;
  nationalId?: string | null; lastVisitAt?: string | null; visitCount?: number; age: number | null; createdAt?: string;
}

export interface Patient extends PatientLite {
  nationality: string | null; address: string | null; bloodType: string | null; emergencyContactName: string | null; emergencyContactPhone: string | null;
  emergencyContactRelation: string | null; notes: string | null; familyHistory?: string | null; firstVisitAt: string | null;
  allergies?: { id: string; allergen: string; reaction: string | null; severity: 'MILD' | 'MODERATE' | 'SEVERE'; notes: string | null }[];
  histories?: { id: string; type: 'CHRONIC' | 'PAST_ILLNESS' | 'SURGERY' | 'FAMILY' | 'OTHER'; name: string; icd10Code: string | null; since: string | null; notes: string | null; isActive: boolean }[];
  medications?: { id: string; name: string; dose: string | null; frequency: string | null; notes: string | null; isActive: boolean }[];
  outstandingBalance: number | null;
  nextAppointment: { id: string; startAt: string; doctor: { fullName: string } } | null;
  canViewMedical: boolean;
}

export interface Service { id: string; code: string; name: string; category: ServiceCategory; price: number; taxRate: number; allowPriceEdit: boolean; isActive: boolean; inventoryItemId: string | null }
export interface PaymentMethod { id: string; code: string; name: string; requiresReference: boolean; isActive: boolean; sortOrder: number }
export interface UserLite { id: string; fullName: string; staffType: StaffType; specialty: string | null }
export interface NamedItem { id: string; name: string; isActive: boolean }
