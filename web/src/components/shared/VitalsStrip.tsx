import { useTranslation } from 'react-i18next';
import { bp, type Vitals } from '@/lib/clinical';

export function VitalsStrip({ v }: { v: Vitals }) {
  const { t } = useTranslation();
  const items: [string, string | number | null, string?][] = [
    [t('visit.vitals.bp'), bp(v), 'mmHg'], [t('visit.vitals.hr'), v.heartRate, 'bpm'], [t('visit.vitals.temp'), v.temperature, '°C'],
    [t('visit.vitals.spo2'), v.oxygenSaturation, '%'], [t('visit.vitals.rr'), v.respiratoryRate, '/min'], [t('visit.vitals.weight'), v.weightKg, 'kg'],
    [t('visit.vitals.height'), v.heightCm, 'cm'], [t('visit.vitals.bmi'), v.bmi], [t('visit.vitals.glucose'), v.bloodGlucose, 'mg/dL'], [t('visit.vitals.pain'), v.painScore, '/10'],
  ];
  const warn = (label: string, val: unknown) => {
    const n = Number(val);
    if (label === t('visit.vitals.temp')) return n >= 38;
    if (label === t('visit.vitals.spo2')) return n > 0 && n < 94;
    if (label === t('visit.vitals.hr')) return n > 110 || (n > 0 && n < 50);
    if (label === t('visit.vitals.bp')) return (v.bpSystolic ?? 0) >= 140 || (v.bpDiastolic ?? 0) >= 90;
    return false;
  };
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      {items.filter(([, val]) => val != null && val !== '—').map(([label, val, unit]) => (
        <div key={label} className={`rounded-xl px-2.5 py-2 ${warn(label, val) ? 'bg-danger-50 text-danger-700' : 'bg-surface-subtle'}`}>
          <p className="text-[10px] font-semibold text-ink-muted">{label}</p>
          <p className="text-sm font-bold tabular-nums" dir="ltr">{val} <span className="text-[10px] font-medium text-ink-muted">{unit}</span></p>
        </div>
      ))}
    </div>
  );
}
