CREATE TYPE "PatientReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TABLE "PatientReview" (
  "id" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL CHECK ("rating" BETWEEN 1 AND 5),
  "comment" TEXT CHECK (char_length("comment") <= 1000),
  "status" "PatientReviewStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "moderatedAt" TIMESTAMP(3),
  "moderatorId" TEXT,
  "moderationReason" TEXT,
  CONSTRAINT "PatientReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PatientReview_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PatientReview_appointmentId_key" ON "PatientReview"("appointmentId");
CREATE INDEX "PatientReview_status_createdAt_idx" ON "PatientReview"("status", "createdAt");
