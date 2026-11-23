-- Attendance is kept per shift (a doctor with two shifts in a day gets one record for each).
-- Existing records keep their data: each becomes the record of the shift it was linked to, or the «day» slot.
ALTER TABLE "attendance" ADD COLUMN "slot" TEXT NOT NULL DEFAULT 'day';
UPDATE "attendance" SET "slot" = "shiftAssignmentId" WHERE "shiftAssignmentId" IS NOT NULL;

DROP INDEX "attendance_userId_date_key";
CREATE UNIQUE INDEX "attendance_userId_date_slot_key" ON "attendance"("userId", "date", "slot");
