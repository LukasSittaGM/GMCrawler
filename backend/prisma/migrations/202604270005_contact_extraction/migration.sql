-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('regex', 'html_structure', 'llm', 'manual', 'imported');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('unreviewed', 'confirmed', 'rejected', 'manually_edited');

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('email', 'phone', 'general_email', 'general_phone', 'databox', 'other');

-- AlterTable
ALTER TABLE "Company"
ADD COLUMN "extractedAt" TIMESTAMP(3),
ADD COLUMN "personsCount" INTEGER DEFAULT 0,
ADD COLUMN "contactsCount" INTEGER DEFAULT 0,
ADD COLUMN "extractionErrorMessage" TEXT;

-- CreateTable
CREATE TABLE "CompanyPerson" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "position" TEXT,
    "department" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourcePageId" TEXT NOT NULL,
    "contextText" TEXT NOT NULL,
    "extractionMethod" "ExtractionMethod" NOT NULL,
    "confidenceScore" INTEGER NOT NULL,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'unreviewed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "personId" TEXT,
    "contactType" "ContactType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourcePageId" TEXT NOT NULL,
    "contextText" TEXT NOT NULL,
    "extractionMethod" "ExtractionMethod" NOT NULL,
    "confidenceScore" INTEGER NOT NULL,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'unreviewed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyPerson_companyId_createdAt_idx" ON "CompanyPerson"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "CompanyPerson_companyId_fullName_idx" ON "CompanyPerson"("companyId", "fullName");

-- CreateIndex
CREATE INDEX "CompanyContact_companyId_normalizedValue_idx" ON "CompanyContact"("companyId", "normalizedValue");

-- CreateIndex
CREATE INDEX "CompanyContact_companyId_personId_idx" ON "CompanyContact"("companyId", "personId");

-- AddForeignKey
ALTER TABLE "CompanyPerson" ADD CONSTRAINT "CompanyPerson_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyPerson" ADD CONSTRAINT "CompanyPerson_sourcePageId_fkey" FOREIGN KEY ("sourcePageId") REFERENCES "CrawledPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyContact" ADD CONSTRAINT "CompanyContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyContact" ADD CONSTRAINT "CompanyContact_personId_fkey" FOREIGN KEY ("personId") REFERENCES "CompanyPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyContact" ADD CONSTRAINT "CompanyContact_sourcePageId_fkey" FOREIGN KEY ("sourcePageId") REFERENCES "CrawledPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
