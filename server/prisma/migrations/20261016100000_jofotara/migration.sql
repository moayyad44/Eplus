-- CreateEnum
CREATE TYPE "EInvoiceInsuranceMode" AS ENUM ('PATIENT_SHARE', 'FULL_TO_PATIENT', 'PATIENT_AND_COMPANY');

-- CreateEnum
CREATE TYPE "EInvoiceKind" AS ENUM ('SALE', 'RETURN');

-- CreateEnum
CREATE TYPE "EInvoiceParty" AS ENUM ('PATIENT', 'COMPANY');

-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('PENDING', 'SENDING', 'SUBMITTED', 'REJECTED', 'FAILED', 'UNKNOWN', 'VOID');

-- AlterTable
ALTER TABLE "insurance_companies" ADD COLUMN     "einvoiceMode" "EInvoiceInsuranceMode" NOT NULL DEFAULT 'PATIENT_SHARE',
ADD COLUMN     "taxNumber" TEXT;

-- CreateTable
CREATE TABLE "einvoices" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "EInvoiceKind" NOT NULL,
    "party" "EInvoiceParty" NOT NULL,
    "docNumber" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "icv" INTEGER,
    "typeName" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "originalId" TEXT,
    "reason" TEXT,
    "total" DECIMAL(12,3) NOT NULL,
    "taxTotal" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "xml" TEXT NOT NULL,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "qr" TEXT,
    "signedInvoice" TEXT,
    "einvNum" TEXT,
    "einvUuid" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "einvoice_attempts" (
    "id" TEXT NOT NULL,
    "eInvoiceId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "httpStatus" INTEGER,
    "einvStatus" TEXT,
    "outcome" TEXT NOT NULL,
    "message" TEXT,
    "errors" JSONB,
    "durationMs" INTEGER,
    "userId" TEXT,

    CONSTRAINT "einvoice_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "einvoices_docNumber_key" ON "einvoices"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "einvoices_uuid_key" ON "einvoices"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "einvoices_icv_key" ON "einvoices"("icv");

-- CreateIndex
CREATE INDEX "einvoices_invoiceId_idx" ON "einvoices"("invoiceId");

-- CreateIndex
CREATE INDEX "einvoices_status_nextAttemptAt_idx" ON "einvoices"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "einvoices_createdAt_idx" ON "einvoices"("createdAt");

-- CreateIndex
CREATE INDEX "einvoice_attempts_eInvoiceId_at_idx" ON "einvoice_attempts"("eInvoiceId", "at");

-- AddForeignKey
ALTER TABLE "einvoices" ADD CONSTRAINT "einvoices_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoices" ADD CONSTRAINT "einvoices_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "einvoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoice_attempts" ADD CONSTRAINT "einvoice_attempts_eInvoiceId_fkey" FOREIGN KEY ("eInvoiceId") REFERENCES "einvoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

