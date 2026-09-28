BEGIN;
CREATE TABLE "AIMessageRequest" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "claimToken" TEXT NOT NULL,
  "leaseUntil" TIMESTAMP(3) NOT NULL,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AIMessageRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AIMessageRequest_sessionId_requestKey_key" ON "AIMessageRequest"("sessionId", "requestKey");
CREATE INDEX "AIMessageRequest_sessionId_status_idx" ON "AIMessageRequest"("sessionId", "status");
ALTER TABLE "AIMessageRequest" ADD CONSTRAINT "AIMessageRequest_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "AIOrientationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
