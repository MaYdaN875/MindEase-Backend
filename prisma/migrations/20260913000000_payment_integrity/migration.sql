ALTER TABLE "Payment" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric,2),
  ALTER COLUMN "platformFee" TYPE DECIMAL(12,2) USING ROUND("platformFee"::numeric,2),
  ALTER COLUMN "netAmount" TYPE DECIMAL(12,2) USING ROUND("netAmount"::numeric,2),
  ADD COLUMN "refundId" TEXT,
  ADD COLUMN "refundAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundError" TEXT;
CREATE UNIQUE INDEX "Payment_refundId_key" ON "Payment"("refundId");
ALTER TABLE "PayoutRequest" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric,2),
  ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "PayoutRequest_idempotencyKey_key" ON "PayoutRequest"("idempotencyKey");
CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paymentId" TEXT NOT NULL REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PROCESSING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PaymentAttempt_status_createdAt_idx" ON "PaymentAttempt"("status", "createdAt");
CREATE TABLE "MockGatewayOperation" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
