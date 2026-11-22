CREATE TYPE "LegalAudience" AS ENUM ('ALL', 'PSYCHOLOGIST');
CREATE TABLE "LegalText" (
  "id" TEXT NOT NULL, "code" TEXT NOT NULL, "title" TEXT NOT NULL, "content" TEXT NOT NULL,
  "version" TEXT NOT NULL, "audience" "LegalAudience" NOT NULL DEFAULT 'ALL',
  "isActive" BOOLEAN NOT NULL DEFAULT true, "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "LegalText_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LegalText_code_key" ON "LegalText"("code");
CREATE INDEX "LegalText_isActive_audience_idx" ON "LegalText"("isActive", "audience");
ALTER TABLE "UserConsent" ADD COLUMN "legalTextId" TEXT;
ALTER TABLE "UserConsent" ADD COLUMN "legalCode" TEXT;
ALTER TABLE "UserConsent" ADD COLUMN "legalVersion" TEXT;
ALTER TABLE "UserConsent" ADD CONSTRAINT "UserConsent_legalTextId_fkey" FOREIGN KEY ("legalTextId") REFERENCES "LegalText"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "UserConsent_userId_legalCode_legalVersion_idx" ON "UserConsent"("userId", "legalCode", "legalVersion");
