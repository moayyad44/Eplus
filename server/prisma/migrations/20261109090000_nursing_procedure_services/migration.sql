-- A nursing procedure can bill several services (each with a quantity).
CREATE TABLE "nursing_note_services" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    CONSTRAINT "nursing_note_services_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "nursing_note_services_noteId_idx" ON "nursing_note_services"("noteId");
CREATE INDEX "nursing_note_services_serviceId_idx" ON "nursing_note_services"("serviceId");
ALTER TABLE "nursing_note_services" ADD CONSTRAINT "nursing_note_services_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "nursing_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "nursing_note_services" ADD CONSTRAINT "nursing_note_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep the links already recorded with the single-service version.
INSERT INTO "nursing_note_services" ("id", "noteId", "serviceId", "quantity")
SELECT gen_random_uuid()::text, "id", "serviceId", 1 FROM "nursing_notes" WHERE "serviceId" IS NOT NULL;

ALTER TABLE "nursing_notes" DROP CONSTRAINT "nursing_notes_serviceId_fkey";
DROP INDEX "nursing_notes_serviceId_idx";
ALTER TABLE "nursing_notes" DROP COLUMN "serviceId";
