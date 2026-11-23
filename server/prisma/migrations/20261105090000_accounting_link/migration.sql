-- CreateEnum
CREATE TYPE "AccountingEventStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "acc_journal_revisions" ADD COLUMN     "reason" TEXT;

-- CreateTable
CREATE TABLE "acc_events" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "AccountingEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "note" TEXT,
    "entryId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "acc_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acc_events_sourceKey_key" ON "acc_events"("sourceKey");

-- CreateIndex
CREATE INDEX "acc_events_status_queuedAt_idx" ON "acc_events"("status", "queuedAt");

