-- CreateEnum
CREATE TYPE "ShiftHolding" AS ENUM ('ASSIGNED', 'SECURED', 'PURCHASED', 'VACANT');

-- CreateEnum
CREATE TYPE "ShiftEventType" AS ENUM ('ASSIGNED', 'SECURED', 'PURCHASED', 'RELEASED', 'SWAPPED', 'REASSIGNED', 'COVERAGE', 'HANDOVER', 'REVERSED');

-- CreateEnum
CREATE TYPE "ExchangeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ECoinSource" AS ENUM ('LAB_INVOICE', 'ADJUSTMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "ECoinTxnType" AS ENUM ('EARN', 'EXPIRE', 'PURCHASE', 'SECURE', 'ADJUST', 'CLAWBACK', 'REVERSAL');

-- CreateEnum
CREATE TYPE "PenaltyStatus" AS ENUM ('ACTIVE', 'ENDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ECOIN';
ALTER TYPE "NotificationType" ADD VALUE 'SHIFT_EXCHANGE';

-- AlterTable
ALTER TABLE "shift_assignments" ADD COLUMN     "holding" "ShiftHolding" NOT NULL DEFAULT 'ASSIGNED',
ADD COLUMN     "originalUserId" TEXT,
ADD COLUMN     "securedAt" TIMESTAMP(3),
ADD COLUMN     "staffType" "StaffType",
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ecoin_wallets" (
    "userId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "penaltyCheckedThrough" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ecoin_wallets_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ecoin_lots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "ECoinSource" NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invoiceId" TEXT,
    "expiredAt" TIMESTAMP(3),
    "warnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecoin_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecoin_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ECoinTxnType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "lotId" TEXT,
    "invoiceId" TEXT,
    "assignmentId" TEXT,
    "reversalOfId" TEXT,
    "idempotencyKey" TEXT,
    "reason" TEXT,
    "meta" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecoin_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecoin_lot_uses" (
    "id" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "ecoin_lot_uses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_price_rules" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "weekday" INTEGER,
    "date" DATE,
    "price" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecoin_penalties" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "windowShifts" JSONB NOT NULL,
    "coinsEarned" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL,
    "usesTotal" INTEGER NOT NULL,
    "usesLeft" INTEGER NOT NULL,
    "status" "PenaltyStatus" NOT NULL DEFAULT 'ACTIVE',
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ecoin_penalties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_events" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "type" "ShiftEventType" NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "price" INTEGER,
    "txnId" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_swaps" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "fromAssignmentId" TEXT NOT NULL,
    "toAssignmentId" TEXT NOT NULL,
    "status" "ExchangeStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_swaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_coverages" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "ExchangeStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_coverages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_handovers" (
    "id" TEXT NOT NULL,
    "nextAssignmentId" TEXT,
    "prevAssignmentId" TEXT,
    "nextUserId" TEXT,
    "prevUserId" TEXT,
    "plannedStart" TIMESTAMP(3),
    "actualStart" TIMESTAMP(3),
    "plannedEnd" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "extendedMinutes" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ecoin_lots_invoiceId_key" ON "ecoin_lots"("invoiceId");

-- CreateIndex
CREATE INDEX "ecoin_lots_userId_expiresAt_idx" ON "ecoin_lots"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "ecoin_lots_expiresAt_idx" ON "ecoin_lots"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ecoin_transactions_reversalOfId_key" ON "ecoin_transactions"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "ecoin_transactions_idempotencyKey_key" ON "ecoin_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ecoin_transactions_userId_createdAt_idx" ON "ecoin_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ecoin_transactions_type_createdAt_idx" ON "ecoin_transactions"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ecoin_transactions_assignmentId_idx" ON "ecoin_transactions"("assignmentId");

-- CreateIndex
CREATE INDEX "ecoin_lot_uses_lotId_idx" ON "ecoin_lot_uses"("lotId");

-- CreateIndex
CREATE INDEX "shift_price_rules_shiftId_idx" ON "shift_price_rules"("shiftId");

-- CreateIndex
CREATE INDEX "ecoin_penalties_userId_status_idx" ON "ecoin_penalties"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ecoin_penalties_userId_windowEnd_key" ON "ecoin_penalties"("userId", "windowEnd");

-- CreateIndex
CREATE INDEX "shift_events_assignmentId_createdAt_idx" ON "shift_events"("assignmentId", "createdAt");

-- CreateIndex
CREATE INDEX "shift_events_type_createdAt_idx" ON "shift_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "shift_swaps_requesterId_status_idx" ON "shift_swaps"("requesterId", "status");

-- CreateIndex
CREATE INDEX "shift_swaps_targetUserId_status_idx" ON "shift_swaps"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "shift_coverages_assignmentId_status_idx" ON "shift_coverages"("assignmentId", "status");

-- CreateIndex
CREATE INDEX "shift_coverages_ownerId_status_idx" ON "shift_coverages"("ownerId", "status");

-- CreateIndex
CREATE INDEX "shift_coverages_requesterId_status_idx" ON "shift_coverages"("requesterId", "status");

-- CreateIndex
CREATE INDEX "shift_handovers_createdAt_idx" ON "shift_handovers"("createdAt");

-- CreateIndex
CREATE INDEX "shift_handovers_nextUserId_idx" ON "shift_handovers"("nextUserId");

-- CreateIndex
CREATE INDEX "shift_handovers_prevUserId_idx" ON "shift_handovers"("prevUserId");

-- CreateIndex
CREATE INDEX "shift_assignments_userId_date_idx" ON "shift_assignments"("userId", "date");

-- AddForeignKey
ALTER TABLE "ecoin_lot_uses" ADD CONSTRAINT "ecoin_lot_uses_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "ecoin_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_events" ADD CONSTRAINT "shift_events_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "shift_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_coverages" ADD CONSTRAINT "shift_coverages_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "shift_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Existing shifts: slot category and original holder (nothing else changes) ──
UPDATE "shift_assignments" sa SET "staffType" = u."staffType", "originalUserId" = sa."userId"
FROM "users" u WHERE u."id" = sa."userId";

-- ── Integrity: balances and lots can never go negative ──
ALTER TABLE "ecoin_wallets" ADD CONSTRAINT ecoin_wallets_balance_non_negative CHECK ("balance" >= 0);
ALTER TABLE "ecoin_lots" ADD CONSTRAINT ecoin_lots_amounts_valid CHECK ("amount" > 0 AND "remaining" >= 0 AND "remaining" <= "amount");
ALTER TABLE "ecoin_transactions" ADD CONSTRAINT ecoin_transactions_balances_valid CHECK ("balanceBefore" >= 0 AND "balanceAfter" >= 0 AND "balanceAfter" = "balanceBefore" + "amount");
ALTER TABLE "shift_price_rules" ADD CONSTRAINT shift_price_rules_valid CHECK ("price" >= 0 AND ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6) AND ("weekday" IS NULL) <> ("date" IS NULL));
ALTER TABLE "ecoin_penalties" ADD CONSTRAINT ecoin_penalties_uses_valid CHECK ("usesLeft" >= 0 AND "usesLeft" <= "usesTotal");
-- A vacant slot has no holder, a held slot always has one.
ALTER TABLE "shift_assignments" ADD CONSTRAINT shift_assignments_holding_matches_holder CHECK (("holding" = 'VACANT') = ("userId" IS NULL));

-- ── Ledgers are append-only: corrections are new rows, never edits or deletions ──
CREATE OR REPLACE FUNCTION ecoin_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ecoin_transactions_append_only BEFORE UPDATE OR DELETE ON "ecoin_transactions" FOR EACH ROW EXECUTE FUNCTION ecoin_block_mutation();
CREATE TRIGGER ecoin_transactions_no_truncate BEFORE TRUNCATE ON "ecoin_transactions" FOR EACH STATEMENT EXECUTE FUNCTION ecoin_block_mutation();
CREATE TRIGGER ecoin_lot_uses_append_only BEFORE UPDATE OR DELETE ON "ecoin_lot_uses" FOR EACH ROW EXECUTE FUNCTION ecoin_block_mutation();
CREATE TRIGGER ecoin_lot_uses_no_truncate BEFORE TRUNCATE ON "ecoin_lot_uses" FOR EACH STATEMENT EXECUTE FUNCTION ecoin_block_mutation();
CREATE TRIGGER shift_events_append_only BEFORE UPDATE OR DELETE ON "shift_events" FOR EACH ROW EXECUTE FUNCTION ecoin_block_mutation();
CREATE TRIGGER shift_events_no_truncate BEFORE TRUNCATE ON "shift_events" FOR EACH STATEMENT EXECUTE FUNCTION ecoin_block_mutation();
