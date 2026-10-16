import { Router } from 'express';
import { z } from 'zod';
import type { EInvoiceStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, pageQuery, paged, paginate } from '../../lib/http';
import { parse } from '../../lib/validate';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { num } from '../../lib/money';
import { rangeFromQuery } from '../../lib/dates';
import { requireAnyPerm, requirePerm } from '../../middleware/auth';
import { getSetting } from '../../lib/settings';
import { loadStored, missing, publicView, saveStored, sealValue } from './config';
import { createReturn, DOC_STATUSES, flushDocs, invoiceDocs, kick, sendDocument } from './service';

export const einvoiceRouter = Router();

// ── Settings (credentials are write-only: never returned, never logged) ──

einvoiceRouter.get(
  '/config',
  requirePerm('einvoice.settings'),
  ah(async (_req, res) => {
    const v = publicView(await loadStored());
    // First setup: suggest the tax number already entered in the clinic settings (still saved only on purpose).
    const clinicTax = (await getSetting('clinic')).taxNumber.replace(/\D/g, '');
    res.json({ ...v, taxNumber: v.taxNumber || clinicTax });
  }),
);

const digits = (label: string, max: number) => z.string().trim().regex(new RegExp(`^\\d{0,${max}}$`), `${label}: أرقام فقط`);

einvoiceRouter.put(
  '/config',
  requirePerm('einvoice.settings'),
  ah(async (req, res) => {
    const body = parse(z.object({
      enabled: z.boolean().optional(),
      taxNumber: digits('الرقم الضريبي', 15).optional(),
      sellerName: z.string().trim().max(200).optional(),
      incomeSourceSeq: digits('تسلسل مصدر الدخل', 20).optional(),
      zeroCategory: z.enum(['Z', 'O']).optional(),
      timeoutSec: z.coerce.number().int().min(5).max(120).optional(),
      /** Empty / omitted = keep the stored value. */
      clientId: z.string().trim().max(200).optional(),
      secretKey: z.string().trim().max(500).optional(),
      clearCredentials: z.boolean().optional(),
    }), req.body);
    const before = await loadStored();
    const next = { ...before };
    for (const k of ['enabled', 'taxNumber', 'sellerName', 'incomeSourceSeq', 'zeroCategory', 'timeoutSec'] as const) {
      if (body[k] !== undefined) (next as Record<string, unknown>)[k] = body[k];
    }
    let credsChanged = false;
    if (body.clearCredentials) {
      Object.assign(next, { clientIdEnc: null, secretKeyEnc: null, clientIdHint: '' });
      credsChanged = true;
    }
    if (body.clientId) { next.clientIdEnc = sealValue(body.clientId); next.clientIdHint = body.clientId.slice(-4); credsChanged = true; }
    if (body.secretKey) { next.secretKeyEnc = sealValue(body.secretKey); credsChanged = true; }
    if (credsChanged) next.credentialsUpdatedAt = new Date().toISOString();
    if (next.enabled) {
      const m = missing(next);
      if (m.length) throw badRequest(`لا يمكن تفعيل الربط قبل إكمال: ${m.join('، ')}`);
    }
    const safe = (c: typeof next) => ({
      enabled: c.enabled, taxNumber: c.taxNumber, sellerName: c.sellerName, incomeSourceSeq: c.incomeSourceSeq, zeroCategory: c.zeroCategory, timeoutSec: c.timeoutSec,
    });
    await prisma.$transaction(async (tx) => {
      await saveStored(tx, next, req.ctx.userId);
      await audit(tx, req.ctx, {
        action: 'einvoice.settings', entityType: 'setting', entityId: 'jofotara',
        summary: `تعديل إعدادات الفوترة الوطنية${credsChanged ? (body.clearCredentials ? ' (حذف بيانات الربط)' : ' (تغيير بيانات الربط)') : ''}${before.enabled !== next.enabled ? (next.enabled ? ' — تفعيل الربط' : ' — إيقاف الربط') : ''}`,
        before: safe(before), after: { ...safe(next), credentialsChanged: credsChanged },
      });
    });
    if (next.enabled) kick();
    res.json(publicView(next));
  }),
);

// ── Dashboard ──

einvoiceRouter.get(
  '/summary',
  requirePerm('einvoice.view'),
  ah(async (req, res) => {
    const { from, to } = rangeFromQuery(String(req.query.from ?? '') || undefined, String(req.query.to ?? '') || undefined);
    const cfg = await loadStored();
    const [byStatus, period, lastOk, oldestOpen] = await Promise.all([
      prisma.eInvoice.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.eInvoice.groupBy({ by: ['kind'], where: { status: 'SUBMITTED', submittedAt: { gte: from, lte: to } }, _count: { _all: true }, _sum: { total: true } }),
      prisma.eInvoice.findFirst({ where: { status: 'SUBMITTED' }, orderBy: { submittedAt: 'desc' }, select: { submittedAt: true } }),
      prisma.eInvoice.findFirst({ where: { status: { in: ['PENDING', 'UNKNOWN', 'FAILED', 'REJECTED', 'SENDING'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    const counts = Object.fromEntries(DOC_STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?._count._all ?? 0]));
    const p = (k: 'SALE' | 'RETURN') => ({ count: period.find((x) => x.kind === k)?._count._all ?? 0, total: num(period.find((x) => x.kind === k)?._sum.total) });
    res.json({
      config: { enabled: cfg.enabled, missing: missing(cfg) },
      counts, period: { sales: p('SALE'), returns: p('RETURN') },
      lastSubmittedAt: lastOk?.submittedAt ?? null, oldestOpenAt: oldestOpen?.createdAt ?? null,
    });
  }),
);

einvoiceRouter.get(
  '/documents',
  requirePerm('einvoice.view'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({
      status: z.string().optional(), kind: z.enum(['SALE', 'RETURN']).optional(), from: z.string().optional(), to: z.string().optional(),
    }), req.query);
    const statuses = (q.status ?? '').split(',').filter((s) => DOC_STATUSES.includes(s as EInvoiceStatus)) as EInvoiceStatus[];
    const where: Prisma.EInvoiceWhereInput = {
      ...(statuses.length && { status: { in: statuses } }),
      ...(q.kind && { kind: q.kind }),
      ...((q.from || q.to) && { createdAt: { gte: rangeFromQuery(q.from, q.to ?? q.from).from, lte: rangeFromQuery(q.from ?? q.to, q.to).to } }),
      ...(q.q && { OR: [{ docNumber: { contains: q.q, mode: 'insensitive' } }, { invoice: { invoiceNumber: { contains: q.q, mode: 'insensitive' } } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.eInvoice.findMany({
        where, orderBy: { createdAt: 'desc' }, ...paginate(q),
        select: {
          id: true, kind: true, party: true, docNumber: true, icv: true, typeName: true, issueDate: true, total: true, status: true, attempts: true,
          lastAttemptAt: true, nextAttemptAt: true, submittedAt: true, lastError: true, createdAt: true, reason: true,
          invoice: { select: { id: true, invoiceNumber: true, status: true, payerType: true, insuranceCompany: { select: { nameAr: true } } } },
        },
      }),
      prisma.eInvoice.count({ where }),
    ]);
    res.json(paged(items.map((d) => ({ ...d, total: num(d.total) })), total, q));
  }),
);

/** One document with its attempts (diagnostics). The XML holds no credentials. */
einvoiceRouter.get(
  '/documents/:id',
  requirePerm('einvoice.view'),
  ah(async (req, res) => {
    const d = await prisma.eInvoice.findUnique({
      where: { id: req.params.id },
      include: { attemptsLog: { orderBy: { at: 'desc' } }, invoice: { select: { id: true, invoiceNumber: true } }, original: { select: { id: true, docNumber: true } } },
    });
    if (!d) throw notFound();
    const userIds = [...new Set(d.attemptsLog.map((a) => a.userId).filter(Boolean))] as string[];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    const { signedInvoice, ...rest } = d;
    res.json({ ...rest, hasSignedInvoice: !!signedInvoice, total: num(d.total), userNames: Object.fromEntries(users.map((u) => [u.id, u.fullName])) });
  }),
);

/** National documents of an invoice (status + official QR) for the invoice page and its print. */
einvoiceRouter.get('/invoices/:invoiceId', requirePerm('invoices.view'), ah(async (req, res) => res.json(await invoiceDocs(req.params.invoiceId))));

einvoiceRouter.post(
  '/documents/:id/send',
  requirePerm('einvoice.send'),
  ah(async (req, res) => {
    const d = await prisma.eInvoice.findUnique({ where: { id: req.params.id } });
    if (!d) throw notFound();
    if (!['PENDING', 'FAILED', 'REJECTED', 'UNKNOWN'].includes(d.status)) throw badRequest('هذا المستند لا يحتاج إعادة إرسال');
    await audit(prisma, req.ctx, { action: 'einvoice.resend', entityType: 'invoice', entityId: d.invoiceId, summary: `إعادة إرسال ${d.docNumber} لنظام الفوترة الوطني (الحالة السابقة: ${d.status})` });
    const after = await sendDocument(d.id, { userId: req.ctx.userId, manual: true });
    res.json({ id: after.id, status: after.status, lastError: after.lastError });
  }),
);

/** Resends everything stuck (unknown outcome or failed before validation). Rejected ones need a look first. */
einvoiceRouter.post(
  '/retry',
  requirePerm('einvoice.send'),
  ah(async (req, res) => {
    const docs = await prisma.eInvoice.findMany({ where: { status: { in: ['PENDING', 'UNKNOWN', 'FAILED'] } }, orderBy: { createdAt: 'asc' }, take: 100, select: { id: true } });
    await audit(prisma, req.ctx, { action: 'einvoice.resend', entityType: 'setting', entityId: 'jofotara', summary: `إعادة إرسال ${docs.length} مستند متعثر لنظام الفوترة الوطني` });
    for (const d of docs) await sendDocument(d.id, { userId: req.ctx.userId, manual: true }).catch(() => undefined);
    const after = await prisma.eInvoice.groupBy({ by: ['status'], where: { id: { in: docs.map((d) => d.id) } }, _count: { _all: true } });
    res.json({ tried: docs.length, result: Object.fromEntries(after.map((a) => [a.status, a._count._all])) });
  }),
);

einvoiceRouter.post(
  '/documents/:id/returns',
  requirePerm('einvoice.return'),
  ah(async (req, res) => {
    const body = parse(z.object({
      reason: z.string().trim().min(3, 'يرجى ذكر سبب الإرجاع').max(300),
      lines: z.array(z.object({ lineId: z.coerce.number().int().min(1), quantity: z.coerce.number().min(0) })).min(1),
    }), req.body);
    const id = await prisma.$transaction((tx) => createReturn(tx, req.ctx, req.params.id, body.lines, body.reason));
    await flushDocs([id]);
    const d = await prisma.eInvoice.findUniqueOrThrow({ where: { id }, select: { id: true, docNumber: true, status: true, lastError: true } });
    res.status(201).json(d);
  }),
);

/** Insurance company setting: what is sent for its invoices (kept here so the e-invoicing admin can manage it). */
einvoiceRouter.get(
  '/companies',
  requireAnyPerm('einvoice.settings', 'insurance.company.manage'),
  ah(async (_req, res) => res.json(await prisma.insuranceCompany.findMany({ orderBy: { nameAr: 'asc' }, select: { id: true, nameAr: true, taxNumber: true, einvoiceMode: true, isActive: true } }))),
);
