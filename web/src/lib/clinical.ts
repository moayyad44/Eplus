export interface Vitals {
  id: string; bpSystolic: number | null; bpDiastolic: number | null; heartRate: number | null; temperature: number | null; oxygenSaturation: number | null;
  respiratoryRate: number | null; weightKg: number | null; heightCm: number | null; bmi: number | null; bloodGlucose: number | null; painScore: number | null;
  notes: string | null; recordedAt: string;
}
export interface Diagnosis { id: string; icd10Code: string | null; description: string; type: string; notes: string | null }
export interface RxItem { id?: string; drugId?: string | null; drugName: string; dose: string | null; frequency: string | null; duration: string | null; route: string | null; instructions: string | null }
export interface Prescription { id: string; notes: string | null; createdAt: string; items: RxItem[] }
export interface LabResult { id: string; parameterName: string; value: string; unit: string | null; referenceRange: string | null; flag: string | null; notes: string | null }
export interface LabOrderItem { id: string; testName: string; notes: string | null; results: LabResult[]; labTest?: { code: string; unit: string | null; referenceRange: string | null; parameters: { name: string; unit?: string; referenceRange?: string }[] | null; sampleType: string | null; category: string | null } }
export interface LabOrder { id: string; orderNumber: string; status: string; priority: string; clinicalNotes: string | null; requestedAt: string; completedAt: string | null; items: LabOrderItem[] }
export interface Consultation { chiefComplaint: string | null; presentIllness: string | null; examination: string | null; clinicalNotes: string | null; treatmentPlan: string | null; followUpDate: string | null }
export interface NursingNote { id: string; procedure: string; notes: string | null; performedAt: string }
export interface MedicalReport { id: string; title: string; content?: string; createdAt: string }

export interface TimelineVisit {
  id: string; visitNumber: string; status: string; arrivedAt: string; completedAt: string | null; chiefComplaint: string | null;
  doctor: { id: string; fullName: string; specialty: string | null } | null; visitType: { name: string; color: string | null } | null;
  vitalSigns: Vitals[]; consultation: Consultation | null; diagnoses: Diagnosis[]; prescriptions: Prescription[]; labOrders: LabOrder[];
  medicalReports: MedicalReport[]; nursingNotes: NursingNote[]; attachments: { id: string; fileName: string; category: string }[];
}

export const bp = (v: Pick<Vitals, 'bpSystolic' | 'bpDiastolic'>) => (v.bpSystolic && v.bpDiastolic ? `${v.bpSystolic}/${v.bpDiastolic}` : '—');
