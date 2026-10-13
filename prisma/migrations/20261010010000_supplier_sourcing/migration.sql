-- CreateTable
CREATE TABLE "supplier_search_cache" (
    "id" UUID NOT NULL,
    "supplier" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "component_name" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_search_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_api_calls" (
    "id" UUID NOT NULL,
    "supplier" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "results" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "user_id" UUID,
    "project_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_api_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_search_cache_key_key" ON "supplier_search_cache"("key");

-- CreateIndex
CREATE INDEX "supplier_search_cache_expires_at_idx" ON "supplier_search_cache"("expires_at");

-- CreateIndex
CREATE INDEX "supplier_api_calls_supplier_created_at_idx" ON "supplier_api_calls"("supplier", "created_at");