# EmergencyPlus — نظام إدارة العيادة

**EmergencyPlus Clinic Management System** is a complete, production-oriented system for running a medical clinic end to end: reception, the waiting queue, nursing, doctor consultations, the laboratory, billing and payments, the cashier, expenses, inventory and stock counts, suppliers, staff shifts and attendance, reports, notifications and a tamper-proof audit log.

The interface is Arabic-first with full RTL support, and English can be added without code changes. The identity is a **Baby Blue** medical theme.

---

## Technology stack

| Layer | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 16** | Relational integrity for medical and financial records, row-level locking for money and stock, triggers for the append-only audit log |
| ORM / migrations | **Prisma 6** | Typed data access, versioned SQL migrations |
| API | **Node.js 22 + Express + TypeScript** | Modular REST API, Zod validation everywhere |
| Web | **React 18 + Vite + TypeScript + Tailwind CSS** | Fast SPA, lazy-loaded pages, shared design system |
| Data fetching | TanStack Query | Caching, background refresh (the queue refreshes live) |
| i18n | i18next | Arabic reference dictionary, English fallback, `dir` switching |
| Tests | Vitest + Supertest (API), Playwright (UI verification) | |

## Architecture

```
┌──────────── web (React SPA, RTL) ─────────────┐        ┌──────────── server (Express API) ────────────┐
│ pages/…  (one folder per module)              │  /api  │ middleware/auth.ts   session + permission check │
│ components/ui      design system              │ ─────▶ │ modules/<module>/    routes + services           │
│ components/shared  patient picker, dialogs…   │ cookie │ lib/                 audit, counters, money,     │
│ lib/               api client, auth, i18n     │  JWT   │                      notify, settings, storage   │
│ pages/print        A4 / thermal templates     │        │ jobs/scanner.ts      alerts & overdue invoices   │
└───────────────────────────────────────────────┘        └──────────────────────┬──────────────────────────┘
                                                                                 │ Prisma
                                                                         PostgreSQL (+ uploads dir)
```

In production the API also serves the built web app from the same origin, so cookies stay `SameSite=strict`.

```
server/
  prisma/schema.prisma        database schema (≈50 tables)
  prisma/migrations/          SQL migrations (incl. audit-log protection triggers & CHECK constraints)
  prisma/bootstrap.ts         production bootstrap: permissions, roles, settings, base catalogs, first admin
  prisma/seed-dev.ts          DEVELOPMENT ONLY demo data (refuses to run in production)
  src/modules/                auth, users, roles, settings, patients, visits (queue), clinical, lab,
                              appointments, attachments, billing (+cashier), expenses, inventory
                              (+suppliers/purchases), staff, dashboard, reports, system (notifications/audit/search)
  tests/workflow.test.ts      end-to-end API tests (31 scenarios)
web/
  src/pages/                  one folder per module
  src/i18n/ar, src/i18n/en    translations (ar = complete reference)
```

## Getting started (development)

Requirements: Node 22+, PostgreSQL 14+.

```bash
# 1. Database
createuser -P eplus         # password e.g. eplus
createdb -O eplus eplus

# 2. Configuration
cp server/.env.example server/.env    # edit DATABASE_URL / JWT_SECRET / ADMIN_PASSWORD

# 3. Install, migrate, bootstrap
npm install
npm run db:deploy -w server           # apply migrations
npm run db:bootstrap                  # permissions, roles, settings, first admin
npm run db:seed:dev                   # optional demo data (dev only)

# 4. Run API (:4000) + web (:5173, proxies /api)
npm run dev
```

Demo accounts created by `db:seed:dev` (password `Test@12345`): `dr.ahmad`, `dr.lina` (doctors), `nurse.sara`, `reception`. The admin comes from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`.

Useful scripts:

| Command | Purpose |
|---|---|
| `npm test` | API end-to-end tests (creates and drops its own throw-away database) |
| `npm run typecheck` | TypeScript for server and web |
| `npm run i18n:check -w web` | Fails if any `t('key')` used in the UI is missing from the Arabic dictionary |
| `npm run build && npm start` | Production build, then serve API + web on `:4000` |

## Production deployment

```bash
cp .env.production.example .env   # set DB_PASSWORD, JWT_SECRET (openssl rand -hex 48), ADMIN_PASSWORD
docker compose up -d --build
```

On every start the container applies pending migrations (`prisma migrate deploy`) and runs the idempotent bootstrap, which syncs permissions and never touches clinical or financial data.

- **HTTPS is required.** Put the app behind a TLS reverse proxy (nginx or Caddy) and set `TRUST_PROXY=1`. In production, cookies are `Secure` and HSTS/CSP headers are enabled.
- The server refuses to start in production with the development `JWT_SECRET`.
- Back up both the PostgreSQL volume (`pg_dump`) and the `uploads` volume (attachments).

## Roles & permissions

Permissions are enforced **on every API route** (`requirePerm`), not just by hiding buttons. The UI hides what the user can't use, and the API rejects it regardless. On every request the server re-reads the session, the user and the effective permissions, so logout, deactivation and permission changes apply immediately.

- **Roles are editable** in *Settings → Roles & Permissions* (57 permission keys grouped by module).
- **Per-user overrides** (grant or deny) sit on top of the role. For example, one doctor can be allowed to record stock movements (*Staff → Permissions*).

Default roles (bootstrap):

| Role | Can | Cannot (by default) |
|---|---|---|
| **Admin** | Everything, including users, roles, settings, audit log | — |
| **Doctor** | Patients, medical record & history, consultation, diagnosis (ICD-10), prescriptions, medical reports, lab orders & results, own queue, finish visit | Finance edits, cancelling invoices, users, permissions, inventory changes |
| **Nurse** | Full queue, call patients, vital signs, nursing procedures, lab sample/results, view medical info, view inventory | Finance, settings |
| **Receptionist** | Register/search/update patients, queue management & reordering, appointments, create invoices, record payments | Diagnoses, clinical notes, discounts, price overrides, cancelling invoices |

## Core workflow

```
Reception: phone lookup ─▶ existing / new patient ─▶ visit + doctor + priority ─▶ Queue (WAITING)
Nurse:     Call ─▶ WITH_NURSE ─▶ vital signs (BMI auto) ─▶ WITH_DOCTOR
Doctor:    history & timeline ─▶ consultation ─▶ diagnosis (ICD-10) ─▶ prescription ─▶ lab order ─▶ report ─▶ Finish ─▶ WAITING_PAYMENT
Billing:   invoice (template's mandatory items + ordered lab tests pre-filled) ─▶ issue ─▶ payment (Cash / Visa / CliQ / other)
           ─▶ receipt ─▶ fully paid ⇒ visit COMPLETED automatically; unpaid balance ⇒ Outstanding Invoices
```

The visit **state machine** (`server/src/modules/visits/stateMachine.ts`) runs `WAITING → CALLED → WITH_NURSE → WITH_DOCTOR → IN_LAB → WAITING_PAYMENT → COMPLETED`, plus `CANCELLED` and `NO_SHOW`. Skipping forward is allowed. Going backwards requires `queue.revert`. Each target status needs a specific permission. Every transition is written to `visit_status_logs` and to the audit log.

## Business rules worth knowing

- **Patients:** the phone number is the primary lookup key. Numbers are normalised (Arabic digits, `+962` / `00962` → `07…`). Duplicates are blocked for the same national ID and flagged for the same name + phone. One phone can still hold several family members.
- **Queue:** positions are ordered by priority (Emergency > Urgent > Normal), then arrival. Staff can reorder manually. Queue numbers restart daily per branch. Doctors without `queue.view_all` see only their own patients.
- **Invoices are built from catalog items only** (*Settings → Services*). **Invoice templates** define mandatory items: the default template forces the consultation fee, and the second template has no mandatory item. **All templates share one serial** (`INV-000001…`). Prices are locked unless the service allows editing or the user holds `invoices.price_override`. Discounts need `invoices.discount`.
- **Invoices are never deleted.** An issued invoice can't be edited. It is cancelled (voided) with a reason, and only after any payments are refunded. Statuses: Draft, Issued, Partially paid, Paid, Overdue (set by the scanner after `invoiceDueDays`), Cancelled, Refunded. Paid, refunded and balance amounts are always recomputed from the payment rows, under a row lock.
- **Payment methods** are managed in Settings. Visa and CliQ require a transaction reference.
- **Inventory changes only through movements** (`inventory_transactions`): purchase, receipt, issue, consumption, return, adjustment, stock count, sale. The item quantity can't be edited directly, and stock can't go negative (a DB CHECK constraint enforces this). Selling a medication on an invoice deducts stock, and cancelling the invoice restores it.
- **Stock counts** snapshot system quantities. Stock changes **only when the count is approved**, with one `STOCK_COUNT` movement per difference.
- **Purchase orders:** receiving an order creates purchase movements. Supplier balance = received POs − supplier payments.
- **Attendance:** late or early minutes are computed from the scheduled shift, with a grace period and support for overnight shifts. The scanner marks unrecorded scheduled days as absent (or as leave, if a leave was approved).
- **Audit log:** sensitive actions are logged with user, action, affected record, before/after diff, IP and device. The `audit_logs` table has DB triggers that reject `UPDATE`, `DELETE` and `TRUNCATE`, and there is no API to change it.
- **Soft delete:** users, patients, inventory items and catalog entries are archived or deactivated, never hard-deleted. Medical and financial history is preserved.

## Security

- httpOnly session cookies: a 15-minute access JWT plus a rotating refresh token, stored hashed in `sessions`. Sessions can be listed and revoked, and changing the password signs out other devices.
- bcrypt password hashing (cost 12), a password policy, a login rate limit, and a 15-minute lockout after 5 failed attempts. Newly created and reset accounts must change their password.
- CSRF protection: state-changing requests must carry an `X-Requested-With` header (not sendable cross-site without CORS), and cookies are `SameSite=strict`.
- Zod validation on every input. Parameterised queries only. Helmet (CSP, HSTS, frame protection). A global API rate limit.
- Uploads are restricted by type and size, checked by magic bytes, stored outside the web root, and served only through authorised endpoints.
- Medical data is returned only to users with `medical.view`. Reception gets demographics and visit status only.

## Printing & export

A4 print templates cover the invoice, receipt, prescription, medical report, lab request, lab result and full patient report. The invoice and receipt also have an **80 mm thermal** layout. Reports, the cashier screen, stock counts and schedules print directly; use *Save as PDF* in the print dialog for PDF. Lists and reports export to **CSV with a UTF-8 BOM**, so Excel opens the Arabic text correctly.

## Notifications

Event-driven notifications fire for new lab requests, ready results, low stock after a movement, late staff and leave requests. A background scanner (every 10 minutes, idempotent via `dedupeKey`) adds low stock, expiring or expired items, overdue invoices, upcoming appointments, ended shifts without a check-out, and auto-absence.

## Adding English (or another language)

`web/src/i18n/ar/*.ts` is the complete reference. `web/src/i18n/en/index.ts` already covers the shell, common strings and statuses, and any missing key falls back to Arabic. To finish English, mirror the remaining Arabic modules into `en/`. No component changes are needed, and switching the language flips `dir` automatically.

## Designed for growth

- **Multi-branch:** `branches` plus a `branchId` on visits, appointments, invoices and expenses. Queue numbering is per branch.
- **Mobile app / patient portal:** the API also accepts `Authorization: Bearer` tokens (login with `tokenInBody`), so non-browser clients work without cookies.
- **Integrations:** notifications are centralised (`lib/notify.ts`), making SMS, WhatsApp or email a new channel. File storage sits behind an interface (`lib/storage.ts`), ready for S3. Payment methods are data, so a gateway can be added. Services map to categories for accounting export. The lab module works with an order/result model suitable for an external LIS.
- **Insurance:** invoices have templates, per-line discounts and tax, which is the natural place for payer or coverage lines.

## API overview

All endpoints are under `/api` and require authentication except `/auth/*`, `/health` and `/public/*`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me`, `/auth/session`, `POST /auth/change-password`, `GET/DELETE /auth/sessions` |
| Users & roles | `/users` (CRUD, `/:id/reset-password`, `/:id/permissions`), `/users/lookup`, `/roles`, `/roles/permissions` |
| Settings | `/settings`, `/settings/:key`, `/settings/public`, `/settings/logo`, catalogs: `visit-types`, `services`, `payment-methods`, `invoice-templates`, `lab-tests`, `diagnosis-codes`, `drugs`, `units`, `inventory-categories`, `expense-categories`, `shifts` |
| Patients | `/patients` (search), `/patients/lookup?phone=`, `/patients/:id`, `…/allergies`, `…/histories`, `…/medications`, `…/visits`, `…/timeline`, `…/reports` |
| Queue & visits | `POST /visits`, `GET /visits/queue`, `GET/PUT /visits/:id`, `POST /visits/:id/status`, `/move`, `/finish` |
| Clinical | `/visits/:id/vitals`, `/nursing-notes`, `/consultation`, `/diagnoses`, `/prescriptions`, `/reports`; `/prescriptions/:id`, `/medical-reports/:id` |
| Lab | `/lab/orders`, `/lab/orders/:id`, `/status`, `/results` |
| Appointments | `/appointments`, `/:id`, `/:id/status`, `/:id/check-in` |
| Billing | `/billing/invoices` (+`/outstanding`, `/suggest`, `/:id/issue`, `/:id/cancel`, `/:id/payments`, `/:id/refunds`), `/billing/payments`, `/billing/payments/:id/void`, `/cashier/summary` |
| Expenses | `/expenses`, `/expenses/:id/void` |
| Inventory | `/inventory/items`, `/inventory/transactions`, `/inventory/stock-counts` (+`/items`, `/approve`, `/cancel`), `/suppliers` (+`/payments`), `/purchases` (+`/status`) |
| Staff | `/staff/schedule` (+`/bulk`), `/staff/leaves`, `/staff/attendance` (+`/check-in`, `/check-out`, `/me`) |
| Insight | `/dashboard/admin`, `/dashboard/me`, `/reports/{patients,doctors,financial,inventory,attendance}`, `/notifications`, `/audit-logs`, `/search` |
| Files | `/attachments` (upload/list), `/attachments/:id/file` |
