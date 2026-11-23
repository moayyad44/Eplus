-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryTxnType" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "InventoryTxnType" ADD VALUE 'TRANSFER_IN';

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "warehouseBalanceAfter" DECIMAL(12,2),
ADD COLUMN     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "stock_counts" ADD COLUMN     "warehouseId" TEXT;

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock" (
    "warehouseId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_pkey" PRIMARY KEY ("warehouseId","itemId")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "fromWarehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_items" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE INDEX "warehouse_stock_itemId_idx" ON "warehouse_stock"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_transferNumber_key" ON "stock_transfers"("transferNumber");

-- CreateIndex
CREATE INDEX "stock_transfers_createdAt_idx" ON "stock_transfers"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_items_transferId_itemId_key" ON "stock_transfer_items"("transferId", "itemId");

-- CreateIndex
CREATE INDEX "inventory_transactions_warehouseId_createdAt_idx" ON "inventory_transactions"("warehouseId", "createdAt");

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stock" ADD CONSTRAINT "warehouse_stock_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stock" ADD CONSTRAINT "warehouse_stock_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Existing stock goes to one main warehouse (nothing else changes) ──
INSERT INTO "warehouses" ("id", "code", "name", "isDefault", "isActive", "updatedAt")
VALUES (gen_random_uuid()::text, 'MAIN', 'المستودع الرئيسي', true, true, CURRENT_TIMESTAMP);

INSERT INTO "warehouse_stock" ("warehouseId", "itemId", "quantity", "updatedAt")
SELECT w.id, i.id, i.quantity, CURRENT_TIMESTAMP FROM "inventory_items" i CROSS JOIN "warehouses" w
WHERE w.code = 'MAIN' AND i.quantity <> 0;

UPDATE "inventory_transactions" SET "warehouseId" = (SELECT id FROM "warehouses" WHERE code = 'MAIN'), "warehouseBalanceAfter" = "balanceAfter";
UPDATE "stock_counts" SET "warehouseId" = (SELECT id FROM "warehouses" WHERE code = 'MAIN');
ALTER TABLE "inventory_transactions" ALTER COLUMN "warehouseId" SET NOT NULL;

-- ── Rules enforced by the database itself ──
CREATE UNIQUE INDEX "warehouses_one_default" ON "warehouses" ("isDefault") WHERE "isDefault";
ALTER TABLE "warehouse_stock" ADD CONSTRAINT "warehouse_stock_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_distinct_warehouses" CHECK ("fromWarehouseId" <> "toWarehouseId");
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_positive" CHECK ("quantity" > 0);
