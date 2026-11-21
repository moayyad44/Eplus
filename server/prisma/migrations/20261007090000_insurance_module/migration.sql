-- CreateEnum
CREATE TYPE "PayerType" AS ENUM ('SELF_PAY', 'INSURANCE', 'CORPORATE', 'GOVERNMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "InsurancePriority" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "InsuranceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'READY', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED', 'PAID', 'PARTIALLY_PAID', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClaimEventType" AS ENUM ('CREATED', 'READY', 'SUBMITTED', 'UNDER_REVIEW', 'DECISION', 'RESUBMISSION_REQUIRED', 'RESUBMITTED', 'PAYMENT', 'TRANSFER_TO_PATIENT', 'WRITE_OFF', 'CLOSED', 'CANCELLED', 'NOTE');

-- AlterEnum
ALTER TYPE "AttachmentCategory" ADD VALUE 'INSURANCE';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'INSURANCE';

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "authorizationId" TEXT,
ADD COLUMN     "claimId" TEXT,
ADD COLUMN     "patientInsuranceId" TEXT;

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "authorizationId" TEXT,
ADD COLUMN     "coverageNote" TEXT,
ADD COLUMN     "coveragePercent" DECIMAL(5,2),
ADD COLUMN     "insuranceShare" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "patientShare" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "insuranceCompanyId" TEXT,
ADD COLUMN     "insuranceContractId" TEXT,
ADD COLUMN     "insuranceMemberId" TEXT,
ADD COLUMN     "insuranceShare" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "patientInsuranceId" TEXT,
ADD COLUMN     "patientShare" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "payerType" "PayerType" NOT NULL DEFAULT 'SELF_PAY',
ADD COLUMN     "transferredFromInsurance" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "payerType" "PayerType" NOT NULL DEFAULT 'SELF_PAY';

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "insCoveragePercent" DECIMAL(5,2),
ADD COLUMN     "insMaxAmount" DECIMAL(12,3),
ADD COLUMN     "insNotes" TEXT,
ADD COLUMN     "insRequiresApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "insRequiresReport" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "insurable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "visits" ADD COLUMN     "insuranceCompanyId" TEXT,
ADD COLUMN     "insuranceContractId" TEXT,
ADD COLUMN     "insuranceMemberId" TEXT,
ADD COLUMN     "patientInsuranceId" TEXT,
ADD COLUMN     "payerType" "PayerType" NOT NULL DEFAULT 'SELF_PAY';

-- CreateTable
CREATE TABLE "insurance_companies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "contactPerson" TEXT,
    "contractNumber" TEXT,
    "contractStart" DATE,
    "contractEnd" DATE,
    "openingBalance" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_contracts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contractNumber" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "terms" TEXT,
    "coveragePercent" DECIMAL(5,2) NOT NULL DEFAULT 80,
    "annualLimit" DECIMAL(12,3),
    "coveredServices" TEXT,
    "excludedServices" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_coverage_rules" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "serviceId" TEXT,
    "category" "ServiceCategory",
    "covered" BOOLEAN NOT NULL DEFAULT true,
    "coveragePercent" DECIMAL(5,2),
    "patientFixed" DECIMAL(12,3),
    "maxAmount" DECIMAL(12,3),
    "price" DECIMAL(12,3),
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "requiresReport" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "insurance_coverage_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_insurances" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "priority" "InsurancePriority" NOT NULL DEFAULT 'PRIMARY',
    "cardNumber" TEXT,
    "policyNumber" TEXT,
    "memberId" TEXT NOT NULL,
    "subscriberName" TEXT,
    "relation" TEXT NOT NULL DEFAULT 'SELF',
    "startDate" DATE,
    "endDate" DATE,
    "status" "InsuranceStatus" NOT NULL DEFAULT 'ACTIVE',
    "coveragePercent" DECIMAL(5,2),
    "annualLimit" DECIMAL(12,3),
    "network" TEXT,
    "notes" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "patient_insurances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_authorizations" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "patientInsuranceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "visitId" TEXT,
    "doctorId" TEXT,
    "serviceId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "diagnosis" TEXT,
    "reason" TEXT,
    "medicalReportId" TEXT,
    "status" "AuthorizationStatus" NOT NULL DEFAULT 'PENDING',
    "approvalNumber" TEXT,
    "approvedQuantity" DECIMAL(10,2),
    "approvedAmount" DECIMAL(12,3),
    "validUntil" DATE,
    "rejectReason" TEXT,
    "notes" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claims" (
    "id" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "patientInsuranceId" TEXT NOT NULL,
    "visitId" TEXT,
    "doctorId" TEXT,
    "policyNumber" TEXT,
    "memberId" TEXT NOT NULL,
    "diagnosis" TEXT,
    "totalAmount" DECIMAL(12,3) NOT NULL,
    "insuranceAmount" DECIMAL(12,3) NOT NULL,
    "patientAmount" DECIMAL(12,3) NOT NULL,
    "submittedAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "approvedAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejectedAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "transferredAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "writtenOffAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "pendingAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "outstandingAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "workflowStatus" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "status" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "lastPaymentAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claim_items" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "invoiceItemId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(12,3) NOT NULL,
    "totalAmount" DECIMAL(12,3) NOT NULL,
    "insuranceAmount" DECIMAL(12,3) NOT NULL,
    "approvedAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejectedAmount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejectReason" TEXT,
    "approvalNumber" TEXT,

    CONSTRAINT "insurance_claim_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claim_events" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "type" "ClaimEventType" NOT NULL,
    "fromStatus" "ClaimStatus",
    "toStatus" "ClaimStatus",
    "dApproved" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "dRejected" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "dPaid" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "dTransferred" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "dWrittenOff" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "dSubmitted" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "dCancelled" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "notes" TEXT,
    "allocationId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_claim_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_payments" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "amount" DECIMAL(12,3) NOT NULL,
    "methodId" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "amount" DECIMAL(12,3) NOT NULL,

    CONSTRAINT "insurance_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "insurance_companies_code_key" ON "insurance_companies"("code");

-- CreateIndex
CREATE INDEX "insurance_contracts_companyId_idx" ON "insurance_contracts"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_coverage_rules_contractId_serviceId_key" ON "insurance_coverage_rules"("contractId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_coverage_rules_contractId_category_key" ON "insurance_coverage_rules"("contractId", "category");

-- CreateIndex
CREATE INDEX "patient_insurances_patientId_idx" ON "patient_insurances"("patientId");

-- CreateIndex
CREATE INDEX "patient_insurances_companyId_idx" ON "patient_insurances"("companyId");

-- CreateIndex
CREATE INDEX "patient_insurances_endDate_idx" ON "patient_insurances"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_authorizations_requestNumber_key" ON "insurance_authorizations"("requestNumber");

-- CreateIndex
CREATE INDEX "insurance_authorizations_patientId_status_idx" ON "insurance_authorizations"("patientId", "status");

-- CreateIndex
CREATE INDEX "insurance_authorizations_status_requestedAt_idx" ON "insurance_authorizations"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_claims_claimNumber_key" ON "insurance_claims"("claimNumber");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_claims_invoiceId_key" ON "insurance_claims"("invoiceId");

-- CreateIndex
CREATE INDEX "insurance_claims_companyId_status_idx" ON "insurance_claims"("companyId", "status");

-- CreateIndex
CREATE INDEX "insurance_claims_status_submittedAt_idx" ON "insurance_claims"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "insurance_claims_patientId_idx" ON "insurance_claims"("patientId");

-- CreateIndex
CREATE INDEX "insurance_claim_items_claimId_idx" ON "insurance_claim_items"("claimId");

-- CreateIndex
CREATE INDEX "insurance_claim_events_claimId_createdAt_idx" ON "insurance_claim_events"("claimId", "createdAt");

-- CreateIndex
CREATE INDEX "insurance_claim_events_type_createdAt_idx" ON "insurance_claim_events"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_payments_receiptNumber_key" ON "insurance_payments"("receiptNumber");

-- CreateIndex
CREATE INDEX "insurance_payments_companyId_paidAt_idx" ON "insurance_payments"("companyId", "paidAt");

-- CreateIndex
CREATE INDEX "insurance_payments_paidAt_idx" ON "insurance_payments"("paidAt");

-- CreateIndex
CREATE INDEX "insurance_payment_allocations_claimId_idx" ON "insurance_payment_allocations"("claimId");

-- CreateIndex
CREATE INDEX "insurance_payment_allocations_paymentId_idx" ON "insurance_payment_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "invoice_items_authorizationId_idx" ON "invoice_items"("authorizationId");

-- CreateIndex
CREATE INDEX "invoices_insuranceCompanyId_issuedAt_idx" ON "invoices"("insuranceCompanyId", "issuedAt");

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "patient_insurances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "patient_insurances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "insurance_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "insurance_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "patient_insurances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_insuranceCompanyId_fkey" FOREIGN KEY ("insuranceCompanyId") REFERENCES "insurance_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_insuranceContractId_fkey" FOREIGN KEY ("insuranceContractId") REFERENCES "insurance_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "insurance_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_contracts" ADD CONSTRAINT "insurance_contracts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "insurance_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_coverage_rules" ADD CONSTRAINT "insurance_coverage_rules_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "insurance_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_coverage_rules" ADD CONSTRAINT "insurance_coverage_rules_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_insurances" ADD CONSTRAINT "patient_insurances_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_insurances" ADD CONSTRAINT "patient_insurances_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "insurance_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_insurances" ADD CONSTRAINT "patient_insurances_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "insurance_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_authorizations" ADD CONSTRAINT "insurance_authorizations_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_authorizations" ADD CONSTRAINT "insurance_authorizations_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "patient_insurances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_authorizations" ADD CONSTRAINT "insurance_authorizations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "insurance_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_authorizations" ADD CONSTRAINT "insurance_authorizations_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "insurance_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_authorizations" ADD CONSTRAINT "insurance_authorizations_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_authorizations" ADD CONSTRAINT "insurance_authorizations_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "insurance_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "insurance_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "patient_insurances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim_items" ADD CONSTRAINT "insurance_claim_items_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "insurance_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim_items" ADD CONSTRAINT "insurance_claim_items_invoiceItemId_fkey" FOREIGN KEY ("invoiceItemId") REFERENCES "invoice_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim_items" ADD CONSTRAINT "insurance_claim_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim_events" ADD CONSTRAINT "insurance_claim_events_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "insurance_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claim_events" ADD CONSTRAINT "insurance_claim_events_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "insurance_payment_allocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_payments" ADD CONSTRAINT "insurance_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "insurance_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_payments" ADD CONSTRAINT "insurance_payments_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_payment_allocations" ADD CONSTRAINT "insurance_payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "insurance_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_payment_allocations" ADD CONSTRAINT "insurance_payment_allocations_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "insurance_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Data: existing invoices and items are entirely the patient's ──
UPDATE "invoices" SET "patientShare" = "total";
UPDATE "invoice_items" SET "patientShare" = "lineTotal";

-- ── Money can never go negative / percentages stay within 0–100 ──
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_shares_nonneg" CHECK ("patientShare" >= 0 AND "insuranceShare" >= 0 AND "transferredFromInsurance" >= 0);
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_shares_nonneg" CHECK ("patientShare" >= 0 AND "insuranceShare" >= 0);
ALTER TABLE "services" ADD CONSTRAINT "services_ins_values" CHECK (("insCoveragePercent" IS NULL OR "insCoveragePercent" BETWEEN 0 AND 100) AND ("insMaxAmount" IS NULL OR "insMaxAmount" >= 0));
ALTER TABLE "insurance_contracts" ADD CONSTRAINT "insurance_contracts_values" CHECK ("coveragePercent" BETWEEN 0 AND 100 AND ("annualLimit" IS NULL OR "annualLimit" >= 0));
ALTER TABLE "insurance_coverage_rules" ADD CONSTRAINT "insurance_rules_target" CHECK (("serviceId" IS NULL) <> ("category" IS NULL));
ALTER TABLE "insurance_coverage_rules" ADD CONSTRAINT "insurance_rules_values" CHECK (
  ("coveragePercent" IS NULL OR "coveragePercent" BETWEEN 0 AND 100) AND ("patientFixed" IS NULL OR "patientFixed" >= 0)
  AND ("maxAmount" IS NULL OR "maxAmount" >= 0) AND ("price" IS NULL OR "price" >= 0));
ALTER TABLE "patient_insurances" ADD CONSTRAINT "patient_insurances_values" CHECK (("coveragePercent" IS NULL OR "coveragePercent" BETWEEN 0 AND 100) AND ("annualLimit" IS NULL OR "annualLimit" >= 0));
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_amounts_nonneg" CHECK (
  "totalAmount" >= 0 AND "insuranceAmount" >= 0 AND "patientAmount" >= 0 AND "submittedAmount" >= 0 AND "approvedAmount" >= 0
  AND "rejectedAmount" >= 0 AND "paidAmount" >= 0 AND "transferredAmount" >= 0 AND "writtenOffAmount" >= 0
  AND "pendingAmount" >= 0 AND "outstandingAmount" >= 0 AND "paidAmount" <= "approvedAmount");
ALTER TABLE "insurance_payments" ADD CONSTRAINT "insurance_payments_amount_pos" CHECK ("amount" > 0);
ALTER TABLE "insurance_payment_allocations" ADD CONSTRAINT "insurance_allocations_amount_pos" CHECK ("amount" > 0);

-- ── Claim history is append-only: entries can only be marked void, never edited or deleted ──
CREATE OR REPLACE FUNCTION insurance_claim_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'insurance_claim_events is append-only';
  END IF;
  IF OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
     OR (to_jsonb(NEW) - 'voidedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'voidedAt') THEN
    RAISE EXCEPTION 'insurance_claim_events: only voiding an entry is allowed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER insurance_claim_events_guard BEFORE UPDATE OR DELETE ON "insurance_claim_events"
  FOR EACH ROW EXECUTE FUNCTION insurance_claim_events_guard();
