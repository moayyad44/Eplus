import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { addDays, dateOnly, ymd } from '../lib/dates';
import { getSetting } from '../lib/settings';
import { notifyPermission, notifyUsers, usersWithPermission } from '../lib/notify';
import { num } from '../lib/money';
import { shiftWindow } from '../modules/staff/attendance';

/**
 * Periodic scanner that turns data conditions into notifications and keeps time-based states current.
 * Idempotent: every notification carries a dedupeKey, so running it often never duplicates alerts.
 */
export async function runScan(now = new Date()) {
  const today = dateOnly(now);
  const day = ymd(now);
  const { expiryAlertDays } = await getSetting('inventory');

  // 1. Low stock (once per item per day)
  const low = await prisma.$queryRaw<{ id: string; name: string; quantity: Prisma.Decimal }[]>`
    SELECT id, name, quantity FROM inventory_items WHERE "deletedAt" IS NULL AND "isActive" AND quantity <= "minQuantity"`;
  for (const i of low) {
    await notifyPermission('inventory.view', { type: 'LOW_STOCK', title: `انخفاض مخزون: ${i.name}`, body: `الكمية الحالية ${num(i.quantity)}`, link: `/inventory/items/${i.id}`, dedupeKey: `low:${i.id}:${day}` });
  }

  // 2. Expiring / expired items (once per item per week)
  const week = `${now.getFullYear()}-w${Math.floor((now.getTime() / 86_400_000 + 4) / 7)}`;
  const expiring = await prisma.inventoryItem.findMany({
    where: { deletedAt: null, isActive: true, quantity: { gt: 0 }, expiryDate: { lte: addDays(today, expiryAlertDays) } },
    select: { id: true, name: true, expiryDate: true },
  });
  for (const i of expiring) {
    const expired = i.expiryDate! < today;
    await notifyPermission('inventory.view', {
      type: 'EXPIRY', title: `${expired ? 'صنف منتهي الصلاحية' : 'قرب انتهاء صلاحية'}: ${i.name}`, body: `تاريخ الانتهاء ${i.expiryDate!.toISOString().slice(0, 10)}`,
      link: `/inventory/items/${i.id}`, dedupeKey: `exp:${i.id}:${week}`,
    });
  }

  // 3. Overdue invoices → status OVERDUE + notification
  const overdue = await prisma.invoice.findMany({
    where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, balance: { gt: 0 }, dueDate: { lt: now } },
    select: { id: true, invoiceNumber: true, balance: true, patient: { select: { fullName: true } } },
  });
  if (overdue.length) {
    await prisma.invoice.updateMany({ where: { id: { in: overdue.map((o) => o.id) } }, data: { status: 'OVERDUE' } });
    const finance = await usersWithPermission('cashier.view');
    for (const o of overdue) {
      await notifyUsers(finance, { type: 'UNPAID_INVOICE', title: `فاتورة متأخرة ${o.invoiceNumber}`, body: `${o.patient.fullName} — المتبقي ${num(o.balance)}`, link: `/billing/invoices/${o.id}`, dedupeKey: `overdue:${o.id}` });
    }
  }

  // 4. Upcoming appointments within the next hour (doctor + reception)
  const soon = await prisma.appointment.findMany({
    where: { startAt: { gte: now, lte: new Date(now.getTime() + 60 * 60_000) }, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
    include: { patient: { select: { fullName: true } } },
  });
  if (soon.length) {
    const reception = await usersWithPermission('appointments.manage');
    for (const a of soon) {
      const t = a.startAt.toLocaleTimeString('ar-JO', { hour: '2-digit', minute: '2-digit' });
      await notifyUsers([a.doctorId, ...reception], { type: 'UPCOMING_APPOINTMENT', title: `موعد قادم الساعة ${t}`, body: a.patient.fullName, link: `/appointments?date=${ymd(a.startAt)}`, dedupeKey: `appt:${a.id}` });
    }
  }

  // 5. Shifts that ended while the employee is still checked in
  const openShifts = await prisma.shiftAssignment.findMany({
    where: { date: { gte: addDays(today, -1), lte: today }, attendance: { some: { checkIn: { not: null }, checkOut: null } } },
    include: { user: { select: { id: true, fullName: true } } },
  });
  for (const a of openShifts) {
    if (shiftWindow(a).end > now) continue;
    await notifyUsers([a.userId], { type: 'SHIFT_ENDING', title: 'انتهى الشفت', body: 'لا تنسَ تسجيل المغادرة', link: '/staff/attendance', dedupeKey: `shiftend:${a.id}` });
  }

  // 6. Yesterday's scheduled staff with no attendance record and no approved leave → ABSENT
  const yesterday = addDays(today, -1);
  const missing = await prisma.shiftAssignment.findMany({ where: { date: yesterday, attendance: { none: {} } }, select: { id: true, userId: true } });
  for (const m of missing) {
    const onLeave = await prisma.leave.findFirst({ where: { userId: m.userId, status: 'APPROVED', startDate: { lte: yesterday }, endDate: { gte: yesterday } } });
    await prisma.attendance.upsert({
      where: { userId_date: { userId: m.userId, date: yesterday } },
      create: { userId: m.userId, date: yesterday, shiftAssignmentId: m.id, status: onLeave ? 'LEAVE' : 'ABSENT', notes: 'تسجيل تلقائي' },
      update: {},
    });
  }

  // 7. Housekeeping: drop sessions expired more than 30 days ago
  await prisma.session.deleteMany({ where: { expiresAt: { lt: addDays(now, -30) } } });
}

export function startJobs() {
  const tick = () => runScan().catch((e) => console.error('[scanner]', e));
  setTimeout(tick, 10_000);
  return setInterval(tick, 10 * 60_000);
}
