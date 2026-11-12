-- AlterTable
ALTER TABLE "nursing_notes" ADD COLUMN     "serviceId" TEXT;

-- AddForeignKey
ALTER TABLE "nursing_notes" ADD CONSTRAINT "nursing_notes_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;


CREATE INDEX "nursing_notes_serviceId_idx" ON "nursing_notes"("serviceId");
