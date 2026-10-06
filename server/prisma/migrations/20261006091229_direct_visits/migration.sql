-- AlterTable
ALTER TABLE "visits" ADD COLUMN     "isDirect" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "queueNumber" DROP NOT NULL,
ALTER COLUMN "queuePosition" DROP NOT NULL;

