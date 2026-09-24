/**
 * English translation. Arabic (ar/) is the complete reference; keys missing here fall back to Arabic.
 * To complete English, mirror the remaining ar/*.ts modules here — no code changes are needed.
 */
export default {
  app: { name: 'EmergencyPlus', tagline: 'Clinic Management System' },
  common: {
    save: 'Save', saveChanges: 'Save changes', cancel: 'Cancel', close: 'Close', add: 'Add', edit: 'Edit', delete: 'Delete', remove: 'Remove', confirm: 'Confirm', back: 'Back',
    search: 'Search', searchPlaceholder: 'Search…', filter: 'Filter', all: 'All', yes: 'Yes', no: 'No', loading: 'Loading…', saving: 'Saving…', saved: 'Saved successfully',
    created: 'Created successfully', updated: 'Updated successfully', actions: 'Actions', details: 'Details', view: 'View', open: 'Open', print: 'Print', export: 'Export',
    exportCsv: 'Excel / CSV', exportPdf: 'PDF', refresh: 'Refresh', retry: 'Retry', next: 'Next', previous: 'Previous', notes: 'Notes', reason: 'Reason', description: 'Description',
    date: 'Date', time: 'Time', from: 'From', to: 'To', today: 'Today', yesterday: 'Yesterday', thisWeek: 'This week', thisMonth: 'This month', lastMonth: 'Last month',
    custom: 'Custom', status: 'Status', type: 'Type', name: 'Name', phone: 'Phone', email: 'Email', address: 'Address', active: 'Active', inactive: 'Inactive', total: 'Total',
    amount: 'Amount', quantity: 'Qty', price: 'Price', createdAt: 'Created', createdBy: 'By', user: 'User', none: '—', optional: 'Optional', required: 'Required',
    noResults: 'No results', noData: 'No data yet', errorTitle: 'Could not load data', showing: 'Showing {{from}}–{{to}} of {{total}}', page: 'Page {{page}} of {{count}}',
    perPage: 'Per page', select: 'Select…', selectAll: 'Select all', clear: 'Clear', apply: 'Apply', minutes: 'min', hours: 'hours', days: 'days', years: 'years',
    yearsOld: '{{age}} y', unknown: 'Unknown', more: 'More', less: 'Less', confirmTitle: 'Confirm', confirmDelete: 'Are you sure? This cannot be undone.', done: 'Done',
    code: 'Code', category: 'Category', upload: 'Upload', download: 'Download', attachments: 'Attachments', noAttachments: 'No attachments', language: 'Language',
    showInactive: 'Show inactive', reference: 'Reference', paymentMethod: 'Payment method', doctor: 'Doctor', patient: 'Patient', balance: 'Balance', paid: 'Paid',
    viewAll: 'View all', archive: 'Archive', deactivate: 'Deactivate', activate: 'Activate', fieldRequired: 'This field is required',
    permissionDenied: 'You do not have permission to access this page', goHome: 'Go home', notFound: 'Page not found', item: 'Item', items: 'Items', discount: 'Discount',
    tax: 'Tax', subtotal: 'Subtotal', unit: 'Unit', location: 'Location', supplier: 'Supplier', day: 'Day', week: 'Week', month: 'Month', list: 'List', calendar: 'Calendar',
    generatedAt: 'Generated', printedBy: 'Printed by',
  },
  nav: {
    sections: { main: 'Main', clinical: 'Clinical', finance: 'Finance', inventory: 'Inventory', staff: 'Staff', system: 'System' },
    dashboard: 'Dashboard', home: 'Home', reception: 'Reception', queue: 'Queue', patients: 'Patients', appointments: 'Appointments', lab: 'Laboratory', invoices: 'Invoices',
    newInvoice: 'New invoice', outstanding: 'Outstanding', cashier: 'Cashier', payments: 'Payments', expenses: 'Expenses', inventory: 'Items', transactions: 'Stock movements',
    stockCounts: 'Stock counts', suppliers: 'Suppliers', purchases: 'Purchase orders', users: 'Staff & users', schedule: 'Schedule', attendance: 'Attendance', leaves: 'Leaves',
    reports: 'Reports', notifications: 'Notifications', audit: 'Audit log', settings: 'Settings', account: 'My account', logout: 'Sign out', menu: 'Menu',
  },
  topbar: {
    search: 'Search patients, invoices, items…', searchHint: 'Ctrl + K', checkIn: 'Check in', checkOut: 'Check out', checkedInAt: 'Checked in at {{time}}',
    checkedInOk: 'Checked in', checkedOutOk: 'Checked out', noNotifications: 'No new notifications', markAllRead: 'Mark all as read',
  },
  search: { title: 'Global search', placeholder: 'Phone, name, file no., invoice no.…', minChars: 'Type at least 2 characters', patients: 'Patients', invoices: 'Invoices', appointments: 'Appointments', staff: 'Staff', inventory: 'Inventory', suppliers: 'Suppliers' },
  auth: {
    title: 'Sign in', subtitle: 'Enter your credentials to continue', username: 'Username', password: 'Password', login: 'Sign in', loggingIn: 'Signing in…',
    secure: 'Secure connection — all actions are audited', changePassword: 'Change password', currentPassword: 'Current password', newPassword: 'New password',
    confirmPassword: 'Confirm password', passwordMismatch: 'Passwords do not match', passwordHint: 'At least 8 characters with a letter and a number',
    passwordChanged: 'Password changed. Other devices were signed out', mustChange: 'You must change your temporary password to continue', sessions: 'Active sessions',
    currentSession: 'This session', revoke: 'Revoke', lastUsed: 'Last used', device: 'Device', profile: 'Profile', role: 'Role', lastLogin: 'Last login',
  },
  enum: {
    VisitStatus: { WAITING: 'Waiting', CALLED: 'Called', WITH_NURSE: 'With nurse', WITH_DOCTOR: 'With doctor', IN_LAB: 'In lab', WAITING_PAYMENT: 'Waiting for payment', COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: 'No show' },
    Priority: { NORMAL: 'Normal', URGENT: 'Urgent', EMERGENCY: 'Emergency' },
    Gender: { MALE: 'Male', FEMALE: 'Female' },
    InvoiceStatus: { DRAFT: 'Draft', ISSUED: 'Issued', PARTIALLY_PAID: 'Partially paid', PAID: 'Paid', OVERDUE: 'Overdue', CANCELLED: 'Cancelled', REFUNDED: 'Refunded' },
    LabOrderStatus: { REQUESTED: 'Requested', SAMPLE_COLLECTED: 'Sample collected', PROCESSING: 'Processing', COMPLETED: 'Completed', CANCELLED: 'Cancelled' },
    AppointmentStatus: { SCHEDULED: 'Scheduled', CONFIRMED: 'Confirmed', ARRIVED: 'Arrived', COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: 'No show' },
    StaffType: { ADMIN: 'Admin', DOCTOR: 'Doctor', NURSE: 'Nurse', RECEPTIONIST: 'Receptionist', LAB_TECHNICIAN: 'Lab technician', ACCOUNTANT: 'Accountant', OTHER: 'Other' },
    ServiceCategory: { EXAMINATION: 'Examination', CONSULTATION: 'Consultation', PROCEDURE: 'Procedure', LAB: 'Lab test', NURSING: 'Nursing', MEDICATION: 'Medication', OTHER: 'Other' },
    PaymentType: { PAYMENT: 'Payment', REFUND: 'Refund' },
    AttendanceStatus: { PRESENT: 'Present', LATE: 'Late', EARLY_LEAVE: 'Early leave', LATE_AND_EARLY: 'Late & early', ABSENT: 'Absent', LEAVE: 'Leave' },
  },
};
