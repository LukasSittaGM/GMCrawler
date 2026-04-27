-- CreateEnum
CREATE TYPE "CompanyWebsiteSource" AS ENUM ('search', 'ares', 'manual', 'imported', 'other');

-- AlterTable
ALTER TABLE "Company"
ADD COLUMN     "websiteUrl" TEXT,
ADD COLUMN     "websiteDomain" TEXT,
ADD COLUMN     "websiteConfidenceScore" INTEGER,
ADD COLUMN     "websiteFoundAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CompanyWebsite" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedDomain" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "source" "CompanyWebsiteSource" NOT NULL,
    "rank" INTEGER,
    "confidenceScore" INTEGER NOT NULL,
    "isOfficialCandidate" BOOLEAN NOT NULL DEFAULT false,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyWebsite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyWebsite_companyId_confidenceScore_idx" ON "CompanyWebsite"("companyId", "confidenceScore");

-- CreateIndex
CREATE INDEX "CompanyWebsite_companyId_normalizedDomain_idx" ON "CompanyWebsite"("companyId", "normalizedDomain");

-- AddForeignKey
ALTER TABLE "CompanyWebsite" ADD CONSTRAINT "CompanyWebsite_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
