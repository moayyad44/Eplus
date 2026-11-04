-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "AccountNature" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('GENERAL', 'OPENING', 'ADJUSTMENT', 'CLOSING', 'EXPENSE', 'REVENUE', 'RECEIPT', 'PAYMENT', 'PAYROLL', 'PURCHASE', 'CHEQUE', 'BANK_RECONCILIATION', 'DEPRECIATION', 'CORRECTION');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED', 'DELETED');

-- CreateTable
CREATE TABLE "acc_accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "nature" "AccountNature" NOT NULL,
    "parentId" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "systemKey" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_fiscal_years" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FiscalStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_fiscal_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_fiscal_periods" (
    "id" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FiscalStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" TEXT,
    "reopenReason" TEXT,

    CONSTRAINT "acc_fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_journal_entries" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "JournalType" NOT NULL DEFAULT 'GENERAL',
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceKey" TEXT,
    "totalDebit" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_journal_lines" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "description" TEXT,
    "partyType" TEXT,
    "partyId" TEXT,
    "partyName" TEXT,
    "doctorId" TEXT,

    CONSTRAINT "acc_journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_journal_revisions" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changes" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_journal_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acc_accounts_code_key" ON "acc_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "acc_accounts_systemKey_key" ON "acc_accounts"("systemKey");

-- CreateIndex
CREATE INDEX "acc_accounts_parentId_idx" ON "acc_accounts"("parentId");

-- CreateIndex
CREATE INDEX "acc_accounts_type_idx" ON "acc_accounts"("type");

-- CreateIndex
CREATE UNIQUE INDEX "acc_fiscal_years_startDate_key" ON "acc_fiscal_years"("startDate");

-- CreateIndex
CREATE INDEX "acc_fiscal_periods_startDate_endDate_idx" ON "acc_fiscal_periods"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "acc_fiscal_periods_fiscalYearId_startDate_key" ON "acc_fiscal_periods"("fiscalYearId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "acc_journal_entries_number_key" ON "acc_journal_entries"("number");

-- CreateIndex
CREATE UNIQUE INDEX "acc_journal_entries_sourceKey_key" ON "acc_journal_entries"("sourceKey");

-- CreateIndex
CREATE INDEX "acc_journal_entries_date_idx" ON "acc_journal_entries"("date");

-- CreateIndex
CREATE INDEX "acc_journal_entries_status_date_idx" ON "acc_journal_entries"("status", "date");

-- CreateIndex
CREATE INDEX "acc_journal_entries_sourceType_sourceId_idx" ON "acc_journal_entries"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "acc_journal_lines_entryId_idx" ON "acc_journal_lines"("entryId");

-- CreateIndex
CREATE INDEX "acc_journal_lines_accountId_idx" ON "acc_journal_lines"("accountId");

-- CreateIndex
CREATE INDEX "acc_journal_lines_partyType_partyId_idx" ON "acc_journal_lines"("partyType", "partyId");

-- CreateIndex
CREATE INDEX "acc_journal_revisions_entryId_idx" ON "acc_journal_revisions"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_journal_revisions_entryId_version_action_key" ON "acc_journal_revisions"("entryId", "version", "action");

-- AddForeignKey
ALTER TABLE "acc_accounts" ADD CONSTRAINT "acc_accounts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "acc_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_fiscal_periods" ADD CONSTRAINT "acc_fiscal_periods_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "acc_fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_journal_lines" ADD CONSTRAINT "acc_journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "acc_journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_journal_lines" ADD CONSTRAINT "acc_journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "acc_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_journal_revisions" ADD CONSTRAINT "acc_journal_revisions_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "acc_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───── Rules enforced by the database itself ─────

-- A line is either a debit or a credit, never negative, never both, never zero.
ALTER TABLE "acc_journal_lines" ADD CONSTRAINT "acc_line_one_side" CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0)));
ALTER TABLE "acc_fiscal_years" ADD CONSTRAINT "acc_year_dates" CHECK ("endDate" > "startDate");
ALTER TABLE "acc_fiscal_periods" ADD CONSTRAINT "acc_period_dates" CHECK ("endDate" >= "startDate");

-- A posted entry must balance (checked at commit, so its lines can be written in any order).
CREATE OR REPLACE FUNCTION acc_check_balance() RETURNS trigger AS $$
DECLARE eid TEXT; st "JournalStatus"; d NUMERIC; c NUMERIC; n INT; td NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'acc_journal_entries' THEN eid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN eid := OLD."entryId";
  ELSE eid := NEW."entryId"; END IF;
  SELECT status, "totalDebit" INTO st, td FROM acc_journal_entries WHERE id = eid;
  IF st IS NULL OR st <> 'POSTED' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*) INTO d, c, n FROM acc_journal_lines WHERE "entryId" = eid;
  IF n < 2 OR d <> c OR d = 0 THEN RAISE EXCEPTION 'ACC_UNBALANCED: entry % debit % credit % lines %', eid, d, c, n; END IF;
  IF td <> d THEN RAISE EXCEPTION 'ACC_TOTAL_MISMATCH: entry %', eid; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER acc_lines_balance AFTER INSERT OR UPDATE OR DELETE ON "acc_journal_lines" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acc_check_balance();
CREATE CONSTRAINT TRIGGER acc_entries_balance AFTER INSERT OR UPDATE ON "acc_journal_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acc_check_balance();

-- Nothing is written into a closed period; a posted entry needs an open period that covers its date.
CREATE OR REPLACE FUNCTION acc_period_status(d DATE) RETURNS TEXT AS $$
  SELECT status::text FROM acc_fiscal_periods WHERE d BETWEEN "startDate" AND "endDate" ORDER BY "startDate" DESC LIMIT 1;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION acc_guard_entry() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ACC_NO_DELETE: journal entries are never removed (use status DELETED)'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' AND acc_period_status(OLD.date) = 'CLOSED' THEN
    RAISE EXCEPTION 'ACC_PERIOD_CLOSED: %', OLD.date;
  END IF;
  IF NEW.status = 'POSTED' THEN
    IF acc_period_status(NEW.date) IS NULL THEN RAISE EXCEPTION 'ACC_NO_PERIOD: %', NEW.date; END IF;
    IF acc_period_status(NEW.date) = 'CLOSED' THEN RAISE EXCEPTION 'ACC_PERIOD_CLOSED: %', NEW.date; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER acc_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON "acc_journal_entries" FOR EACH ROW EXECUTE FUNCTION acc_guard_entry();

-- Lines: only on leaf (non-group) accounts, and never inside a closed period.
CREATE OR REPLACE FUNCTION acc_guard_line() RETURNS trigger AS $$
DECLARE st "JournalStatus"; d DATE; eid TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN eid := OLD."entryId"; ELSE eid := NEW."entryId"; END IF;
  IF TG_OP <> 'DELETE' THEN
    IF (SELECT "isGroup" FROM acc_accounts WHERE id = NEW."accountId") THEN
      RAISE EXCEPTION 'ACC_GROUP_ACCOUNT: entries go to sub-accounts, not to a group account';
    END IF;
  END IF;
  SELECT status, date INTO st, d FROM acc_journal_entries WHERE id = eid;
  IF st IS NOT NULL AND st <> 'DRAFT' AND acc_period_status(d) = 'CLOSED' THEN RAISE EXCEPTION 'ACC_PERIOD_CLOSED: %', d; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER acc_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "acc_journal_lines" FOR EACH ROW EXECUTE FUNCTION acc_guard_line();

-- An account that has lines is never deleted (it can be stopped instead).
CREATE OR REPLACE FUNCTION acc_guard_account() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM acc_journal_lines WHERE "accountId" = OLD.id) THEN RAISE EXCEPTION 'ACC_ACCOUNT_USED: account % has entries', OLD.code; END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER acc_accounts_guard BEFORE DELETE ON "acc_accounts" FOR EACH ROW EXECUTE FUNCTION acc_guard_account();

-- The history of an entry is append-only.
CREATE OR REPLACE FUNCTION acc_block_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ACC_APPEND_ONLY: % is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER acc_revisions_append_only BEFORE UPDATE OR DELETE ON "acc_journal_revisions" FOR EACH ROW EXECUTE FUNCTION acc_block_change();
