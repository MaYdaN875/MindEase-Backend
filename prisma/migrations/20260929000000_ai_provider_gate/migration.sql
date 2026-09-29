CREATE TABLE "AIProviderGate" (
    "key" TEXT NOT NULL,
    "nextAllowedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    CONSTRAINT "AIProviderGate_pkey" PRIMARY KEY ("key")
);
