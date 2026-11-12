-- Actual issue time, kept apart from the (possibly back-dated) invoice date in "issuedAt".
ALTER TABLE "invoices" ADD COLUMN "issuedRecordedAt" TIMESTAMP(3);
-- Existing invoices: their invoice date is their real issue time. No invoice date is changed.
UPDATE "invoices" SET "issuedRecordedAt" = "issuedAt" WHERE "issuedAt" IS NOT NULL AND "status" <> 'DRAFT';
