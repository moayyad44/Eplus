-- CreateEnum
CREATE TYPE "TreasuryKind" AS ENUM ('CASH', 'BANK');

-- CreateEnum
CREATE TYPE "VoucherKind" AS ENUM ('RECEIPT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "VoucherMethod" AS ENUM ('CASH', 'VISA', 'CLIQ', 'TRANSFER', 'CHEQUE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VisaStatus" AS ENUM ('PENDING', 'PARTIAL', 'SETTLED', 'CANCELLED', 'REFUNDED', 'REVIEW');

-- CreateEnum
CREATE TYPE "ChequeDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "ChequeStatus" AS ENUM ('RECEIVED', 'IN_SAFE', 'READY', 'DEPOSITED', 'UNDER_COLLECTION', 'COLLECTED', 'BOUNCED', 'CANCELLED', 'REPLACED', 'RETURNED_TO_OWNER', 'DRAFT', 'ISSUED', 'DELIVERED', 'DUE', 'CLEARED', 'STOPPED');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'DISPOSED', 'SOLD');

-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('STRAIGHT_LINE', 'DECLINING');

-- AlterTable
ALTER TABLE "acc_journal_lines" ADD COLUMN     "reconId" TEXT,
ADD COLUMN     "reconciledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "acc_treasuries" (
    "id" TEXT NOT NULL,
    "kind" "TreasuryKind" NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "custodianId" TEXT,
    "bankName" TEXT,
    "branch" TEXT,
    "accountNumber" TEXT,
    "iban" TEXT,
    "holderName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'JOD',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_treasuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_vouchers" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "VoucherKind" NOT NULL,
    "date" DATE NOT NULL,
    "method" "VoucherMethod" NOT NULL,
    "treasuryId" TEXT,
    "amount" DECIMAL(14,3) NOT NULL,
    "counterAccountId" TEXT NOT NULL,
    "partyType" TEXT,
    "partyId" TEXT,
    "partyName" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "chequeId" TEXT,
    "status" "DocStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_treasury_transfers" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "fee" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "notes" TEXT,
    "status" "DocStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_treasury_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_cash_counts" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "denominations" JSONB NOT NULL,
    "counted" DECIMAL(14,3) NOT NULL,
    "book" DECIMAL(14,3) NOT NULL,
    "difference" DECIMAL(14,3) NOT NULL,
    "reason" TEXT,
    "isClose" BOOLEAN NOT NULL DEFAULT false,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "countedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_cash_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_doc_revisions" (
    "id" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changes" JSONB,
    "reason" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_doc_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_visa_transactions" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "settled" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "posReference" TEXT,
    "terminal" TEXT,
    "provider" TEXT,
    "invoiceNumber" TEXT,
    "patientName" TEXT,
    "recordedBy" TEXT,
    "status" "VisaStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_visa_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_visa_settlements" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "gross" DECIMAL(14,3) NOT NULL,
    "fee" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" "DocStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_visa_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_visa_settlement_lines" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "acc_visa_settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_cheques" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "direction" "ChequeDirection" NOT NULL,
    "number" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "drawer" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "accountNumber" TEXT,
    "issueDate" DATE,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JOD',
    "reason" TEXT,
    "reference" TEXT,
    "treasuryId" TEXT,
    "counterAccountId" TEXT NOT NULL,
    "status" "ChequeStatus" NOT NULL,
    "depositId" TEXT,
    "replacedById" TEXT,
    "fees" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_cheques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_cheque_events" (
    "id" TEXT NOT NULL,
    "chequeId" TEXT NOT NULL,
    "fromStatus" "ChequeStatus",
    "toStatus" "ChequeStatus" NOT NULL,
    "date" DATE NOT NULL,
    "treasuryId" TEXT,
    "fee" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_cheque_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_cheque_deposits" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "slipNumber" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "total" DECIMAL(14,3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_cheque_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_cheque_counts" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "lines" JSONB NOT NULL,
    "extra" JSONB,
    "notes" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "countedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_cheque_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_salary_profiles" (
    "userId" TEXT NOT NULL,
    "jobTitle" TEXT,
    "basic" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "allowances" JSONB NOT NULL DEFAULT '[]',
    "paymentMethod" TEXT NOT NULL DEFAULT 'TRANSFER',
    "treasuryId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_salary_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "acc_payroll_runs" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDate" DATE,
    "paidDate" DATE,
    "treasuryId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_payslips" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobTitle" TEXT,
    "basic" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "allowances" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "commission" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "bonus" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "overtime" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "absenceDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "absenceDeduction" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "advance" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "net" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "acc_payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_employee_advances" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(12,3) NOT NULL,
    "installment" DECIMAL(12,3) NOT NULL,
    "recovered" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "treasuryId" TEXT NOT NULL,
    "notes" TEXT,
    "status" "DocStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_employee_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_fixed_assets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "purchaseDate" DATE NOT NULL,
    "cost" DECIMAL(14,3) NOT NULL,
    "salvage" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "rate" DECIMAL(6,2),
    "supplierId" TEXT,
    "fundingAccountId" TEXT NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "disposedAt" DATE,
    "proceeds" DECIMAL(14,3),
    "proceedsAccountId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_asset_depreciations" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "acc_asset_depreciations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_bank_reconciliations" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "statementDate" DATE NOT NULL,
    "statementBalance" DECIMAL(14,3) NOT NULL,
    "bookBalance" DECIMAL(14,3) NOT NULL,
    "lines" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_bank_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acc_treasuries_accountId_key" ON "acc_treasuries"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_vouchers_number_key" ON "acc_vouchers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "acc_vouchers_chequeId_key" ON "acc_vouchers"("chequeId");

-- CreateIndex
CREATE INDEX "acc_vouchers_date_idx" ON "acc_vouchers"("date");

-- CreateIndex
CREATE INDEX "acc_vouchers_kind_date_idx" ON "acc_vouchers"("kind", "date");

-- CreateIndex
CREATE INDEX "acc_vouchers_treasuryId_idx" ON "acc_vouchers"("treasuryId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_treasury_transfers_number_key" ON "acc_treasury_transfers"("number");

-- CreateIndex
CREATE INDEX "acc_treasury_transfers_date_idx" ON "acc_treasury_transfers"("date");

-- CreateIndex
CREATE UNIQUE INDEX "acc_cash_counts_number_key" ON "acc_cash_counts"("number");

-- CreateIndex
CREATE INDEX "acc_cash_counts_treasuryId_date_idx" ON "acc_cash_counts"("treasuryId", "date");

-- CreateIndex
CREATE INDEX "acc_doc_revisions_docType_docId_idx" ON "acc_doc_revisions"("docType", "docId");

-- CreateIndex
CREATE INDEX "acc_visa_transactions_status_date_idx" ON "acc_visa_transactions"("status", "date");

-- CreateIndex
CREATE INDEX "acc_visa_transactions_posReference_idx" ON "acc_visa_transactions"("posReference");

-- CreateIndex
CREATE UNIQUE INDEX "acc_visa_transactions_sourceType_sourceId_key" ON "acc_visa_transactions"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_visa_settlements_number_key" ON "acc_visa_settlements"("number");

-- CreateIndex
CREATE INDEX "acc_visa_settlements_date_idx" ON "acc_visa_settlements"("date");

-- CreateIndex
CREATE INDEX "acc_visa_settlement_lines_transactionId_idx" ON "acc_visa_settlement_lines"("transactionId");

-- CreateIndex
CREATE INDEX "acc_visa_settlement_lines_settlementId_idx" ON "acc_visa_settlement_lines"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_cheques_ref_key" ON "acc_cheques"("ref");

-- CreateIndex
CREATE INDEX "acc_cheques_status_dueDate_idx" ON "acc_cheques"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "acc_cheques_direction_bankName_number_key" ON "acc_cheques"("direction", "bankName", "number");

-- CreateIndex
CREATE INDEX "acc_cheque_events_chequeId_idx" ON "acc_cheque_events"("chequeId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_cheque_deposits_number_key" ON "acc_cheque_deposits"("number");

-- CreateIndex
CREATE UNIQUE INDEX "acc_cheque_counts_number_key" ON "acc_cheque_counts"("number");

-- CreateIndex
CREATE UNIQUE INDEX "acc_payroll_runs_month_key" ON "acc_payroll_runs"("month");

-- CreateIndex
CREATE UNIQUE INDEX "acc_payslips_runId_userId_key" ON "acc_payslips"("runId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_employee_advances_number_key" ON "acc_employee_advances"("number");

-- CreateIndex
CREATE INDEX "acc_employee_advances_userId_idx" ON "acc_employee_advances"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_fixed_assets_code_key" ON "acc_fixed_assets"("code");

-- CreateIndex
CREATE INDEX "acc_asset_depreciations_month_idx" ON "acc_asset_depreciations"("month");

-- CreateIndex
CREATE UNIQUE INDEX "acc_asset_depreciations_assetId_month_key" ON "acc_asset_depreciations"("assetId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "acc_bank_reconciliations_number_key" ON "acc_bank_reconciliations"("number");

-- AddForeignKey
ALTER TABLE "acc_visa_settlement_lines" ADD CONSTRAINT "acc_visa_settlement_lines_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "acc_visa_settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_visa_settlement_lines" ADD CONSTRAINT "acc_visa_settlement_lines_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "acc_visa_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_cheque_events" ADD CONSTRAINT "acc_cheque_events_chequeId_fkey" FOREIGN KEY ("chequeId") REFERENCES "acc_cheques"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_payslips" ADD CONSTRAINT "acc_payslips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "acc_payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_asset_depreciations" ADD CONSTRAINT "acc_asset_depreciations_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "acc_fixed_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───── Rules enforced by the database ─────
ALTER TABLE "acc_vouchers" ADD CONSTRAINT "acc_voucher_amount" CHECK ("amount" > 0);
ALTER TABLE "acc_treasury_transfers" ADD CONSTRAINT "acc_transfer_amount" CHECK ("amount" > 0 AND "fee" >= 0 AND "fromId" <> "toId");
ALTER TABLE "acc_visa_transactions" ADD CONSTRAINT "acc_visa_settled" CHECK ("settled" >= 0 AND "settled" <= "amount");
ALTER TABLE "acc_visa_settlements" ADD CONSTRAINT "acc_visa_settlement_amounts" CHECK ("gross" > 0 AND "fee" >= 0 AND "net" = "gross" - "fee");
ALTER TABLE "acc_visa_settlement_lines" ADD CONSTRAINT "acc_visa_line_amount" CHECK ("amount" > 0);
ALTER TABLE "acc_cheques" ADD CONSTRAINT "acc_cheque_amount" CHECK ("amount" > 0 AND "fees" >= 0);
ALTER TABLE "acc_fixed_assets" ADD CONSTRAINT "acc_asset_amounts" CHECK ("cost" > 0 AND "salvage" >= 0 AND "salvage" < "cost" AND "usefulLifeMonths" > 0);
ALTER TABLE "acc_employee_advances" ADD CONSTRAINT "acc_advance_amounts" CHECK ("amount" > 0 AND "installment" > 0 AND "recovered" >= 0 AND "recovered" <= "amount");
CREATE TRIGGER acc_doc_revisions_append_only BEFORE UPDATE OR DELETE ON "acc_doc_revisions" FOR EACH ROW EXECUTE FUNCTION acc_block_change();
CREATE TRIGGER acc_cheque_events_append_only BEFORE UPDATE OR DELETE ON "acc_cheque_events" FOR EACH ROW EXECUTE FUNCTION acc_block_change();
