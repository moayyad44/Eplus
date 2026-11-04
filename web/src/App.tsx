import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from './lib/auth';
import { setCurrency } from './lib/format';
import { AppLayout } from './components/layout/AppLayout';
import { EmptyState, PageLoader } from './components/ui';
import Login from './pages/Login';

const p = <T,>(f: () => Promise<{ default: T }>) => lazy(f as never);
const Dashboard = p(() => import('./pages/dashboard/Dashboard'));
const Reception = p(() => import('./pages/reception/Reception'));
const Queue = p(() => import('./pages/queue/Queue'));
const Patients = p(() => import('./pages/patients/Patients'));
const PatientProfile = p(() => import('./pages/patients/PatientProfile'));
const VisitWorkspace = p(() => import('./pages/visits/VisitWorkspace'));
const Appointments = p(() => import('./pages/appointments/Appointments'));
const LabOrders = p(() => import('./pages/lab/LabOrders'));
const LabOrderDetail = p(() => import('./pages/lab/LabOrderDetail'));
const Invoices = p(() => import('./pages/billing/Invoices'));
const InvoiceEditor = p(() => import('./pages/billing/InvoiceEditor'));
const InvoiceDetail = p(() => import('./pages/billing/InvoiceDetail'));
const Outstanding = p(() => import('./pages/billing/Outstanding'));
const Cashier = p(() => import('./pages/billing/Cashier'));
const Payments = p(() => import('./pages/billing/Payments'));
const Expenses = p(() => import('./pages/expenses/Expenses'));
const Items = p(() => import('./pages/inventory/Items'));
const ItemDetail = p(() => import('./pages/inventory/ItemDetail'));
const Transactions = p(() => import('./pages/inventory/Transactions'));
const StockCounts = p(() => import('./pages/inventory/StockCounts'));
const StockCountDetail = p(() => import('./pages/inventory/StockCountDetail'));
const Suppliers = p(() => import('./pages/inventory/Suppliers'));
const SupplierDetail = p(() => import('./pages/inventory/SupplierDetail'));
const Purchases = p(() => import('./pages/inventory/Purchases'));
const PurchaseOrderPage = p(() => import('./pages/inventory/PurchaseOrderPage'));
const Warehouses = p(() => import('./pages/inventory/Warehouses'));
const Transfers = p(() => import('./pages/inventory/Transfers'));
const TransferNew = p(() => import('./pages/inventory/TransferNew'));
const TransferDetail = p(() => import('./pages/inventory/TransferDetail'));
const Users = p(() => import('./pages/staff/Users'));
const Schedule = p(() => import('./pages/staff/Schedule'));
const Attendance = p(() => import('./pages/staff/Attendance'));
const Leaves = p(() => import('./pages/staff/Leaves'));
const Reports = p(() => import('./pages/reports/Reports'));
const InsuranceDashboard = p(() => import('./pages/insurance/Dashboard'));
const InsuranceClaims = p(() => import('./pages/insurance/Claims'));
const InsuranceClaimDetail = p(() => import('./pages/insurance/ClaimDetail'));
const InsuranceAuthorizations = p(() => import('./pages/insurance/Authorizations'));
const InsurancePayments = p(() => import('./pages/insurance/Payments'));
const InsuranceCompanies = p(() => import('./pages/insurance/Companies'));
const InsuranceCompanyDetail = p(() => import('./pages/insurance/CompanyDetail'));
const InsuranceReports = p(() => import('./pages/insurance/Reports'));
const EInvoicePage = p(() => import('./pages/einvoice/EInvoicePage'));
const ShiftBoard = p(() => import('./pages/staff/ShiftBoard'));
const ECoinPage = p(() => import('./pages/ecoin/ECoinPage'));
const Notifications = p(() => import('./pages/system/Notifications'));
const AuditLogs = p(() => import('./pages/system/AuditLogs'));
const Settings = p(() => import('./pages/settings/Settings'));
const Account = p(() => import('./pages/system/Account'));
const Help = p(() => import('./pages/system/Help'));
const PrintRoutes = p(() => import('./pages/print/PrintRoutes'));
const AccountingLayout = p(() => import('./pages/accounting/Layout'));
const AccDashboard = p(() => import('./pages/accounting/Dashboard'));
const AccAccounts = p(() => import('./pages/accounting/Accounts'));
const AccJournal = p(() => import('./pages/accounting/Journal'));
const AccEntry = p(() => import('./pages/accounting/JournalEntry'));
const AccStatement = p(() => import('./pages/accounting/Statement'));
const AccTrial = p(() => import('./pages/accounting/Reports').then((m) => ({ default: m.TrialBalance })));
const AccIncome = p(() => import('./pages/accounting/Reports').then((m) => ({ default: m.IncomeStatement })));
const AccBalance = p(() => import('./pages/accounting/Reports').then((m) => ({ default: m.BalanceSheet })));
const AccPeriods = p(() => import('./pages/accounting/Periods'));
const AccSettings = p(() => import('./pages/accounting/Settings'));

/** Route guard: the API enforces permissions; this just avoids showing screens the user cannot use. */
function Guard({ any, children }: { any: string[]; children: ReactNode }) {
  const { canAny } = useAuth();
  const { t } = useTranslation();
  if (!canAny(...any)) return <EmptyState icon={<ShieldAlert className="h-6 w-6" />} title={t('common.permissionDenied')} />;
  return <>{children}</>;
}

/** Landing page depends on the role: admin → dashboard, reception → reception desk, clinicians → queue. */
function Home() {
  const { can, canAny } = useAuth();
  if (can('dashboard.admin')) return <Navigate to="/dashboard" replace />;
  if (canAny('patients.create', 'queue.manage')) return <Navigate to="/reception" replace />;
  if (can('queue.view')) return <Navigate to="/queue" replace />;
  if (can('lab.view')) return <Navigate to="/lab" replace />;
  if (can('invoices.view')) return <Navigate to="/billing/invoices" replace />;
  return <Navigate to="/account" replace />;
}

function NotFound() {
  const { t } = useTranslation();
  return <EmptyState title={t('common.notFound')} />;
}

export default function App() {
  const { me } = useAuth();
  const { i18n } = useTranslation();
  useEffect(() => {
    if (me) setCurrency(me.currency);
  }, [me]);
  useEffect(() => {
    document.title = `${me?.clinic.name ?? 'EmergencyPlus'} — ${i18n.language === 'en' ? 'Clinic Management' : 'نظام إدارة العيادة'}`;
  }, [me, i18n.language]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/print/*" element={<Suspense fallback={<PageLoader />}><PrintRoutes /></Suspense>} />
      <Route path="/accounting" element={<Suspense fallback={<PageLoader />}><AccountingLayout /></Suspense>}>
        <Route index element={<AccDashboard />} />
        <Route path="accounts" element={<Guard any={['accounting.accounts.view', 'accounting.journal.view']}><AccAccounts /></Guard>} />
        <Route path="journal" element={<Guard any={['accounting.journal.view']}><AccJournal /></Guard>} />
        <Route path="journal/new" element={<Guard any={['accounting.journal.create']}><AccEntry /></Guard>} />
        <Route path="journal/:id" element={<Guard any={['accounting.journal.view']}><AccEntry /></Guard>} />
        <Route path="statement" element={<Guard any={['accounting.reports.view', 'accounting.journal.view']}><AccStatement /></Guard>} />
        <Route path="trial-balance" element={<Guard any={['accounting.reports.view']}><AccTrial /></Guard>} />
        <Route path="income-statement" element={<Guard any={['accounting.reports.view']}><AccIncome /></Guard>} />
        <Route path="balance-sheet" element={<Guard any={['accounting.reports.view']}><AccBalance /></Guard>} />
        <Route path="periods" element={<AccPeriods />} />
        <Route path="settings" element={<Guard any={['accounting.settings']}><AccSettings /></Guard>} />
      </Route>
      <Route element={<AppLayout />}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Guard any={['dashboard.admin']}><Dashboard /></Guard>} />
        <Route path="reception" element={<Guard any={['patients.create', 'queue.manage']}><Reception /></Guard>} />
        <Route path="queue" element={<Guard any={['queue.view']}><Queue /></Guard>} />
        <Route path="patients" element={<Guard any={['patients.view']}><Patients /></Guard>} />
        <Route path="patients/:id" element={<Guard any={['patients.view']}><PatientProfile /></Guard>} />
        <Route path="visits/:id" element={<Guard any={['queue.view', 'patients.view', 'medical.view']}><VisitWorkspace /></Guard>} />
        <Route path="appointments" element={<Guard any={['appointments.view']}><Appointments /></Guard>} />
        <Route path="lab" element={<Guard any={['lab.view']}><LabOrders /></Guard>} />
        <Route path="lab/:id" element={<Guard any={['lab.view']}><LabOrderDetail /></Guard>} />
        <Route path="billing/invoices" element={<Guard any={['invoices.view']}><Invoices /></Guard>} />
        <Route path="billing/invoices/new" element={<Guard any={['invoices.create']}><InvoiceEditor /></Guard>} />
        <Route path="billing/invoices/:id/edit" element={<Guard any={['invoices.update']}><InvoiceEditor /></Guard>} />
        <Route path="billing/invoices/:id" element={<Guard any={['invoices.view']}><InvoiceDetail /></Guard>} />
        <Route path="billing/outstanding" element={<Guard any={['invoices.view']}><Outstanding /></Guard>} />
        <Route path="billing/cashier" element={<Guard any={['cashier.view']}><Cashier /></Guard>} />
        <Route path="billing/payments" element={<Guard any={['cashier.view', 'payments.create']}><Payments /></Guard>} />
        <Route path="einvoice" element={<Guard any={['einvoice.view', 'einvoice.settings']}><EInvoicePage /></Guard>} />
        <Route path="expenses" element={<Guard any={['expenses.view']}><Expenses /></Guard>} />
        <Route path="insurance" element={<Guard any={['insurance.report.view']}><InsuranceDashboard /></Guard>} />
        <Route path="insurance/claims" element={<Guard any={['insurance.view']}><InsuranceClaims /></Guard>} />
        <Route path="insurance/claims/:id" element={<Guard any={['insurance.view']}><InsuranceClaimDetail /></Guard>} />
        <Route path="insurance/authorizations" element={<Guard any={['insurance.view']}><InsuranceAuthorizations /></Guard>} />
        <Route path="insurance/payments" element={<Guard any={['insurance.payment.create', 'insurance.payment.void', 'insurance.report.view']}><InsurancePayments /></Guard>} />
        <Route path="insurance/companies" element={<Guard any={['insurance.view']}><InsuranceCompanies /></Guard>} />
        <Route path="insurance/companies/:id" element={<Guard any={['insurance.view']}><InsuranceCompanyDetail /></Guard>} />
        <Route path="insurance/reports" element={<Guard any={['insurance.report.view']}><InsuranceReports /></Guard>} />
        <Route path="inventory/items" element={<Guard any={['inventory.view']}><Items /></Guard>} />
        <Route path="inventory/items/:id" element={<Guard any={['inventory.view']}><ItemDetail /></Guard>} />
        <Route path="inventory/transactions" element={<Guard any={['inventory.view']}><Transactions /></Guard>} />
        <Route path="inventory/warehouses" element={<Guard any={['inventory.view']}><Warehouses /></Guard>} />
        <Route path="inventory/transfers" element={<Guard any={['inventory.view', 'inventory.transfer']}><Transfers /></Guard>} />
        <Route path="inventory/transfers/new" element={<Guard any={['inventory.transfer']}><TransferNew /></Guard>} />
        <Route path="inventory/transfers/:id" element={<Guard any={['inventory.view', 'inventory.transfer']}><TransferDetail /></Guard>} />
        <Route path="inventory/stock-counts" element={<Guard any={['stockcount.manage', 'inventory.view']}><StockCounts /></Guard>} />
        <Route path="inventory/stock-counts/:id" element={<Guard any={['stockcount.manage', 'inventory.view']}><StockCountDetail /></Guard>} />
        <Route path="suppliers" element={<Guard any={['suppliers.view']}><Suppliers /></Guard>} />
        <Route path="suppliers/:id" element={<Guard any={['suppliers.view']}><SupplierDetail /></Guard>} />
        <Route path="purchases" element={<Guard any={['suppliers.view']}><Purchases /></Guard>} />
        <Route path="purchases/:id" element={<Guard any={['suppliers.view']}><PurchaseOrderPage /></Guard>} />
        <Route path="staff/users" element={<Guard any={['users.view']}><Users /></Guard>} />
        <Route path="staff/schedule" element={<Guard any={['shifts.view']}><Schedule /></Guard>} />
        <Route path="staff/board" element={<Guard any={['shifts.view']}><ShiftBoard /></Guard>} />
        <Route path="ecoin" element={<Guard any={['ecoin.use', 'ecoin.view_all', 'ecoin.manage']}><ECoinPage /></Guard>} />
        <Route path="staff/attendance" element={<Guard any={['attendance.view']}><Attendance /></Guard>} />
        <Route path="staff/leaves" element={<Guard any={['shifts.view', 'shifts.manage']}><Leaves /></Guard>} />
        <Route path="reports" element={<Guard any={['reports.patients', 'reports.doctors', 'reports.financial', 'reports.inventory', 'reports.attendance']}><Reports /></Guard>} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="audit" element={<Guard any={['audit.view']}><AuditLogs /></Guard>} />
        <Route path="settings" element={<Guard any={['settings.view', 'settings.manage']}><Settings /></Guard>} />
        <Route path="account" element={<Account />} />
        <Route path="help" element={<Help />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
