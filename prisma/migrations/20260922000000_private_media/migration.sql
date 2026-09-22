CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "filename" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MediaAsset_filename_key" ON "MediaAsset"("filename");
CREATE INDEX "MediaAsset_ownerId_scope_idx" ON "MediaAsset"("ownerId", "scope");
