import type { ReactNode } from 'react';
import {
  Activity, BarChart3, Boxes, CalendarClock, CalendarDays, ClipboardCheck, ConciergeBell, FileClock, FileText, FlaskConical, History,
  LayoutDashboard, ListOrdered, Receipt, Settings, ShoppingCart, Truck, UserCog, Users, Wallet, Clock, Plane, CreditCard, ArrowLeftRight,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string; // i18n key
  icon: ReactNode;
  any: string[]; // visible if the user holds any of these permissions
}
export interface NavSection {
  label: string;
  items: NavItem[];
}

const i = (C: typeof Activity) => <C className="h-[18px] w-[18px]" />;

export const NAV: NavSection[] = [
  {
    label: 'nav.sections.main',
    items: [
      { to: '/dashboard', label: 'nav.dashboard', icon: i(LayoutDashboard), any: ['dashboard.admin'] },
      { to: '/reception', label: 'nav.reception', icon: i(ConciergeBell), any: ['patients.create', 'queue.manage'] },
      { to: '/queue', label: 'nav.queue', icon: i(ListOrdered), any: ['queue.view'] },
      { to: '/patients', label: 'nav.patients', icon: i(Users), any: ['patients.view'] },
      { to: '/appointments', label: 'nav.appointments', icon: i(CalendarDays), any: ['appointments.view'] },
    ],
  },
  {
    label: 'nav.sections.clinical',
    items: [{ to: '/lab', label: 'nav.lab', icon: i(FlaskConical), any: ['lab.view'] }],
  },
  {
    label: 'nav.sections.finance',
    items: [
      { to: '/billing/invoices', label: 'nav.invoices', icon: i(FileText), any: ['invoices.view'] },
      { to: '/billing/outstanding', label: 'nav.outstanding', icon: i(FileClock), any: ['invoices.view'] },
      { to: '/billing/cashier', label: 'nav.cashier', icon: i(Wallet), any: ['cashier.view'] },
      { to: '/billing/payments', label: 'nav.payments', icon: i(CreditCard), any: ['cashier.view', 'payments.create'] },
      { to: '/expenses', label: 'nav.expenses', icon: i(Receipt), any: ['expenses.view'] },
    ],
  },
  {
    label: 'nav.sections.inventory',
    items: [
      { to: '/inventory/items', label: 'nav.inventory', icon: i(Boxes), any: ['inventory.view'] },
      { to: '/inventory/transactions', label: 'nav.transactions', icon: i(ArrowLeftRight), any: ['inventory.view'] },
      { to: '/inventory/stock-counts', label: 'nav.stockCounts', icon: i(ClipboardCheck), any: ['stockcount.manage'] },
      { to: '/suppliers', label: 'nav.suppliers', icon: i(Truck), any: ['suppliers.view'] },
      { to: '/purchases', label: 'nav.purchases', icon: i(ShoppingCart), any: ['suppliers.view'] },
    ],
  },
  {
    label: 'nav.sections.staff',
    items: [
      { to: '/staff/users', label: 'nav.users', icon: i(UserCog), any: ['users.view'] },
      { to: '/staff/schedule', label: 'nav.schedule', icon: i(CalendarClock), any: ['shifts.view'] },
      { to: '/staff/attendance', label: 'nav.attendance', icon: i(Clock), any: ['attendance.view'] },
      { to: '/staff/leaves', label: 'nav.leaves', icon: i(Plane), any: ['shifts.view', 'shifts.manage'] },
    ],
  },
  {
    label: 'nav.sections.system',
    items: [
      { to: '/reports', label: 'nav.reports', icon: i(BarChart3), any: ['reports.patients', 'reports.doctors', 'reports.financial', 'reports.inventory', 'reports.attendance'] },
      { to: '/audit', label: 'nav.audit', icon: i(History), any: ['audit.view'] },
      { to: '/settings', label: 'nav.settings', icon: i(Settings), any: ['settings.view', 'settings.manage'] },
    ],
  },
];

