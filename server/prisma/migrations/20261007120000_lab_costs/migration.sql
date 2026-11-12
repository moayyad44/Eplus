-- External laboratory price per test, and its snapshot on each ordered test.
ALTER TABLE "laboratory_tests" ADD COLUMN "labCost" DECIMAL(12,3);
ALTER TABLE "lab_order_items" ADD COLUMN "labCost" DECIMAL(12,3);

ALTER TABLE "laboratory_tests" ADD CONSTRAINT "laboratory_tests_lab_cost_nonneg" CHECK ("labCost" IS NULL OR "labCost" >= 0);
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_lab_cost_nonneg" CHECK ("labCost" IS NULL OR "labCost" >= 0);
