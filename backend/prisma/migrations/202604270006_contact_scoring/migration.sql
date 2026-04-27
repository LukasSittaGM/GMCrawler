-- CreateEnum
CREATE TYPE "ContactScoreCategory" AS ENUM ('high', 'medium', 'low', 'needs_review');

-- AlterTable
ALTER TABLE "Company"
ADD COLUMN "bestPersonId" TEXT,
ADD COLUMN "bestContactId" TEXT,
ADD COLUMN "bestContactScore" INTEGER,
ADD COLUMN "scoredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ContactScore" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "personId" TEXT,
    "contactId" TEXT,
    "targetRole" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "category" "ContactScoreCategory" NOT NULL,
    "reasonsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactScore_companyId_score_idx" ON "ContactScore"("companyId", "score");

-- CreateIndex
CREATE INDEX "ContactScore_companyId_category_idx" ON "ContactScore"("companyId", "category");

-- CreateIndex
CREATE INDEX "ContactScore_personId_idx" ON "ContactScore"("personId");

-- CreateIndex
CREATE INDEX "ContactScore_contactId_idx" ON "ContactScore"("contactId");

-- AddForeignKey
ALTER TABLE "ContactScore" ADD CONSTRAINT "ContactScore_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactScore" ADD CONSTRAINT "ContactScore_personId_fkey" FOREIGN KEY ("personId") REFERENCES "CompanyPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactScore" ADD CONSTRAINT "ContactScore_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CompanyContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
