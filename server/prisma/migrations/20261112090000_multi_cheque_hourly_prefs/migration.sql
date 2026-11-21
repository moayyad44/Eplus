-- A receipt / payment voucher may now carry several cheques: the link moves to the cheque side.
ALTER TABLE "acc_cheques" ADD COLUMN "voucherId" TEXT;
UPDATE "acc_cheques" c SET "voucherId" = v."id" FROM "acc_vouchers" v WHERE v."chequeId" = c."id";
CREATE INDEX "acc_cheques_voucherId_idx" ON "acc_cheques"("voucherId");
DROP INDEX "acc_vouchers_chequeId_key";
ALTER TABLE "acc_vouchers" DROP COLUMN "chequeId";

-- Payroll: hourly employees (hours worked × hourly rate) next to monthly ones.
ALTER TABLE "acc_salary_profiles" ADD COLUMN "payType" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN "hourlyRate" DECIMAL(12,3) NOT NULL DEFAULT 0;
ALTER TABLE "acc_payslips" ADD COLUMN "payType" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN "hours" DECIMAL(8,2) NOT NULL DEFAULT 0,
ADD COLUMN "hourlyRate" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- Personal screen choices.
ALTER TABLE "users" ADD COLUMN "uiPrefs" JSONB NOT NULL DEFAULT '{}';
