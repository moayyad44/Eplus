import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';

interface CatalogConfig {
  /** Prisma delegate name, e.g. "visitType" */
  model: string;
  entity: string;
  schema: z.AnyZodObject;
  idField?: string;
  orderBy?: Record<string, 'asc' | 'desc'>[] | Record<string, 'asc' | 'desc'>;
  searchFields?: string[];
  include?: Record<string, unknown>;
  /** Extra filter applied to every read, e.g. soft-deleted rows. */
  baseWhere?: Record<string, unknown>;
}

/**
 * Generic catalog CRUD (settings lists). Reads are open to every authenticated user because
 * the lists feed dropdowns across the app; writes need settings.manage and are audited.
 * Items are deactivated, never hard-deleted, so historical records stay intact.
 */
export function catalogRouter(cfg: CatalogConfig) {
  const r = Router();
  const idField = cfg.idField ?? 'id';
  const delegate = () => (prisma as any)[cfg.model];

  r.get(
    '/',
    ah(async (req, res) => {
      const q = parse(z.object({ all: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }), req.query);
      const where: Record<string, unknown> = { ...(cfg.baseWhere ?? {}) };
      if (q.all !== 'true') where.isActive = true;
      if (q.q && cfg.searchFields) where.OR = cfg.searchFields.map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' } }));
      res.json(await delegate().findMany({ where, orderBy: cfg.orderBy ?? { createdAt: 'asc' }, include: cfg.include, take: q.limit }));
    }),
  );

  r.post(
    '/',
    requirePerm('settings.manage'),
    ah(async (req, res) => {
      const data = parse(cfg.schema, req.body);
      const row = await prisma.$transaction(async (tx) => {
        const created = await (tx as any)[cfg.model].create({ data });
        await audit(tx, req.ctx, { action: `${cfg.entity}.create`, entityType: cfg.entity, entityId: String(created[idField]), after: created });
        return created;
      });
      res.status(201).json(row);
    }),
  );

  r.put(
    '/:id',
    requirePerm('settings.manage'),
    ah(async (req, res) => {
      const data = parse(cfg.schema.partial(), req.body);
      const where = { [idField]: req.params.id };
      const before = await delegate().findUnique({ where });
      if (!before) throw notFound();
      const row = await prisma.$transaction(async (tx) => {
        const updated = await (tx as any)[cfg.model].update({ where, data });
        await audit(tx, req.ctx, { action: `${cfg.entity}.update`, entityType: cfg.entity, entityId: req.params.id, before, after: updated });
        return updated;
      });
      res.json(row);
    }),
  );

  r.delete(
    '/:id',
    requirePerm('settings.manage'),
    ah(async (req, res) => {
      const where = { [idField]: req.params.id };
      await prisma.$transaction(async (tx) => {
        const updated = await (tx as any)[cfg.model].update({ where, data: { isActive: false } });
        await audit(tx, req.ctx, { action: `${cfg.entity}.deactivate`, entityType: cfg.entity, entityId: req.params.id, after: updated });
      });
      res.json({ ok: true });
    }),
  );

  return r;
}
