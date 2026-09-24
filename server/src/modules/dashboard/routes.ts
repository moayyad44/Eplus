import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { requirePerm } from '../../middleware/auth';
import { addDays, dateOnly, endOfDay, startOfDay } from '../../lib/dates';
import { getSetting } from '../../lib/settings';
import { financialSummary } from '../billing/cashier';
import { num } from '../../lib/money';
import { can } from '../../auth/context';
import { env } from '../../config/env';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/admin',
  requirePerm('dashboard.admin'),
  ah(async (_req, res) => {
    const today = dateOnly();
    const from = startOfDay(), to = endOfDay();
    const since = startOfDay(addDays(new Date(), -13));
    const { expiryAlertDays } = await getSetting('inventory');
    const [
      visitsByStatus, patientsToday, newPatients, finance, pendingLabs, upcoming, lowStock, expiring,
      doctorsOnShift, doctorsCheckedIn, visitsSeries, revenueSeries, expenseSeries, byDoctor,
    ] = await Promise.all([
      prisma.visit.groupBy({ by: ['status'], where: { queueDate: today }, _count: true }),
      prisma.visit.findMany({ where: { queueDate: today, status: { notIn: ['CANCELLED'] } }, distinct: ['patientId'], select: { patientId: true } }),
      prisma.patient.count({ where: { createdAt: { gte: from, lte: to }, deletedAt: null } }),
      financialSummary(from, to),
      prisma.labOrder.count({ where: { status: { in: ['REQUESTED', 'SAMPLE_COLLECTED', 'PROCESSING'] } } }),
      prisma.appointment.findMany({
        where: { startAt: { gte: new Date(), lte: addDays(to, 1) }, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
        include: { patient: { select: { id: true, fullName: true, phone: true } }, doctor: { select: { fullName: true } } },
        orderBy: { startAt: 'asc' }, take: 8,
      }),
      prisma.$queryRaw<{ id: string; name: string; quantity: Prisma.Decimal; minQuantity: Prisma.Decimal }[]>`
        SELECT id, name, quantity, "minQuantity" FROM inventory_items
        WHERE "deletedAt" IS NULL AND "isActive" AND quantity <= "minQuantity" ORDER BY quantity ASC LIMIT 8`,
      prisma.inventoryItem.count({ where: { deletedAt: null, isActive: true, quantity: { gt: 0 }, expiryDate: { lte: addDays(today, expiryAlertDays) } } }),
      prisma.shiftAssignment.findMany({ where: { date: today, user: { staffType: 'DOCTOR', isActive: true } }, select: { user: { select: { id: true, fullName: true, specialty: true } }, startTime: true, endTime: true } }),
      prisma.attendance.findMany({ where: { date: today, checkIn: { not: null }, checkOut: null, user: { staffType: 'DOCTOR' } }, select: { userId: true } }),
      prisma.$queryRaw<{ day: string; count: bigint }[]>`
        SELECT to_char("queueDate", 'YYYY-MM-DD') AS day, COUNT(*) AS count FROM visits
        WHERE "queueDate" >= ${dateOnly(since)} AND status <> 'CANCELLED' GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ day: string; amount: Prisma.Decimal }[]>`
        SELECT to_char(p."paidAt" AT TIME ZONE 'UTC' AT TIME ZONE ${env.TZ}, 'YYYY-MM-DD') AS day,
               SUM(CASE WHEN p.type = 'PAYMENT' THEN p.amount ELSE -p.amount END) AS amount
        FROM payments p WHERE p."voidedAt" IS NULL AND p."paidAt" >= ${since} GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ day: string; amount: Prisma.Decimal }[]>`
        SELECT to_char("expenseDate", 'YYYY-MM-DD') AS day, SUM(amount) AS amount FROM expenses
        WHERE "voidedAt" IS NULL AND "expenseDate" >= ${dateOnly(since)} GROUP BY 1 ORDER BY 1`,
      prisma.visit.groupBy({ by: ['doctorId'], where: { queueDate: today, status: { notIn: ['CANCELLED', 'NO_SHOW'] } }, _count: true }),
    ]);

    const statusCounts = Object.fromEntries(visitsByStatus.map((v) => [v.status, v._count]));
    const waiting = ['WAITING', 'CALLED', 'WITH_NURSE', 'WITH_DOCTOR', 'IN_LAB', 'WAITING_PAYMENT'].reduce((a, s) => a + (statusCounts[s] ?? 0), 0);
    const checkedIn = new Set(doctorsCheckedIn.map((d) => d.userId));
    const doctorNames = await prisma.user.findMany({ where: { id: { in: byDoctor.map((d) => d.doctorId).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });

    const days = Array.from({ length: 14 }, (_, i) => {
      const d = addDays(since, i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    const series = days.map((day) => ({
      day,
      visits: Number(visitsSeries.find((v) => v.day === day)?.count ?? 0),
      revenue: num(revenueSeries.find((v) => v.day === day)?.amount),
      expenses: num(expenseSeries.find((v) => v.day === day)?.amount),
    }));

    res.json({
      patientsToday: patientsToday.length,
      newPatientsToday: newPatients,
      visitsToday: Object.entries(statusCounts).filter(([s]) => s !== 'CANCELLED').reduce((a, [, c]) => a + c, 0),
      waiting,
      completedToday: statusCounts.COMPLETED ?? 0,
      statusCounts,
      finance,
      pendingLabs,
      upcomingAppointments: upcoming,
      lowStock: lowStock.map((i) => ({ ...i, quantity: num(i.quantity), minQuantity: num(i.minQuantity) })),
      expiringCount: expiring,
      doctorsOnShift: doctorsOnShift.map((d) => ({ ...d.user, startTime: d.startTime, endTime: d.endTime, checkedIn: checkedIn.has(d.user.id) })),
      visitsByDoctor: byDoctor.map((d) => ({ doctorId: d.doctorId, name: doctorNames.find((n) => n.id === d.doctorId)?.fullName ?? 'غير محدد', count: d._count })),
      series,
    });
  }),
);

/** Personal workload summary for doctors, nurses and reception. */
dashboardRouter.get(
  '/me',
  ah(async (req, res) => {
    const ctx = req.ctx;
    const today = dateOnly();
    const mineOnly = !can(ctx, 'queue.view_all');
    const [queue, labs, appts, results] = await Promise.all([
      can(ctx, 'queue.view')
        ? prisma.visit.groupBy({ by: ['status'], where: { queueDate: today, ...(mineOnly && { OR: [{ doctorId: ctx.userId }, { doctorId: null }] }) }, _count: true })
        : [],
      can(ctx, 'lab.process') ? prisma.labOrder.count({ where: { status: { in: ['REQUESTED', 'SAMPLE_COLLECTED', 'PROCESSING'] } } }) : null,
      can(ctx, 'appointments.view')
        ? prisma.appointment.count({ where: { startAt: { gte: startOfDay(), lte: endOfDay() }, status: { in: ['SCHEDULED', 'CONFIRMED'] }, ...(ctx.staffType === 'DOCTOR' && { doctorId: ctx.userId }) } })
        : null,
      ctx.staffType === 'DOCTOR' ? prisma.labOrder.count({ where: { doctorId: ctx.userId, status: 'COMPLETED', completedAt: { gte: startOfDay() } } }) : null,
    ]);
    res.json({ queue: Object.fromEntries(queue.map((q) => [q.status, q._count])), pendingLabs: labs, appointmentsToday: appts, resultsReadyToday: results });
  }),
);
