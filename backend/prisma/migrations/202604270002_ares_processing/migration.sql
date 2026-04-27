-- CreateEnum
CREATE TYPE "ProcessingLogStatus" AS ENUM ('info', 'success', 'warning', 'error');

-- AlterTable
ALTER TABLE "Company"
ADD COLUMN "legalForm" TEXT,
ADD COLUMN "addressText" TEXT,
ADD COLUMN "city" TEXT,
ADD COLUMN "postalCode" TEXT,
ADD COLUMN "country" TEXT,
ADD COLUMN "registrationStatus" TEXT,
ADD COLUMN "createdDate" TIMESTAMP(3),
ADD COLUMN "dataBoxId" TEXT,
ADD COLUMN "aresRawJson" JSONB,
ADD COLUMN "aresLoadedAt" TIMESTAMP(3),
ADD COLUMN "statutoryPersonsJson" JSONB;

-- CreateTable
CREATE TABLE "ProcessingLog" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "companyId" TEXT,
    "step" TEXT NOT NULL,
    "status" "ProcessingLogStatus" NOT NULL,
    "message" TEXT NOT NULL,
    "detailJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessingLog_batchId_createdAt_idx" ON "ProcessingLog"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessingLog_companyId_createdAt_idx" ON "ProcessingLog"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProcessingLog" ADD CONSTRAINT "ProcessingLog_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SearchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingLog" ADD CONSTRAINT "ProcessingLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
