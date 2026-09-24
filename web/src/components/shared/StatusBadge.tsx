import { useTranslation } from 'react-i18next';
import { Badge, type Tone } from '@/components/ui';

const TONES: Record<string, Record<string, Tone>> = {
  VisitStatus: { WAITING: 'warning', CALLED: 'violet', WITH_NURSE: 'info', WITH_DOCTOR: 'primary', IN_LAB: 'violet', WAITING_PAYMENT: 'warning', COMPLETED: 'success', CANCELLED: 'neutral', NO_SHOW: 'danger' },
  Priority: { NORMAL: 'neutral', URGENT: 'warning', EMERGENCY: 'danger' },
  InvoiceStatus: { DRAFT: 'neutral', ISSUED: 'info', PARTIALLY_PAID: 'warning', PAID: 'success', OVERDUE: 'danger', CANCELLED: 'neutral', REFUNDED: 'violet' },
  LabOrderStatus: { REQUESTED: 'warning', SAMPLE_COLLECTED: 'info', PROCESSING: 'violet', COMPLETED: 'success', CANCELLED: 'neutral' },
  AppointmentStatus: { SCHEDULED: 'info', CONFIRMED: 'primary', ARRIVED: 'success', COMPLETED: 'success', CANCELLED: 'neutral', NO_SHOW: 'danger' },
  StockCountStatus: { IN_PROGRESS: 'warning', APPROVED: 'success', CANCELLED: 'neutral' },
  PurchaseOrderStatus: { DRAFT: 'neutral', ORDERED: 'info', RECEIVED: 'success', CANCELLED: 'neutral' },
  LeaveStatus: { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' },
  AttendanceStatus: { PRESENT: 'success', LATE: 'warning', EARLY_LEAVE: 'warning', LATE_AND_EARLY: 'danger', ABSENT: 'danger', LEAVE: 'violet' },
  ResultFlag: { NORMAL: 'success', LOW: 'warning', HIGH: 'warning', ABNORMAL: 'danger', CRITICAL: 'danger' },
  AllergySeverity: { MILD: 'warning', MODERATE: 'warning', SEVERE: 'danger' },
  InventoryTxnType: { PURCHASE: 'success', RECEIPT: 'success', RETURN: 'success', SALE_REVERSAL: 'success', ISSUE: 'warning', CONSUMPTION: 'warning', SALE: 'info', ADJUSTMENT: 'violet', STOCK_COUNT: 'violet' },
};

export function StatusBadge({ enumName, value, dot = true }: { enumName: string; value: string | null | undefined; dot?: boolean }) {
  const { t } = useTranslation();
  if (!value) return null;
  return (
    <Badge tone={TONES[enumName]?.[value] ?? 'neutral'} dot={dot}>
      {t(`enum.${enumName}.${value}`)}
    </Badge>
  );
}
