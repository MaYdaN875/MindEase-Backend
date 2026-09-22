ALTER TABLE "PaymentAttempt" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'MOCK';
ALTER TABLE "PaymentAttempt" ADD COLUMN "providerIntentId" TEXT;
CREATE UNIQUE INDEX "PaymentAttempt_providerIntentId_key" ON "PaymentAttempt"("providerIntentId");
CREATE TABLE "StripeWebhookEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
