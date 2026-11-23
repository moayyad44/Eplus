import type { ReactNode } from 'react';

export type SlotStatus = 'AVAILABLE' | 'VACANT' | 'SECURED' | 'PURCHASED' | 'TOO_LATE' | 'STARTED' | 'ENDED';
export type Holding = 'ASSIGNED' | 'SECURED' | 'PURCHASED' | 'VACANT';

export interface BoardSlot {
  id: string; date: string; startTime: string; endTime: string; hours: number; start: string; end: string;
  shift: { id: string; name: string; type: string; color: string | null };
  staffType: string | null; holder: { id: string; fullName: string; staffType: string } | null; holding: Holding; securedAt: string | null;
  status: SlotStatus; lockReason: string | null; mine: boolean;
  canBuy: boolean; canSecure: boolean; canRelease: boolean; canSwapFrom: boolean; canSwapWith: boolean; canCover: boolean;
  price: { base: number; source: string; discount: number; price: number } | null; securePrice: number | null;
  coverages: { id: string; minutes: number; status: string; startAt: string; endAt: string; by: string }[];
  handovers: { id: string; lateMinutes: number; extendedMinutes: number; reason: string | null; role: 'NEXT' | 'PREV'; prev: string | null; next: string | null }[];
}

export interface Board {
  now: string;
  slots: BoardSlot[];
  unassigned: { date: string; shift: { id: string; name: string; startTime: string; endTime: string; color: string | null } }[];
  viewer: {
    userId: string; isDoctor: boolean; canEcoin: boolean; canSwap: boolean; canRelease: boolean; canCover: boolean; showPrices: boolean; balance: number | null;
    penalty: { discount: number; usesLeft: number } | null; canManage: boolean; canHandover: boolean;
  };
  rules: { purchaseLeadMinutes: number; changeLeadMinutes: number; minCoverMinutes: number; maxCoverMinutes: number; ecoinEnabled: boolean };
}

/** Status colours: available (blue), protected (green/violet), closed (grey). */
export const STATUS_STYLE: Record<SlotStatus | 'UNASSIGNED', string> = {
  AVAILABLE: 'bg-primary-50 text-primary-800 ring-primary-200',
  VACANT: 'bg-warning-50 text-warning-800 ring-warning-200',
  SECURED: 'bg-success-50 text-success-700 ring-success-200',
  PURCHASED: 'bg-violet-50 text-violet-700 ring-violet-200',
  TOO_LATE: 'bg-surface-sunken text-ink-muted ring-line',
  STARTED: 'bg-surface-sunken text-ink-muted ring-line',
  ENDED: 'bg-surface-sunken text-ink-muted ring-line',
  UNASSIGNED: 'bg-white text-ink-muted ring-line',
};

export type Node = ReactNode;
