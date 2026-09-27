-- Additive migration: do not reset or overwrite existing clinical/payment data.
BEGIN;
CREATE TYPE "AIOrientationStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ESCALATED', 'CANCELLED');
CREATE TYPE "AIMessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "AIRiskLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'EMERGENCY');

CREATE TABLE "AIOrientationSession" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "status" "AIOrientationStatus" NOT NULL DEFAULT 'ACTIVE',
  "riskLevel" "AIRiskLevel" NOT NULL DEFAULT 'LOW',
  "summary" TEXT, "needsProfile" JSONB,
  "promptVersion" TEXT NOT NULL DEFAULT '1.0', "provider" TEXT NOT NULL DEFAULT 'MOCK',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AIOrientationSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIMessage" (
  "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "role" "AIMessageRole" NOT NULL,
  "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIMessage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIRecommendation" (
  "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "specialtyId" TEXT NOT NULL,
  "psychologistId" TEXT, "reason" TEXT NOT NULL, "score" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIRecommendation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AICrisisResource" (
  "id" TEXT NOT NULL, "countryCode" TEXT NOT NULL DEFAULT 'MX', "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL, "url" TEXT, "description" TEXT, "type" TEXT NOT NULL DEFAULT 'GENERAL',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AICrisisResource_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AIOrientationSession_userId_status_idx" ON "AIOrientationSession"("userId", "status");
CREATE INDEX "AIOrientationSession_createdAt_idx" ON "AIOrientationSession"("createdAt");
CREATE INDEX "AIMessage_sessionId_createdAt_idx" ON "AIMessage"("sessionId", "createdAt");
CREATE INDEX "AIRecommendation_sessionId_idx" ON "AIRecommendation"("sessionId");
CREATE INDEX "AIRecommendation_psychologistId_idx" ON "AIRecommendation"("psychologistId");
CREATE INDEX "AIRecommendation_specialtyId_idx" ON "AIRecommendation"("specialtyId");
CREATE INDEX "AICrisisResource_countryCode_isActive_idx" ON "AICrisisResource"("countryCode", "isActive");
ALTER TABLE "AIOrientationSession" ADD CONSTRAINT "AIOrientationSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIMessage" ADD CONSTRAINT "AIMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AIOrientationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AIOrientationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_psychologistId_fkey" FOREIGN KEY ("psychologistId") REFERENCES "PsychologistProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
