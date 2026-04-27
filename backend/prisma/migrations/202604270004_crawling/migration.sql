-- CreateEnum
CREATE TYPE "CrawledPageSource" AS ENUM ('website_root', 'internal_link', 'sitemap', 'manual');

-- CreateEnum
CREATE TYPE "CrawledPageStatus" AS ENUM ('pending', 'fetched', 'skipped', 'error');

-- AlterTable
ALTER TABLE "Company"
ADD COLUMN "crawledAt" TIMESTAMP(3),
ADD COLUMN "crawledPagesCount" INTEGER DEFAULT 0,
ADD COLUMN "crawlErrorMessage" TEXT;

-- CreateTable
CREATE TABLE "CrawledPage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "htmlContent" TEXT,
    "textContent" TEXT,
    "httpStatus" INTEGER,
    "contentType" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "source" "CrawledPageSource" NOT NULL,
    "crawlStatus" "CrawledPageStatus" NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "discoveredFromUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrawledPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrawledPage_companyId_createdAt_idx" ON "CrawledPage"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "CrawledPage_companyId_normalizedUrl_idx" ON "CrawledPage"("companyId", "normalizedUrl");

-- AddForeignKey
ALTER TABLE "CrawledPage" ADD CONSTRAINT "CrawledPage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
