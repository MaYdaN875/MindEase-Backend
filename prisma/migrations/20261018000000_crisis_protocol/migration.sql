CREATE TYPE "CrisisSource" AS ENUM ('AI_ORIENTATION', 'PRIVATE_CHAT', 'CONTACT_CHAT');

CREATE TABLE "CrisisEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "source" "CrisisSource" NOT NULL,
  "sourceId" TEXT,
  "severity" "AIRiskLevel" NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrisisEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CrisisEvent" ADD CONSTRAINT "CrisisEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "CrisisEvent_userId_detectedAt_idx" ON "CrisisEvent"("userId", "detectedAt");
CREATE INDEX "CrisisEvent_source_detectedAt_idx" ON "CrisisEvent"("source", "detectedAt");
CREATE INDEX "CrisisEvent_sourceId_idx" ON "CrisisEvent"("sourceId");
