import { Prisma } from '@prisma/client';

export const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
/** Round to fils (3 decimals). */
export const r3 = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
export const num = (v: Prisma.Decimal.Value | null | undefined) => (v == null ? 0 : new Prisma.Decimal(v).toNumber());
