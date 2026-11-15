import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { Button, Card, CardHeader, Field, Input, PageLoader, Select, Switch, Textarea } from '@/components/ui';

type Effect = 'PAID' | 'HALF' | 'UNPAID';
export interface AttendancePolicy {
  method: 'CLOCK' | 'SCHEDULE'; graceMinutes: number; autoAbsent: boolean;
  late: { deduct: boolean; rounding: 'MINUTE' | 'Q15' | 'Q30' | 'HOUR'; method: 'HOUR_VALUE' | 'FIXED' | 'PERCENT'; fixedAmount: number; percent: number; mode: 'AUTO' | 'APPROVAL'; allowExemption: boolean; allowExcuse: boolean };
  early: { deduct: boolean };
  overtime: { enabled: boolean; requireCheckout: boolean; minMinutes: number; method: 'HOUR_VALUE' | 'MULTIPLIER' | 'FIXED'; multiplier: number; fixedRate: number; holidayEnabled: boolean; holidayMultiplier: number; holidayWeekdays: number[]; holidays: string[]; needsApproval: boolean };
  payroll: { defaultPayType: 'MONTHLY' | 'HOURLY'; dayDivisor: number; dailyHours: number; absenceAffects: boolean; autoAllowances: boolean; adjustmentsNeedApproval: boolean; lockOnApproval: boolean };
  leaves: { needsApproval: boolean; pay: Record<'ANNUAL' | 'SICK' | 'UNPAID' | 'EMERGENCY' | 'OTHER', Effect>; excusedAbsence: Effect; unexcusedAbsence: Effect; annualDays: number; sickDays: number };
}

export const useAttendancePolicy = () => useQuery({ queryKey: ['attendance-policy'], queryFn: () => api.get<AttendancePolicy>('/staff/policy') });

/** Section of the policy screen; its details show only while its policy is on. */
function Section({ title, hint, on, onToggle, disabled, children }: { title: string; hint?: string; on?: boolean; onToggle?: (v: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <Card>
      {onToggle ? <Switch checked={!!on} onChange={onToggle} label={<span className="text-base">{title}</span>} hint={hint} disabled={disabled} /> : <CardHeader title={title} subtitle={hint} />}
      {(on === undefined || on) && children && <div className="mt-4 space-y-4 border-t border-line pt-4">{children}</div>}
    </Card>
  );
}

/** Choice between a few options, shown as buttons (clearer than a list for 2–4 choices). */
function Choice<K extends string>({ value, options, onChange, disabled }: { value: K; options: { key: K; label: string; hint?: string }[]; onChange: (k: K) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <button key={o.key} type="button" disabled={disabled} onClick={() => onChange(o.key)}
          className={`rounded-xl border p-3 text-start text-sm transition ${value === o.key ? 'border-primary-400 bg-primary-50 ring-2 ring-primary-200' : 'border-line hover:border-primary-200'} disabled:cursor-not-allowed`}>
          <span className="block font-semibold text-ink">{o.label}</span>
          {o.hint && <span className="mt-1 block text-xs text-ink-muted">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function AttendancePolicyCard() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const edit = can('attendance.settings.manage');
  const q = useQuery({ queryKey: ['settings', 'attendance'], queryFn: () => api.get<AttendancePolicy>('/settings/attendance') });
  const [v, setV] = useState<AttendancePolicy | null>(null);
  const [holidays, setHolidays] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => { if (q.data) { setV(q.data); setHolidays(q.data.overtime.holidays.join('\n')); } }, [q.data]);
  const save = useApiMutation(() => api.put('/settings/attendance', { ...v, overtime: { ...v!.overtime, holidays: holidays.split(/\s+/).map((x) => x.trim()).filter(Boolean) }, reason }), {
    invalidate: [['settings'], ['attendance-policy'], ['attendance']],
    onSuccess: () => { toast.success(t('pol.saved')); setReason(''); },
  });
  if (!v) return <PageLoader />;
  const s = (k: string) => t(`pol.s.${k}`);
  const set = <K extends keyof AttendancePolicy>(k: K, patch: Partial<AttendancePolicy[K]>) => setV({ ...v, [k]: { ...(v[k] as object), ...patch } });
  const num = (x: string) => (x === '' ? 0 : Number(x));
  const dis = !edit;
  const effects: Effect[] = ['PAID', 'HALF', 'UNPAID'];
  const effectSelect = (value: Effect, onChange: (e: Effect) => void) => (
    <Select value={value} disabled={dis} onChange={(e) => onChange(e.target.value as Effect)}>{effects.map((e) => <option key={e} value={e}>{t(`pol.s.eff.${e}`)}</option>)}</Select>
  );
  return (
    <div className="space-y-4">
      <Card className="border-primary-200 bg-primary-50/50">
        <p className="text-lg font-bold text-primary-800">{t('pol.title')}</p>
        <p className="mt-1 text-sm text-ink-soft">{t('pol.subtitle')}</p>
        {dis && <p className="mt-2 text-xs font-semibold text-warning-700">{t('pol.readOnly')}</p>}
      </Card>

      <Section title={s('method')} hint={s('methodHint')}>
        <Choice value={v.method} disabled={dis} onChange={(method) => setV({ ...v, method })} options={(['CLOCK', 'SCHEDULE'] as const).map((k) => ({ key: k, label: s(`m.${k}`), hint: s(`m.${k}_d`) }))} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={s('grace')} hint={s('graceHint')}><Input type="number" min={0} max={120} dir="ltr" disabled={dis} value={v.graceMinutes} onChange={(e) => setV({ ...v, graceMinutes: num(e.target.value) })} /></Field>
          <Switch checked={v.autoAbsent} disabled={dis} onChange={(autoAbsent) => setV({ ...v, autoAbsent })} label={s('autoAbsent')} hint={s('autoAbsentHint')} />
        </div>
      </Section>

      <Section title={s('lateTitle')} hint={s('lateHint')} on={v.late.deduct} disabled={dis} onToggle={(deduct) => set('late', { deduct })}>
        <Field label={s('rounding')} hint={s('roundingHint')} group><Choice value={v.late.rounding} disabled={dis} onChange={(rounding) => set('late', { rounding })} options={(['MINUTE', 'Q15', 'Q30', 'HOUR'] as const).map((k) => ({ key: k, label: s(`r.${k}`) }))} /></Field>
        <Field label={s('lateMethod')} group><Choice value={v.late.method} disabled={dis} onChange={(method) => set('late', { method })} options={(['HOUR_VALUE', 'FIXED', 'PERCENT'] as const).map((k) => ({ key: k, label: s(`lm.${k}`) }))} /></Field>
        {v.late.method === 'FIXED' && <Field label={s('fixedAmount')} className="sm:w-60"><Input type="number" min={0} step="0.001" dir="ltr" disabled={dis} value={v.late.fixedAmount} onChange={(e) => set('late', { fixedAmount: num(e.target.value) })} /></Field>}
        {v.late.method === 'PERCENT' && <Field label={s('percent')} className="sm:w-60"><Input type="number" min={0} max={100} step="0.5" dir="ltr" disabled={dis} value={v.late.percent} onChange={(e) => set('late', { percent: num(e.target.value) })} /></Field>}
        <Field label={s('lateMode')} group><Choice value={v.late.mode} disabled={dis} onChange={(mode) => set('late', { mode })} options={(['AUTO', 'APPROVAL'] as const).map((k) => ({ key: k, label: s(`mode.${k}`) }))} /></Field>
        <Switch checked={v.late.allowExemption} disabled={dis} onChange={(allowExemption) => set('late', { allowExemption })} label={s('allowExemption')} />
        <Switch checked={v.late.allowExcuse} disabled={dis} onChange={(allowExcuse) => set('late', { allowExcuse })} label={s('allowExcuse')} />
      </Section>

      <Section title={s('earlyTitle')} hint={s('earlyHint')} on={v.early.deduct} disabled={dis} onToggle={(deduct) => set('early', { deduct })} />

      <Section title={s('otTitle')} hint={s('otHint')} on={v.overtime.enabled} disabled={dis} onToggle={(enabled) => set('overtime', { enabled })}>
        <Switch checked={v.overtime.requireCheckout} disabled={dis} onChange={(requireCheckout) => set('overtime', { requireCheckout })} label={s('requireCheckout')} hint={s('requireCheckoutHint')} />
        <Field label={s('minMinutes')} className="sm:w-60"><Input type="number" min={0} max={240} dir="ltr" disabled={dis} value={v.overtime.minMinutes} onChange={(e) => set('overtime', { minMinutes: num(e.target.value) })} /></Field>
        <Field label={s('otMethod')} group><Choice value={v.overtime.method} disabled={dis} onChange={(method) => set('overtime', { method })} options={(['HOUR_VALUE', 'MULTIPLIER', 'FIXED'] as const).map((k) => ({ key: k, label: s(`om.${k}`) }))} /></Field>
        {v.overtime.method === 'MULTIPLIER' && <Field label={s('multiplier')} className="sm:w-60"><Input type="number" min={1} max={5} step="0.05" dir="ltr" disabled={dis} value={v.overtime.multiplier} onChange={(e) => set('overtime', { multiplier: num(e.target.value) })} /></Field>}
        {v.overtime.method === 'FIXED' && <Field label={s('fixedRate')} className="sm:w-60"><Input type="number" min={0} step="0.001" dir="ltr" disabled={dis} value={v.overtime.fixedRate} onChange={(e) => set('overtime', { fixedRate: num(e.target.value) })} /></Field>}
        <Switch checked={v.overtime.needsApproval} disabled={dis} onChange={(needsApproval) => set('overtime', { needsApproval })} label={s('otApproval')} />
        <Switch checked={v.overtime.holidayEnabled} disabled={dis} onChange={(holidayEnabled) => set('overtime', { holidayEnabled })} label={s('holidayEnabled')} />
        {v.overtime.holidayEnabled && (
          <div className="grid gap-4 rounded-xl bg-surface-subtle p-3 sm:grid-cols-2">
            <Field label={s('holidayMultiplier')}><Input type="number" min={1} max={5} step="0.05" dir="ltr" disabled={dis} value={v.overtime.holidayMultiplier} onChange={(e) => set('overtime', { holidayMultiplier: num(e.target.value) })} /></Field>
            <Field label={s('holidayWeekdays')} group>
              <div className="flex flex-wrap gap-1">{(t('staff.dayNames', { returnObjects: true }) as string[]).map((d, i) => {
                const on = v.overtime.holidayWeekdays.includes(i);
                return <Button key={i} size="sm" disabled={dis} variant={on ? 'primary' : 'outline'} onClick={() => set('overtime', { holidayWeekdays: on ? v.overtime.holidayWeekdays.filter((x) => x !== i) : [...v.overtime.holidayWeekdays, i] })}>{d}</Button>;
              })}</div>
            </Field>
            <Field label={s('holidays')} className="sm:col-span-2"><Textarea dir="ltr" rows={3} disabled={dis} value={holidays} onChange={(e) => setHolidays(e.target.value)} /></Field>
          </div>
        )}
      </Section>

      <Section title={s('payTitle')} hint={s('dayHint')}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={s('defaultPayType')} hint={s('defaultPayTypeHint')}><Select value={v.payroll.defaultPayType} disabled={dis} onChange={(e) => set('payroll', { defaultPayType: e.target.value as 'MONTHLY' | 'HOURLY' })}><option value="MONTHLY">{t('ao.pay.pt.MONTHLY')}</option><option value="HOURLY">{t('ao.pay.pt.HOURLY')}</option></Select></Field>
          <Field label={s('dayDivisor')}><Input type="number" min={20} max={31} dir="ltr" disabled={dis} value={v.payroll.dayDivisor} onChange={(e) => set('payroll', { dayDivisor: num(e.target.value) })} /></Field>
          <Field label={s('dailyHours')}><Input type="number" min={1} max={24} step="0.5" dir="ltr" disabled={dis} value={v.payroll.dailyHours} onChange={(e) => set('payroll', { dailyHours: num(e.target.value) })} /></Field>
        </div>
        <Switch checked={v.payroll.absenceAffects} disabled={dis} onChange={(absenceAffects) => set('payroll', { absenceAffects })} label={s('absenceAffects')} />
        <Switch checked={v.payroll.autoAllowances} disabled={dis} onChange={(autoAllowances) => set('payroll', { autoAllowances })} label={s('autoAllowances')} hint={s('autoAllowancesHint')} />
        <Switch checked={v.payroll.adjustmentsNeedApproval} disabled={dis} onChange={(adjustmentsNeedApproval) => set('payroll', { adjustmentsNeedApproval })} label={s('adjustmentsNeedApproval')} hint={s('adjustmentsHint')} />
        <Switch checked={v.payroll.lockOnApproval} disabled={dis} onChange={(lockOnApproval) => set('payroll', { lockOnApproval })} label={s('lockOnApproval')} hint={s('lockHint')} />
      </Section>

      <Section title={s('leavesTitle')} hint={s('leavesHint')}>
        <Switch checked={v.leaves.needsApproval} disabled={dis} onChange={(needsApproval) => set('leaves', { needsApproval })} label={s('leaveApproval')} hint={s('leaveApprovalHint')} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(['ANNUAL', 'SICK', 'UNPAID', 'EMERGENCY', 'OTHER'] as const).map((k) => <Field key={k} label={`${t(`enum.LeaveType.${k}`)} — ${s('effect')}`}>{effectSelect(v.leaves.pay[k], (e) => set('leaves', { pay: { ...v.leaves.pay, [k]: e } }))}</Field>)}
          <Field label={`${s('excusedAbsence')} — ${s('effect')}`}>{effectSelect(v.leaves.excusedAbsence, (excusedAbsence) => set('leaves', { excusedAbsence }))}</Field>
          <Field label={`${s('unexcusedAbsence')} — ${s('effect')}`}>{effectSelect(v.leaves.unexcusedAbsence, (unexcusedAbsence) => set('leaves', { unexcusedAbsence }))}</Field>
          <Field label={s('annualDays')}><Input type="number" min={0} max={60} dir="ltr" disabled={dis} value={v.leaves.annualDays} onChange={(e) => set('leaves', { annualDays: num(e.target.value) })} /></Field>
          <Field label={s('sickDays')}><Input type="number" min={0} max={60} dir="ltr" disabled={dis} value={v.leaves.sickDays} onChange={(e) => set('leaves', { sickDays: num(e.target.value) })} /></Field>
        </div>
      </Section>

      {edit && (
        <Card className="sticky bottom-2 z-10 shadow-lg">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('pol.reason')} hint={t('pol.reasonHint')} required className="min-w-0 flex-1" error={save.fieldErrors.reason}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <Button loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}>{t('common.saveChanges')}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
