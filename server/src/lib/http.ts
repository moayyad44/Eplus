import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  q: z.string().trim().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type PageQuery = z.infer<typeof pageQuery>;

export const paginate = (p: { page: number; pageSize: number }) => ({ skip: (p.page - 1) * p.pageSize, take: p.pageSize });

export const paged = <T>(items: T[], total: number, p: { page: number; pageSize: number }) => ({
  items,
  total,
  page: p.page,
  pageSize: p.pageSize,
  pageCount: Math.max(1, Math.ceil(total / p.pageSize)),
});

/** Picks a sort field from a whitelist, falling back to a default. */
export const sortBy = <K extends string>(sort: string | undefined, allowed: readonly K[], fallback: K, order: 'asc' | 'desc') => {
  const field = (allowed as readonly string[]).includes(sort ?? '') ? (sort as K) : fallback;
  return { [field]: order } as Record<K, 'asc' | 'desc'>;
};

export const optionalDate = z
  .union([z.string(), z.date()])
  .optional()
  .nullable()
  .transform((v) => (v ? new Date(v) : v === null ? null : undefined))
  .refine((v) => v === undefined || v === null || !Number.isNaN(v.getTime()), 'تاريخ غير صالح');

export const requiredDate = z
  .union([z.string().min(1), z.date()])
  .transform((v) => new Date(v))
  .refine((v) => !Number.isNaN(v.getTime()), 'تاريخ غير صالح');

export const emptyToUndef = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

export const nullableStr = (max = 500) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v), z.string().max(max).nullable().optional());
