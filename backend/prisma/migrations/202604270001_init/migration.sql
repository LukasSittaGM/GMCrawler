-- CreateEnum
CREATE TYPE "SearchBatchStatus" AS ENUM ('draft', 'ready', 'processing', 'done', 'error');

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('pending', 'loading_ares', 'finding_web', 'crawling', 'extracting', 'done', 'no_results', 'error');

-- CreateEnum
CREATE TYPE "ImportLogStatus" AS ENUM ('imported', 'skipped', 'invalid', 'duplicate');

-- CreateTable
CREATE TABLE "SearchBatch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "targetRole" TEXT,
    "status" "SearchBatchStatus" NOT NULL DEFAULT 'draft',
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "ico" TEXT NOT NULL,
    "companyName" TEXT,
    "status" "CompanyStatus" NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportLog" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawValue" TEXT NOT NULL,
    "normalizedIco" TEXT,
    "status" "ImportLogStatus" NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_batchId_ico_key" ON "Company"("batchId", "ico");

-- CreateIndex
CREATE INDEX "Company_batchId_idx" ON "Company"("batchId");

-- CreateIndex
CREATE INDEX "ImportLog_batchId_idx" ON "ImportLog"("batchId");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SearchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportLog" ADD CONSTRAINT "ImportLog_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SearchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
