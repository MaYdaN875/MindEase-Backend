CREATE TABLE "PrivateMessage" (
  "id" TEXT NOT NULL,
  "sequence" SERIAL NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "PrivateMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivateMessage_content_length" CHECK (char_length("content") BETWEEN 1 AND 4000),
  CONSTRAINT "PrivateMessage_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PrivateMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PrivateMessage_sequence_key" ON "PrivateMessage"("sequence");
CREATE UNIQUE INDEX "PrivateMessage_appointmentId_senderId_clientId_key" ON "PrivateMessage"("appointmentId", "senderId", "clientId");
CREATE INDEX "PrivateMessage_appointmentId_sequence_idx" ON "PrivateMessage"("appointmentId", "sequence");
CREATE INDEX "PrivateMessage_appointmentId_readAt_senderId_idx" ON "PrivateMessage"("appointmentId", "readAt", "senderId");
CREATE INDEX "PrivateMessage_senderId_createdAt_idx" ON "PrivateMessage"("senderId", "createdAt");
