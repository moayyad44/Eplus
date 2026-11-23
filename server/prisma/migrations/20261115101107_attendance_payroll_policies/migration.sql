-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'NO_RECORD';

-- AlterTable
ALTER TABLE "acc_payslips" ADD COLUMN     "earlyDeduction" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "earlyMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lateCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lateDeduction" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "leaveDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
ADD COLUMN     "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pendingAdjust" JSONB,
ADD COLUMN     "reviewDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "workDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "acc_salary_profiles" ADD COLUMN     "policy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "attendance" ADD COLUMN     "editReason" TEXT,
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "editedById" TEXT,
ADD COLUMN     "excused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lateDecision" TEXT,
ADD COLUMN     "lateExcuse" TEXT,
ADD COLUMN     "lateExcuseStatus" TEXT,
ADD COLUMN     "overtimeDecision" TEXT,
ADD COLUMN     "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- CreateTable
CREATE TABLE "acc_payslip_items" (
    "id" TEXT NOT NULL,
    "slipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL,
    "note" TEXT,
    "waived" BOOLEAN NOT NULL DEFAULT false,
    "waiveReason" TEXT,

    CONSTRAINT "acc_payslip_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "acc_payslip_items_sourceType_sourceId_idx" ON "acc_payslip_items"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "acc_payslip_items_slipId_kind_sourceId_key" ON "acc_payslip_items"("slipId", "kind", "sourceId");

-- CreateIndex
CREATE INDEX "overtime_entries_userId_date_idx" ON "overtime_entries"("userId", "date");

-- AddForeignKey
ALTER TABLE "acc_payslip_items" ADD CONSTRAINT "acc_payslip_items_slipId_fkey" FOREIGN KEY ("slipId") REFERENCES "acc_payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New permissions: whoever could already do the action keeps it (existing installs only; a fresh install gets them from bootstrap).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "roles") THEN
    INSERT INTO "permissions" ("key", "module", "description") VALUES
      ('attendance.check_in', 'staff', 'تسجيل الحضور من حساب الموظف'),
      ('attendance.check_out', 'staff', 'تسجيل المغادرة من حساب الموظف'),
      ('attendance.settings.view', 'staff', 'عرض إعدادات الدوام والرواتب'),
      ('attendance.settings.manage', 'staff', 'تعديل إعدادات الدوام والرواتب'),
      ('attendance.late.approve', 'staff', 'اعتماد خصم التأخير أو الإعفاء منه وقبول التبرير'),
      ('attendance.overtime.approve', 'staff', 'اعتماد العمل الإضافي وتسجيله يدوياً'),
      ('accounting.payroll.approve', 'accounting', 'اعتماد كشف الرواتب وإعادة فتحه'),
      ('accounting.payroll.adjust', 'accounting', 'تعديل الخصومات والإضافات في كشف الرواتب')
    ON CONFLICT ("key") DO NOTHING;

    INSERT INTO "role_permissions" ("roleId", "permissionKey")
      SELECT r."id", p.k FROM "roles" r CROSS JOIN (VALUES ('attendance.check_in'), ('attendance.check_out')) AS p(k)
    ON CONFLICT DO NOTHING;
    INSERT INTO "role_permissions" ("roleId", "permissionKey")
      SELECT DISTINCT rp."roleId", 'attendance.settings.view' FROM "role_permissions" rp WHERE rp."permissionKey" IN ('settings.view', 'settings.manage', 'attendance.manage')
    ON CONFLICT DO NOTHING;
    INSERT INTO "role_permissions" ("roleId", "permissionKey")
      SELECT rp."roleId", 'attendance.settings.manage' FROM "role_permissions" rp WHERE rp."permissionKey" = 'settings.manage'
    ON CONFLICT DO NOTHING;
    INSERT INTO "role_permissions" ("roleId", "permissionKey")
      SELECT rp."roleId", p.k FROM "role_permissions" rp CROSS JOIN (VALUES ('attendance.late.approve'), ('attendance.overtime.approve')) AS p(k) WHERE rp."permissionKey" = 'attendance.manage'
    ON CONFLICT DO NOTHING;
    INSERT INTO "role_permissions" ("roleId", "permissionKey")
      SELECT rp."roleId", p.k FROM "role_permissions" rp CROSS JOIN (VALUES ('accounting.payroll.approve'), ('accounting.payroll.adjust')) AS p(k) WHERE rp."permissionKey" = 'accounting.payroll.manage'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
