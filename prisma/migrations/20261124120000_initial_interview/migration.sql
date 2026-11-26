CREATE TYPE "InitialInterviewStatus" AS ENUM ('IN_PROGRESS', 'ESCALATED', 'COMPLETED');
CREATE TYPE "InitialInterviewAccessAction" AS ENUM ('VIEW_REPORT', 'DOWNLOAD_PDF');
ALTER TYPE "CrisisSource" ADD VALUE 'INITIAL_INTERVIEW';

CREATE TABLE "InitialInterview" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" "InitialInterviewStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "nextQuestionId" TEXT,
    "consentVersion" TEXT NOT NULL,
    "adultConfirmed" BOOLEAN NOT NULL,
    "riskLevel" "AIRiskLevel" NOT NULL DEFAULT 'LOW',
    "answersCiphertext" TEXT,
    "reportCiphertext" TEXT,
    "pdfCiphertext" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InitialInterview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InitialInterviewAccessLog" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "action" "InitialInterviewAccessAction" NOT NULL,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InitialInterviewAccessLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InitialInterview_patientId_key" ON "InitialInterview"("patientId");
CREATE INDEX "InitialInterview_status_updatedAt_idx" ON "InitialInterview"("status", "updatedAt");
CREATE INDEX "InitialInterviewAccessLog_interviewId_accessedAt_idx" ON "InitialInterviewAccessLog"("interviewId", "accessedAt");
CREATE INDEX "InitialInterviewAccessLog_actorUserId_accessedAt_idx" ON "InitialInterviewAccessLog"("actorUserId", "accessedAt");
CREATE INDEX "InitialInterviewAccessLog_appointmentId_idx" ON "InitialInterviewAccessLog"("appointmentId");

ALTER TABLE "InitialInterview"
  ADD CONSTRAINT "InitialInterview_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InitialInterviewAccessLog"
  ADD CONSTRAINT "InitialInterviewAccessLog_interviewId_fkey"
  FOREIGN KEY ("interviewId") REFERENCES "InitialInterview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InitialInterviewAccessLog"
  ADD CONSTRAINT "InitialInterviewAccessLog_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
