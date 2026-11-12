export type EInvoiceStatus = 'PENDING' | 'SENDING' | 'SUBMITTED' | 'REJECTED' | 'FAILED' | 'UNKNOWN' | 'VOID';

export interface EInvoiceLine { lineId: number; itemId: string; name: string; quantity: string; unitPrice: string; discount: string; returned?: string; remaining?: string }

/** A national document of one invoice (GET /einvoice/invoices/:id). */
export interface EInvoiceDoc {
  id: string;
  kind: 'SALE' | 'RETURN';
  party: 'PATIENT' | 'COMPANY';
  docNumber: string;
  uuid: string;
  icv: number | null;
  typeName: '012' | '022';
  issueDate: string;
  total: number;
  status: EInvoiceStatus;
  attempts: number;
  lastAttemptAt: string | null;
  submittedAt: string | null;
  lastError: string | null;
  reason: string | null;
  originalId: string | null;
  qrSvg: string | null;
  lines: EInvoiceLine[];
}

export const RESENDABLE: EInvoiceStatus[] = ['PENDING', 'FAILED', 'REJECTED', 'UNKNOWN'];
