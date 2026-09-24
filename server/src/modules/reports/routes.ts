import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { parse } from '../../lib/validate';
import { requirePerm } from '../../middleware/auth';
import { addDays, ageFrom, dateOnly, rangeFromQuery } from '../../lib/dates';
import { num } from '../../lib/money';
import { getSetting } from '../../lib/settings';
import { financialSummary } from '../billing/cashier';

export const reportsRouter = Router();

const rangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  doctorId: z.string().uuid().optional(),
  q: z.string().trim().optional(),
});

const LIMIT = 5000;

// ── Patients ──
reportsRouter.get(
  '/patients',
  requirePerm('reports.patients'),
  ah(async (req, res) => {
    const q = parse(rangeQuery, req.query);
    const { from, to } = rangeFromQuery(q.from, q.to);
    const visitWhere: Prisma.VisitWhereInput = {
      queueDate: { gte: dateOnly(q.from), lte: dateOnly(q.to) }, status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      ...(q.doctorId && { doctorId: q.doctorId }),
      ...(q.q && { patient: { OR: [{ fullName: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }] } }),
    };
    const [visits, newPatients, diagnoses] = await Promise.all([
      prisma.visit.findMany({
        where: visitWhere, orderBy: { arrivedAt: 'desc' }, take: LIMIT,
        select: {
          id: true, visitNumber: true, arrivedAt: true, status: true,
          patient: { select: { id: true, fullName: true, phone: true, fileNumber: true, gender: true, dateOfBirth: true, createdAt: true } },
          doctor: { select: { fullName: true } }, visitType: { select: { name: true } },
        },
      }),
      prisma.patient.count({ where: { createdAt: { gte: from, lte: to }, deletedAt: null } }),
      prisma.diagnosis.groupBy({
        by: ['description', 'icd10Code'], where: { deletedAt: null, createdAt: { gte: from, lte: to } },
        _count: true, orderBy: { _count: { description: 'desc' } }, take: 10,
      }),
    ]);
    const patientIds = new Set(visits.map((v) => v.patient.id));
    const newIds = new Set(visits.filter((v) => v.patient.createdAt >= from).map((v) => v.patient.id));
    const byDay = new Map<string, number>();
    const byGender = { MALE: 0, FEMALE: 0 };
    const byType = new Map<string, number>();
    const ageGroups: Record<string, number> = { '0-12': 0, '13-17': 0, '18-39': 0, '40-59': 0, '60+': 0, 'غير محدد': 0 };
    const seen = new Set<string>();
    for (const v of visits) {
      const day = v.arrivedAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      byType.set(v.visitType?.name ?? 'غير محدد', (byType.get(v.visitType?.name ?? 'غير محدد') ?? 0) + 1);
      if (seen.has(v.patient.id)) continue;
      seen.add(v.patient.id);
      byGender[v.patient.gender]++;
      const age = ageFrom(v.patient.dateOfBirth);
      const g = age == null ? 'غير محدد' : age <= 12 ? '0-12' : age <= 17 ? '13-17' : age <= 39 ? '18-39' : age <= 59 ? '40-59' : '60+';
      ageGroups[g]++;
    }
    res.json({
      summary: { visits: visits.length, uniquePatients: patientIds.size, newPatientsRegistered: newPatients, newPatientsSeen: newIds.size, returningPatients: patientIds.size - newIds.size },
      byDay: [...byDay.entries()].sort().map(([day, count]) => ({ day, count })),
      byGender, ageGroups,
      byVisitType: [...byType.entries()].map(([name, count]) => ({ name, count })),
      topDiagnoses: diagnoses.map((d) => ({ description: d.description, icd10Code: d.icd10Code, count: d._count })),
      rows: visits.map((v) => ({ ...v, isNew: v.patient.createdAt >= from })),
      truncated: visits.length >= LIMIT,
    });
  }),
);

// ── Doctors ──
reportsRouter.get(
  '/doctors',
  requirePerm('reports.doctors'),
  ah(async (req, res) => {
    const q = parse(rangeQuery, req.query);
    const { from, to } = rangeFromQuery(q.from, q.to);
    const rows = await prisma.$queryRaw<{ doctorId: string; fullName: string; specialty: string | null; visits: bigint; patients: bigint; completed: bigint; avgMinutes: number | null }[]>`
      SELECT u.id AS "doctorId", u."fullName", u.specialty,
             COUNT(v.id) AS visits, COUNT(DISTINCT v."patientId") AS patients,
             COUNT(v.id) FILTER (WHERE v.status = 'COMPLETED') AS completed,
             AVG(EXTRACT(EPOCH FROM (v."completedAt" - v."doctorStartedAt")) / 60) FILTER (WHERE v."completedAt" IS NOT NULL AND v."doctorStartedAt" IS NOT NULL) AS "avgMinutes"
      FROM users u
      LEFT JOIN visits v ON v."doctorId" = u.id AND v."queueDate" BETWEEN ${dateOnly(q.from)} AND ${dateOnly(q.to)} AND v.status NOT IN ('CANCELLED', 'NO_SHOW')
      WHERE u."staffType" = 'DOCTOR' AND u."deletedAt" IS NULL ${q.doctorId ? Prisma.sql`AND u.id = ${q.doctorId}` : Prisma.empty}
      GROUP BY u.id ORDER BY visits DESC`;
    const revenue = await prisma.invoice.groupBy({
      by: ['doctorId'], where: { status: { notIn: ['DRAFT', 'CANCELLED'] }, issuedAt: { gte: from, lte: to } },
      _sum: { total: true, paidAmount: true, refundedAmount: true, balance: true }, _count: true,
    });
    res.json({
      rows: rows.map((r) => {
        const rev = revenue.find((x) => x.doctorId === r.doctorId);
        return {
          doctorId: r.doctorId, fullName: r.fullName, specialty: r.specialty, visits: Number(r.visits), patients: Number(r.patients), completed: Number(r.completed),
          avgMinutes: r.avgMinutes ? Math.round(Number(r.avgMinutes)) : null,
          invoices: rev?._count ?? 0, revenue: num(rev?._sum.total), collected: num(rev?._sum.paidAmount) - num(rev?._sum.refundedAmount), outstanding: num(rev?._sum.balance),
        };
      }),
    });
  }),
);

// ── Financial ──
reportsRouter.get(
  '/financial',
  requirePerm('reports.financial'),
  ah(async (req, res) => {
    const q = parse(rangeQuery, req.query);
    const { from, to } = rangeFromQuery(q.from, q.to);
    const [summary, byCategory, expensesByCategory, invoices, discounts] = await Promise.all([
      financialSummary(from, to),
      prisma.$queryRaw<{ category: string; amount: Prisma.Decimal; qty: Prisma.Decimal }[]>`
        SELECT ii.category, SUM(ii."lineTotal") AS amount, SUM(ii.quantity) AS qty FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId"
        WHERE i.status NOT IN ('DRAFT', 'CANCELLED') AND i."issuedAt" BETWEEN ${from} AND ${to} GROUP BY ii.category ORDER BY amount DESC`,
      prisma.$queryRaw<{ name: string; amount: Prisma.Decimal; count: bigint }[]>`
        SELECT c.name, SUM(e.amount) AS amount, COUNT(*) AS count FROM expenses e JOIN expense_categories c ON c.id = e."categoryId"
        WHERE e."voidedAt" IS NULL AND e."expenseDate" BETWEEN ${dateOnly(q.from)} AND ${dateOnly(q.to)} GROUP BY c.name ORDER BY amount DESC`,
      prisma.invoice.findMany({
        where: { status: { notIn: ['DRAFT'] }, issuedAt: { gte: from, lte: to }, ...(q.doctorId && { doctorId: q.doctorId }) },
        orderBy: { issuedAt: 'desc' }, take: LIMIT,
        select: {
          id: true, invoiceNumber: true, issuedAt: true, status: true, subtotal: true, discountTotal: true, taxTotal: true, total: true, paidAmount: true, refundedAmount: true, balance: true,
          patient: { select: { fullName: true, fileNumber: true } }, doctor: { select: { fullName: true } },
        },
      }),
      prisma.invoice.findMany({
        where: { status: { notIn: ['DRAFT', 'CANCELLED'] }, issuedAt: { gte: from, lte: to }, discountTotal: { gt: 0 } },
        select: { id: true, invoiceNumber: true, issuedAt: true, discountTotal: true, subtotal: true, patient: { select: { fullName: true } }, createdById: true },
        orderBy: { discountTotal: 'desc' }, take: 200,
      }),
    ]);
    res.json({
      summary,
      revenueByCategory: byCategory.map((c) => ({ category: c.category, amount: num(c.amount), quantity: num(c.qty) })),
      expensesByCategory: expensesByCategory.map((e) => ({ name: e.name, amount: num(e.amount), count: Number(e.count) })),
      invoices,
      discounts,
    });
  }),
);

// ── Inventory ──
reportsRouter.get(
  '/inventory',
  requirePerm('reports.inventory'),
  ah(async (req, res) => {
    const q = parse(rangeQuery, req.query);
    const { from, to } = rangeFromQuery(q.from, q.to);
    const { expiryAlertDays } = await getSetting('inventory');
    const today = dateOnly();
    const [items, movements, counts] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: { deletedAt: null, isActive: true, ...(q.q && { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { sku: { contains: q.q, mode: 'insensitive' } }] }) },
        include: { category: { select: { name: true } }, unit: { select: { symbol: true, name: true } }, supplier: { select: { name: true } } },
        orderBy: { name: 'asc' }, take: LIMIT,
      }),
      prisma.inventoryTransaction.groupBy({ by: ['type'], where: { createdAt: { gte: from, lte: to } }, _sum: { quantity: true }, _count: true }),
      prisma.stockCount.findMany({
        where: { createdAt: { gte: from, lte: to } },
        include: { items: { where: { difference: { not: 0 } }, include: { item: { select: { name: true, purchasePrice: true } } } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const soon = addDays(today, expiryAlertDays);
    const rows = items.map((i) => ({
      ...i,
      value: num(i.quantity) * num(i.purchasePrice),
      isLow: num(i.quantity) <= num(i.minQuantity),
      isExpired: !!i.expiryDate && i.expiryDate < today,
      isExpiring: !!i.expiryDate && i.expiryDate >= today && i.expiryDate <= soon,
    }));
    res.json({
      summary: {
        items: rows.length, stockValue: rows.reduce((a, r) => a + r.value, 0), low: rows.filter((r) => r.isLow).length,
        expired: rows.filter((r) => r.isExpired).length, expiring: rows.filter((r) => r.isExpiring).length,
      },
      rows,
      movements: movements.map((m) => ({ type: m.type, count: m._count, quantity: num(m._sum.quantity) })),
      stockCounts: counts.map((c) => ({
        id: c.id, countNumber: c.countNumber, status: c.status, createdAt: c.createdAt, approvedAt: c.approvedAt,
        differences: c.items.map((i) => ({ name: i.item.name, system: num(i.systemQuantity), counted: num(i.countedQuantity), difference: num(i.difference), value: num(i.difference) * num(i.item.purchasePrice) })),
      })),
    });
  }),
);

// ── Attendance ──
reportsRouter.get(
  '/attendance',
  requirePerm('reports.attendance'),
  ah(async (req, res) => {
    const q = parse(rangeQuery.extend({ userId: z.string().uuid().optional() }), req.query);
    const range = { gte: dateOnly(q.from), lte: dateOnly(q.to) };
    const [users, assignments, attendance, leaves] = await Promise.all([
      prisma.user.findMany({ where: { deletedAt: null, ...(q.userId && { id: q.userId }) }, select: { id: true, fullName: true, staffType: true }, orderBy: { fullName: 'asc' } }),
      prisma.shiftAssignment.groupBy({ by: ['userId'], where: { date: range }, _count: true }),
      prisma.attendance.findMany({ where: { date: range }, select: { userId: true, status: true, lateMinutes: true, earlyLeaveMinutes: true, workedMinutes: true } }),
      prisma.leave.findMany({ where: { status: 'APPROVED', startDate: { lte: range.lte }, endDate: { gte: range.gte } } }),
    ]);
    const rows = users
      .map((u) => {
        const recs = attendance.filter((a) => a.userId === u.id);
        const leaveDays = leaves.filter((l) => l.userId === u.id).reduce((a, l) => {
          const s = l.startDate > range.gte ? l.startDate : range.gte;
          const e = l.endDate < range.lte ? l.endDate : range.lte;
          return a + Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
        }, 0);
        return {
          userId: u.id, fullName: u.fullName, staffType: u.staffType,
          scheduled: assignments.find((a) => a.userId === u.id)?._count ?? 0,
          present: recs.filter((r) => ['PRESENT', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY'].includes(r.status)).length,
          late: recs.filter((r) => r.lateMinutes > 0).length,
          lateMinutes: recs.reduce((a, r) => a + r.lateMinutes, 0),
          earlyLeave: recs.filter((r) => r.earlyLeaveMinutes > 0).length,
          earlyLeaveMinutes: recs.reduce((a, r) => a + r.earlyLeaveMinutes, 0),
          absent: recs.filter((r) => r.status === 'ABSENT').length,
          leaveDays,
          workedHours: Math.round((recs.reduce((a, r) => a + r.workedMinutes, 0) / 60) * 10) / 10,
        };
      })
      .filter((r) => q.userId || r.scheduled || r.present || r.absent || r.leaveDays);
    res.json({ rows });
  }),
);
