import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, ChevronLeft, ChevronRight, Clock, Hand, Lock, ShieldCheck, ShoppingCart, Timer, UserCog, Undo2 } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, usePagedList } from '@/lib/hooks';
import { addDays, fmtDate, fmtDateTime, fmtDay, startOfWeek, ymd } from '@/lib/format';
import type { UserLite } from '@/lib/types';
import { STATUS_STYLE, type Board, type BoardSlot } from '@/lib/ecoin';
import { Badge, Button, Card, Checkbox, DataTable, DateRangePicker, Dialog, EmptyState, Field, IconButton, Input, PageHeader, PageLoader, Pagination, Segmented, Select, Tabs, Textarea, presetRange, useConfirm } from '@/components/ui';
import { BalancePill, CoinAmount } from '@/components/shared/ECoin';

type Tab = 'board' | 'requests' | 'log';
const day = (s: string) => `⁨${fmtDay(`${s}T00:00:00Z`)}⁩`;
// Times are isolated left-to-right so «08:00–16:00» is never flipped inside Arabic text.
const slotLabel = (s: { shift: { name: string }; date: string; startTime: string; endTime: string }) => `${s.shift.name} ${day(s.date)} (\u2066${s.startTime}–${s.endTime}\u2069)`;
/** What a slot is called for this viewer: "available to buy" only where buying with coins applies. */
const shownStatus = (s: BoardSlot, coins: boolean) =>
  s.mine && s.status === 'AVAILABLE' && s.staffType === 'DOCTOR' && coins ? 'MINE_OPEN'
  : (s.status === 'AVAILABLE' || (s.status === 'TOO_LATE' && !s.price)) && (s.staffType !== 'DOCTOR' || !coins) ? 'UPCOMING'
  : s.status;
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/[^0-9a-f-]/g, '0'));

export default function ShiftBoard() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = (['board', 'requests', 'log'] as Tab[]).find((k) => k === params.get('tab')) ?? 'board';
  return (
    <div>
      <PageHeader title={t('sx.title')} subtitle={t('sx.subtitle')} />
      <Tabs items={(['board', 'requests', 'log'] as Tab[]).map((k) => ({ key: k, label: t(`sx.tabs.${k}`) }))} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} className="mb-4" />
      {tab === 'board' && <WeekBoard />}
      {tab === 'requests' && <Requests />}
      {tab === 'log' && <Log />}
    </div>
  );
}

function WeekBoard() {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState(new Date());
  const [staffType, setStaffType] = useState<'' | 'DOCTOR' | 'NURSE'>('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const days = useMemo(() => { const s = startOfWeek(anchor); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }, [anchor]);
  const from = ymd(days[0]), to = ymd(days[6]);
  const q = useQuery({ queryKey: ['board', from, to, staffType], queryFn: () => api.get<Board>('/shifts/board', { from, to, staffType: staffType || undefined }), refetchInterval: 60_000 });
  const dayNames = t('staff.dayNames', { returnObjects: true }) as string[];
  const b = q.data;
  const slots = (b?.slots ?? []).filter((s) => !onlyMine || s.mine);
  const current = b?.slots.find((s) => s.id === open) ?? null;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <IconButton label={t('common.previous')} onClick={() => setAnchor(addDays(anchor, -7))}><ChevronRight className="h-4 w-4 ltr:rotate-180" /></IconButton>
          <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>{t('common.today')}</Button>
          <IconButton label={t('common.next')} onClick={() => setAnchor(addDays(anchor, 7))}><ChevronLeft className="h-4 w-4 ltr:rotate-180" /></IconButton>
          <Input type="date" value={ymd(anchor)} onChange={(e) => e.target.value && setAnchor(new Date(`${e.target.value}T12:00:00`))} className="!h-9 w-40" aria-label={t('sx.week')} />
          <span className="text-sm font-bold">{fmtDate(days[0])} — {fmtDate(days[6])}</span>
          <Segmented items={(['', 'DOCTOR', 'NURSE'] as const).map((k) => ({ key: k, label: t(`sx.staff.${k || 'all'}`) }))} value={staffType} onChange={setStaffType} />
          <Checkbox label={t('sx.onlyMine')} checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {b?.viewer.penalty && <Badge tone="warning" dot={false}>{t('sx.discountActive', { d: b.viewer.penalty.discount, left: b.viewer.penalty.usesLeft })}</Badge>}
            {b?.viewer.balance != null && <BalancePill value={b.viewer.balance} label={t('sx.myBalance')} />}
          </div>
        </div>
      </Card>
      {q.isLoading ? <PageLoader /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
          {days.map((d) => {
            const k = ymd(d);
            const list = slots.filter((s) => s.date === k);
            const free = onlyMine ? [] : (b?.unassigned ?? []).filter((u) => u.date === k);
            return (
              <section key={k} className={clsx('rounded-2xl border bg-white p-2 shadow-card', k === ymd() ? 'border-primary-300' : 'border-line')}>
                <h3 className={clsx('mb-2 rounded-xl px-2 py-1.5 text-center text-sm font-bold', k === ymd() ? 'bg-primary-50 text-primary-800' : 'bg-surface-subtle')}>
                  {dayNames[d.getDay()]} <span className="font-normal text-ink-muted">{d.getDate()}/{d.getMonth() + 1}</span>
                </h3>
                <div className="space-y-2">
                  {list.map((s) => <SlotCard key={s.id} s={s} showPrice={!!b?.viewer.showPrices} onOpen={() => setOpen(s.id)} />)}
                  {free.map((u) => (
                    <div key={`${u.shift.id}-${u.date}`} className={clsx('rounded-xl border border-dashed px-2 py-1.5 text-xs ring-0', STATUS_STYLE.UNASSIGNED)} title={t('sx.notDistributed')}>
                      <div className="flex items-center justify-between gap-1"><b>{u.shift.name}</b><Lock className="h-3.5 w-3.5" /></div>
                      <span dir="ltr">{u.shift.startTime}–{u.shift.endTime}</span> · {t('sx.notDistributed')}
                    </div>
                  ))}
                  {!list.length && !free.length && <p className="py-4 text-center text-xs text-ink-muted">—</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {current && b && <SlotDialog s={current} board={b} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SlotCard({ s, showPrice, onOpen }: { s: BoardSlot; showPrice: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const locked = s.price && !s.canBuy && !s.mine;
  const state = shownStatus(s, showPrice);
  const cover = s.coverages.find((c) => c.status === 'ACCEPTED');
  return (
    <button type="button" onClick={onOpen}
      className={clsx('block w-full rounded-xl px-2 py-1.5 text-start text-xs ring-1 transition hover:shadow-pop', STATUS_STYLE[s.status], s.mine && 'outline outline-2 outline-primary-500')}
      style={{ borderInlineStart: `4px solid ${s.shift.color ?? '#6cc0ec'}` }}>
      <div className="flex items-center justify-between gap-1">
        <b className="truncate">{s.shift.name}</b>
        <span className="flex items-center gap-1">
          {s.status === 'SECURED' && <ShieldCheck className="h-3.5 w-3.5" aria-label={t('sx.status.SECURED')} />}
          {locked && <Lock className="h-3.5 w-3.5" aria-label={s.lockReason ?? ''} />}
          {showPrice && s.price && <CoinAmount value={s.price.price} className="text-[11px]" />}
        </span>
      </div>
      <span dir="ltr" className="block">{s.startTime}–{s.endTime} · {t('sx.hours', { h: s.hours })}</span>
      <span className="block truncate font-semibold text-ink">{s.holder?.fullName ?? t('sx.vacant')}</span>
      <span className="block text-[11px]">{s.mine ? `${t('sx.status.MINE')} · ` : ''}{t(`sx.status.${state}`)}</span>
      {cover && <span className="mt-0.5 block text-[11px] text-ink-soft">{t('sx.coveredBy', { name: cover.by, m: cover.minutes })}</span>}
      {s.handovers.map((h) => <span key={h.id} className="mt-0.5 block text-[11px] text-danger-700">{h.role === 'NEXT' ? t('sx.late', { m: h.lateMinutes }) : t('sx.extended', { m: h.extendedMinutes })}</span>)}
    </button>
  );
}

interface Detail { events: { id: string; type: string; createdAt: string; from: string | null; to: string | null; by: string | null; price: number | null; note: string | null }[]; originalHolder: string | null }

function SlotDialog({ s, board, onClose }: { s: BoardSlot; board: Board; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [mode, setMode] = useState<null | 'swap' | 'cover' | 'handover' | 'assign'>(null);
  const [requestId] = useState(newRequestId); // one id per dialog: a resent/double-clicked purchase is never charged twice
  const detail = useQuery({ queryKey: ['shift', s.id], queryFn: () => api.get<Detail>(`/shifts/${s.id}`) });
  const inv = [['board'], ['shift'], ['ecoin']];
  const buy = useApiMutation(() => api.post<{ balance: number }>(`/shifts/${s.id}/buy`, { requestId }), { invalidate: inv, success: false, onSuccess: (r) => { toast.success(t('sx.bought', { bal: r.balance })); onClose(); } });
  const secure = useApiMutation(() => api.post<{ balance: number }>(`/shifts/${s.id}/secure`, { requestId }), { invalidate: inv, success: false, onSuccess: (r) => { toast.success(t('sx.secured', { bal: r.balance })); onClose(); } });
  const release = useApiMutation((reason: string | null) => api.post(`/shifts/${s.id}/release`, { confirm: true, reason }), { invalidate: inv, success: t('sx.released'), onSuccess: onClose });
  const bal = board.viewer.balance ?? 0;
  const label = slotLabel(s);
  const doBuy = async () => {
    const price = s.price?.price ?? 0;
    if (bal < price) return toast.error(t('sx.notEnough', { bal }));
    if (await confirm({ message: <span className="whitespace-pre-line">{t('sx.buyConfirm', { slot: label, price, bal, after: bal - price })}</span>, confirmLabel: t('sx.act.buy') })) buy.mutate(undefined);
  };
  const doSecure = async () => {
    const price = s.securePrice ?? 0;
    if (bal < price) return toast.error(t('sx.notEnough', { bal }));
    if (await confirm({ message: <span className="whitespace-pre-line">{t('sx.secureConfirm', { slot: label, price, after: bal - price })}</span>, confirmLabel: t('sx.act.secure') })) secure.mutate(undefined);
  };
  const doRelease = async () => {
    const r = await confirm({ message: <span className="whitespace-pre-line">{t('sx.releaseConfirm', { slot: label })}</span>, danger: true, confirmLabel: t('sx.act.release'), reason: { label: t('sx.releaseReason') } });
    if (r) release.mutate(r === 'ok' ? null : r);
  };
  const started = new Date(s.start) <= new Date(board.now);
  return (
    <Dialog open onClose={onClose} size="lg" title={label}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold ring-1', STATUS_STYLE[s.status])}>{t(`sx.statusLong.${shownStatus(s, board.viewer.showPrices)}`)}</span>
          <Badge dot={false}>{t(`sx.holding.${s.holding}`)}</Badge>
          {s.staffType && <Badge dot={false} tone="info">{t(`enum.StaffType.${s.staffType}`)}</Badge>}
        </div>
        <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('sx.holder')}</dt><dd className="font-semibold">{s.holder?.fullName ?? t('sx.vacant')}</dd></div>
          {detail.data?.originalHolder && <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('sx.original')}</dt><dd>{detail.data.originalHolder}</dd></div>}
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('common.time')}</dt><dd dir="ltr">{s.startTime}–{s.endTime}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">{t('sx.hours', { h: '' }).trim()}</dt><dd className="tabular-nums">{s.hours}</dd></div>
          {s.price && (
            <div className="flex justify-between gap-2 sm:col-span-2"><dt className="text-ink-muted">{t('sx.price')}</dt>
              <dd className="flex items-center gap-2">{s.price.discount > 0 && <span className="text-xs text-ink-muted">{t('sx.priceWas', { base: s.price.base, price: s.price.price })}</span>}<CoinAmount value={s.price.price} className="text-base" /></dd></div>
          )}
        </dl>
        {s.coverages.map((c) => <p key={c.id} className="rounded-xl bg-surface-subtle px-3 py-2 text-xs">{c.status === 'ACCEPTED' ? t('sx.coveredBy', { name: c.by, m: c.minutes }) : t('sx.coverPending', { name: c.by, m: c.minutes })}</p>)}
        {s.handovers.map((h) => <p key={h.id} className="rounded-xl bg-danger-50 px-3 py-2 text-xs text-danger-700">{h.next}: {t('sx.late', { m: h.lateMinutes })}{h.extendedMinutes ? ` · ${h.prev}: ${t('sx.extended', { m: h.extendedMinutes })}` : ''}{h.reason ? ` — ${h.reason}` : ''}</p>)}
        {s.lockReason && board.viewer.showPrices && s.price && (
          <p className="flex items-start gap-2 rounded-xl bg-surface-subtle px-3 py-2 text-xs"><Lock className="mt-0.5 h-4 w-4 shrink-0" /><span><b>{t('sx.whyLocked')}</b> {s.lockReason}</span></p>
        )}
        <div className="flex flex-wrap gap-2">
          {s.canBuy && <Button icon={<ShoppingCart className="h-4 w-4" />} loading={buy.isPending} onClick={doBuy}>{t('sx.act.buy')} · {s.price?.price} E Coin</Button>}
          {s.canSecure && <Button variant="success" icon={<ShieldCheck className="h-4 w-4" />} loading={secure.isPending} onClick={doSecure}>{t('sx.act.secure')} · {s.securePrice} E Coin</Button>}
          {(s.canSwapFrom || s.canSwapWith) && <Button variant="outline" icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setMode('swap')}>{t('sx.act.swap')}</Button>}
          {s.canCover && <Button variant="outline" icon={<Hand className="h-4 w-4" />} onClick={() => setMode('cover')}>{t('sx.act.cover')}</Button>}
          {s.canRelease && <Button variant="danger" icon={<Undo2 className="h-4 w-4" />} loading={release.isPending} onClick={doRelease}>{t('sx.act.release')}</Button>}
          {board.viewer.canHandover && started && <Button variant="outline" icon={<Timer className="h-4 w-4" />} onClick={() => setMode('handover')}>{t('sx.act.handover')}</Button>}
          {board.viewer.canManage && !started && can('shifts.manage') && <Button variant="ghost" icon={<UserCog className="h-4 w-4" />} onClick={() => setMode('assign')}>{t('sx.act.assign')}</Button>}
        </div>
        {mode === 'swap' && <SwapForm s={s} board={board} onDone={onClose} />}
        {mode === 'cover' && <CoverForm s={s} board={board} onDone={onClose} />}
        {mode === 'handover' && <HandoverForm s={s} onDone={onClose} />}
        {mode === 'assign' && <AssignForm s={s} onDone={onClose} />}
        <div>
          <h4 className="mb-2 flex items-center gap-2 font-bold"><Clock className="h-4 w-4" />{t('sx.history')}</h4>
          {!detail.data?.events.length ? <p className="text-xs text-ink-muted">{t('sx.noHistory')}</p> : (
            <ol className="space-y-1.5 text-xs">
              {detail.data.events.map((e) => (
                <li key={e.id} className="rounded-lg bg-surface-subtle px-2 py-1.5">
                  <b>{t(`sx.ev.${e.type}`)}</b> · <bdi>{fmtDateTime(e.createdAt)}</bdi>
                  {(e.from || e.to) && <> · {e.from ?? '—'} ← {e.to ?? '—'}</>}
                  {e.price != null && <> · <CoinAmount value={e.price} /></>}
                  {e.note && <span className="block text-ink-muted">{e.note}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function SwapForm({ s, board, onDone }: { s: BoardSlot; board: Board; onDone: () => void }) {
  const { t } = useTranslation();
  const candidates = s.mine
    ? board.slots.filter((x) => x.canSwapWith && x.staffType === s.staffType)
    : board.slots.filter((x) => x.canSwapFrom && x.staffType === s.staffType);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const send = useApiMutation(() => api.post('/shifts/swaps', s.mine ? { fromAssignmentId: s.id, toAssignmentId: pick, note: note || null } : { fromAssignmentId: pick, toAssignmentId: s.id, note: note || null }), {
    invalidate: [['board'], ['shift-requests']], success: t('sx.swapSent'), onSuccess: onDone,
  });
  if (!candidates.length) return <p className="rounded-xl bg-surface-subtle px-3 py-2 text-xs">{t('sx.noSwapCandidates')}</p>;
  return (
    <div className="space-y-3 rounded-2xl border border-line p-3">
      <Field label={s.mine ? t('sx.swapPickTheirs') : t('sx.swapPickMine')} required>
        <Select value={pick} onChange={(e) => setPick(e.target.value)} placeholder={t('common.select')}>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.shift.name} · {c.date} · {c.startTime}–{c.endTime}{s.mine ? ` · ${c.holder?.fullName}` : ''}</option>)}
        </Select>
      </Field>
      <Field label={t('sx.note')}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <Button disabled={!pick} loading={send.isPending} onClick={() => send.mutate(undefined)}>{t('sx.act.swap')}</Button>
    </div>
  );
}

function CoverForm({ s, board, onDone }: { s: BoardSlot; board: Board; onDone: () => void }) {
  const { t } = useTranslation();
  const { minCoverMinutes: min, maxCoverMinutes: max } = board.rules;
  const options = Array.from({ length: Math.floor((Math.min(max, s.hours * 60 - 1) - min) / 15) + 1 }, (_, i) => min + i * 15).filter((m) => m <= max);
  const [minutes, setMinutes] = useState(options.includes(60) ? 60 : options[0]);
  const [note, setNote] = useState('');
  const send = useApiMutation(() => api.post('/shifts/coverages', { assignmentId: s.id, minutes, note: note || null }), { invalidate: [['board'], ['shift-requests']], success: t('sx.coverSent'), onSuccess: onDone });
  return (
    <div className="space-y-3 rounded-2xl border border-line p-3">
      <p className="text-xs text-ink-muted">{t('sx.coverHint')}</p>
      <Field label={t('sx.coverMinutes')} required>
        <Select value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>{options.map((m) => <option key={m} value={m}>{m} {t('common.minutes')}</option>)}</Select>
      </Field>
      <Field label={t('sx.note')}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <Button loading={send.isPending} onClick={() => send.mutate(undefined)}>{t('sx.act.cover')}</Button>
    </div>
  );
}

function HandoverForm({ s, onDone }: { s: BoardSlot; onDone: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ lateMinutes: '0', extendedMinutes: '0', reason: '' });
  const send = useApiMutation(() => api.post('/shifts/handovers', { nextAssignmentId: s.id, lateMinutes: Number(v.lateMinutes), extendedMinutes: Number(v.extendedMinutes), reason: v.reason || null }), {
    invalidate: [['board'], ['handovers']], success: t('sx.handoverSaved'), onSuccess: onDone,
  });
  return (
    <div className="space-y-3 rounded-2xl border border-line p-3">
      <p className="text-xs text-ink-muted">{t('sx.handoverHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('sx.lateMinutes')}><Input type="number" min={0} max={720} value={v.lateMinutes} onChange={(e) => setV({ ...v, lateMinutes: e.target.value })} /></Field>
        <Field label={t('sx.extendedMinutes')}><Input type="number" min={0} max={720} value={v.extendedMinutes} onChange={(e) => setV({ ...v, extendedMinutes: e.target.value })} /></Field>
      </div>
      <Field label={t('common.reason')}><Textarea rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      <Button loading={send.isPending} onClick={() => send.mutate(undefined)}>{t('common.save')}</Button>
    </div>
  );
}

function AssignForm({ s, onDone }: { s: BoardSlot; onDone: () => void }) {
  const { t } = useTranslation();
  const staff = useQuery({ queryKey: ['users', 'lookup'], queryFn: () => api.get<UserLite[]>('/users/lookup') });
  const [v, setV] = useState({ userId: '', reason: '' });
  const send = useApiMutation(() => api.post(`/shifts/${s.id}/assign`, v), { invalidate: [['board'], ['shift'], ['schedule']], success: t('sx.assigned'), onSuccess: onDone });
  return (
    <div className="space-y-3 rounded-2xl border border-line p-3">
      <Field label={t('sx.assignTo')} required>
        <Select value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })} placeholder={t('common.select')}>
          {(staff.data ?? []).filter((u) => !s.staffType || u.staffType === s.staffType).filter((u) => u.id !== s.holder?.id).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </Select>
      </Field>
      <Field label={t('sx.assignReason')} required><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      <Button disabled={!v.userId || v.reason.trim().length < 3} loading={send.isPending} onClick={() => send.mutate(undefined)}>{t('common.save')}</Button>
    </div>
  );
}

// ── Requests (swaps and partial coverage) ──

interface SlotMini { id: string; date: string; startTime: string; endTime: string; shift: { name: string } }
interface Reqs {
  swaps: { id: string; status: string; requester: string; target: string; from: SlotMini; to: SlotMini; incoming: boolean; note: string | null; createdAt: string }[];
  coverages: { id: string; status: string; requester: string; owner: string; minutes: number; slot: SlotMini; incoming: boolean; note: string | null; createdAt: string }[];
}

function Requests() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['shift-requests'], queryFn: () => api.get<Reqs>('/shifts/requests/list') });
  const inv = [['shift-requests'], ['board']];
  const swap = useApiMutation((v: { id: string; decision: string }) => api.post(`/shifts/swaps/${v.id}/respond`, { decision: v.decision }), { invalidate: inv, success: t('sx.req.done') });
  const cover = useApiMutation((v: { id: string; decision: string }) => api.post(`/shifts/coverages/${v.id}/respond`, { decision: v.decision }), { invalidate: inv, success: t('sx.req.done') });
  if (q.isLoading) return <PageLoader />;
  const rows = [
    ...(q.data?.swaps ?? []).map((s) => ({ kind: 'swap' as const, id: s.id, status: s.status, incoming: s.incoming, who: s.incoming ? t('sx.req.by', { name: s.requester }) : t('sx.req.to', { name: s.target }), text: t('sx.req.swapLine', { from: slotLabel(s.from), to: slotLabel(s.to) }), note: s.note, at: s.createdAt })),
    ...(q.data?.coverages ?? []).map((c) => ({ kind: 'cover' as const, id: c.id, status: c.status, incoming: c.incoming, who: c.incoming ? t('sx.req.by', { name: c.requester }) : t('sx.req.to', { name: c.owner }), text: t('sx.req.coverLine', { m: c.minutes, slot: slotLabel(c.slot) }), note: c.note, at: c.createdAt })),
  ].sort((a, b) => (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1) || b.at.localeCompare(a.at));
  const act = async (r: (typeof rows)[number], decision: 'ACCEPT' | 'REJECT' | 'CANCEL') => {
    if (decision === 'ACCEPT' && r.kind === 'swap' && !(await confirm({ message: t('sx.req.acceptSwapConfirm') }))) return;
    (r.kind === 'swap' ? swap : cover).mutate({ id: r.id, decision });
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {[true, false].map((incoming) => (
        <Card key={String(incoming)}>
          <h3 className="mb-3 font-bold">{incoming ? t('sx.req.incoming') : t('sx.req.outgoing')}</h3>
          {!rows.filter((r) => r.incoming === incoming).length ? <EmptyState title={t('sx.req.none')} /> : (
            <ul className="space-y-2">
              {rows.filter((r) => r.incoming === incoming).map((r) => (
                <li key={`${r.kind}-${r.id}`} className="rounded-xl border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{t(`sx.req.${r.kind}`)} · {r.who}</span>
                    <Badge dot={false} tone={r.status === 'PENDING' ? 'warning' : r.status === 'ACCEPTED' ? 'success' : 'neutral'}>{t(`sx.req.status.${r.status}`)}</Badge>
                  </div>
                  <p className="mt-1 text-xs">{r.text}</p>
                  {r.note && <p className="mt-1 text-xs text-ink-muted">{r.note}</p>}
                  {r.status === 'PENDING' && (
                    <div className="mt-2 flex gap-2">
                      {incoming ? (
                        <>
                          <Button size="sm" variant="success" onClick={() => act(r, 'ACCEPT')}>{t('sx.req.accept')}</Button>
                          <Button size="sm" variant="outline" onClick={() => act(r, 'REJECT')}>{t('sx.req.reject')}</Button>
                        </>
                      ) : <Button size="sm" variant="ghost" onClick={() => act(r, 'CANCEL')}>{t('sx.req.cancel')}</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

// ── Log: ownership history and late arrivals / extensions ──

interface EventRow { id: string; type: string; createdAt: string; price: number | null; note: string | null; from: string | null; to: string | null; by: string | null; slot: SlotMini }
interface HandoverRow { id: string; createdAt: string; next: string | null; prev: string | null; plannedStart: string | null; actualStart: string | null; plannedEnd: string | null; actualEnd: string | null; lateMinutes: number; extendedMinutes: number; reason: string | null; recordedBy: string }

function Log() {
  const { t } = useTranslation();
  const ev = usePagedList<EventRow, { from?: string; to?: string; type?: string }>('shift-events', '/shifts/events/list', { filters: presetRange('month') });
  const ho = usePagedList<HandoverRow, { from?: string; to?: string }>('handovers', '/shifts/handovers/list', { filters: presetRange('month') });
  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="me-auto font-bold">{t('sx.log.events')}</h3>
          <Select value={ev.filters.type ?? ''} onChange={(e) => ev.setFilters({ type: e.target.value || undefined })} className="w-auto">
            <option value="">{t('common.all')}</option>
            {['PURCHASED', 'SECURED', 'RELEASED', 'SWAPPED', 'REASSIGNED', 'COVERAGE', 'HANDOVER', 'REVERSED'].map((x) => <option key={x} value={x}>{t(`sx.ev.${x}`)}</option>)}
          </Select>
          <DateRangePicker value={{ from: ev.filters.from!, to: ev.filters.to! }} onChange={(r) => ev.setFilters(r)} />
        </div>
        <DataTable rows={ev.data?.items} loading={ev.query.isFetching} rowKey={(r) => r.id} dense
          columns={[
            { key: 'd', header: t('common.date'), cell: (r) => <bdi className="text-xs">{fmtDateTime(r.createdAt)}</bdi> },
            { key: 't', header: t('common.type'), cell: (r) => <Badge dot={false}>{t(`sx.ev.${r.type}`)}</Badge> },
            { key: 's', header: t('sx.tabs.board'), cell: (r) => <span className="text-xs">{slotLabel(r.slot)}</span> },
            { key: 'w', header: t('sx.holder'), cell: (r) => <span className="text-xs">{r.from ?? '—'} ← {r.to ?? '—'}</span> },
            { key: 'p', header: t('sx.price'), cell: (r) => (r.price != null ? <CoinAmount value={r.price} /> : '—') },
            { key: 'n', header: t('sx.note'), hideOnMobile: true, cell: (r) => <span className="text-xs text-ink-muted">{r.note ?? ''}{r.by ? ` · ${r.by}` : ''}</span> },
          ]} />
        {ev.data && <Pagination page={ev.page} pageCount={ev.data.pageCount} total={ev.data.total} pageSize={ev.pageSize} onPage={ev.setPage} />}
      </Card>
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="me-auto font-bold">{t('sx.log.handovers')}</h3>
          <DateRangePicker value={{ from: ho.filters.from!, to: ho.filters.to! }} onChange={(r) => ho.setFilters(r)} />
        </div>
        <DataTable rows={ho.data?.items} loading={ho.query.isFetching} rowKey={(r) => r.id} dense
          columns={[
            { key: 'd', header: t('common.date'), cell: (r) => <bdi className="text-xs">{fmtDateTime(r.createdAt)}</bdi> },
            { key: 'n', header: t('sx.lateMinutes'), cell: (r) => <span className="text-xs">{r.next} · <b>{r.lateMinutes}</b> د<span className="block text-ink-muted">{t('sx.log.planned')} <bdi>{fmtDateTime(r.plannedStart)}</bdi> · {t('sx.log.actual')} <bdi>{fmtDateTime(r.actualStart)}</bdi></span></span> },
            { key: 'p', header: t('sx.extendedMinutes'), cell: (r) => (r.prev ? <span className="text-xs">{r.prev} · <b>{r.extendedMinutes}</b> د<span className="block text-ink-muted">{t('sx.log.planned')} <bdi>{fmtDateTime(r.plannedEnd)}</bdi> · {t('sx.log.actual')} <bdi>{fmtDateTime(r.actualEnd)}</bdi></span></span> : '—') },
            { key: 'r', header: t('common.reason'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.reason ?? '—'}</span> },
            { key: 'b', header: t('sx.log.recordedBy'), hideOnMobile: true, cell: (r) => <span className="text-xs">{r.recordedBy}</span> },
          ]} />
        {ho.data && <Pagination page={ho.page} pageCount={ho.data.pageCount} total={ho.data.total} pageSize={ho.pageSize} onPage={ho.setPage} />}
      </Card>
    </div>
  );
}
