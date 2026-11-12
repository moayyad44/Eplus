-- New insurance companies default to sending nothing to the national e-invoicing system.
ALTER TABLE "insurance_companies" ALTER COLUMN "einvoiceMode" SET DEFAULT 'NONE';
-- Existing companies only got the old default automatically. Follow the new default, but only while the
-- integration has never been used (no national document exists), so a choice already in use is never changed.
UPDATE "insurance_companies" SET "einvoiceMode" = 'NONE'
WHERE "einvoiceMode" = 'PATIENT_SHARE' AND NOT EXISTS (SELECT 1 FROM "einvoices");
