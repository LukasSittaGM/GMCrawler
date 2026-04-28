-- CreateEnum
CREATE TYPE "SearchResultType" AS ENUM (
  'official_website_candidate',
  'contact_page_candidate',
  'person_candidate',
  'pdf_candidate',
  'registry',
  'social',
  'other'
);

-- CreateTable
CREATE TABLE "SearchResult" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "normalizedUrl" TEXT NOT NULL,
  "normalizedDomain" TEXT NOT NULL,
  "snippet" TEXT,
  "provider" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "resultType" "SearchResultType" NOT NULL DEFAULT 'other',
  "confidenceScore" INTEGER NOT NULL DEFAULT 0,
  "isProcessed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SearchResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SearchResult_companyId_query_normalizedUrl_key" ON "SearchResult"("companyId", "query", "normalizedUrl");

-- CreateIndex
CREATE INDEX "SearchResult_companyId_confidenceScore_idx" ON "SearchResult"("companyId", "confidenceScore");

-- CreateIndex
CREATE INDEX "SearchResult_batchId_createdAt_idx" ON "SearchResult"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchResult_companyId_normalizedDomain_idx" ON "SearchResult"("companyId", "normalizedDomain");

-- AddForeignKey
ALTER TABLE "SearchResult" ADD CONSTRAINT "SearchResult_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchResult" ADD CONSTRAINT "SearchResult_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SearchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
