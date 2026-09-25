CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "patientId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "psychologistId" TEXT NOT NULL REFERENCES "PsychologistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "patientBlocked" BOOLEAN NOT NULL DEFAULT false,
  "psychologistBlocked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Conversation_patientId_psychologistId_key" ON "Conversation"("patientId", "psychologistId");
CREATE INDEX "Conversation_patientId_createdAt_idx" ON "Conversation"("patientId", "createdAt");
CREATE INDEX "Conversation_psychologistId_createdAt_idx" ON "Conversation"("psychologistId", "createdAt");
ALTER TABLE "PrivateMessage" ALTER COLUMN "appointmentId" DROP NOT NULL;
ALTER TABLE "PrivateMessage" ADD COLUMN "conversationId" TEXT;
ALTER TABLE "PrivateMessage" ADD CONSTRAINT "PrivateMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrivateMessage" ADD CONSTRAINT "PrivateMessage_exactly_one_context" CHECK (("appointmentId" IS NOT NULL)::int + ("conversationId" IS NOT NULL)::int = 1);
CREATE UNIQUE INDEX "PrivateMessage_conversationId_senderId_clientId_key" ON "PrivateMessage"("conversationId", "senderId", "clientId");
CREATE INDEX "PrivateMessage_conversationId_sequence_idx" ON "PrivateMessage"("conversationId", "sequence");
CREATE INDEX "PrivateMessage_conversationId_readAt_senderId_idx" ON "PrivateMessage"("conversationId", "readAt", "senderId");
