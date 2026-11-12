import clsx from 'clsx';
import { Coins } from 'lucide-react';

/** E Coin amount with the coin icon (gold, distinct from money). */
export function CoinAmount({ value, className, strike }: { value: number; className?: string; strike?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 font-bold tabular-nums', strike && 'line-through opacity-60', className)}>
      <Coins className="h-3.5 w-3.5 text-warning-600" aria-hidden />
      {value}
    </span>
  );
}

/** Prominent balance pill used in headers. */
export function BalancePill({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-2xl bg-warning-50 px-3 py-1.5 text-warning-800 ring-1 ring-warning-200">
      <Coins className="h-5 w-5 text-warning-600" aria-hidden />
      <span className="text-xs">{label}</span>
      <b className="text-lg tabular-nums" dir="ltr">{value}</b>
      <span className="text-xs font-semibold">E Coin</span>
    </span>
  );
}
