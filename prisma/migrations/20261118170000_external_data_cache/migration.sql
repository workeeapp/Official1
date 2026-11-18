-- Multi-domain ExternalDataCache: provider/scope open strings; TTL via expiresAt.
CREATE TABLE "ExternalDataCaches" (
    "id" UUID NOT NULL,
    "cache_key" VARCHAR(512) NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "ttl_tier" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "last_hit_at" TIMESTAMP(3),

    CONSTRAINT "ExternalDataCaches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalDataCaches_cache_key_key" ON "ExternalDataCaches"("cache_key");

CREATE INDEX "ExternalDataCaches_provider_idx" ON "ExternalDataCaches"("provider");

CREATE INDEX "ExternalDataCaches_scope_idx" ON "ExternalDataCaches"("scope");

CREATE INDEX "ExternalDataCaches_expires_at_idx" ON "ExternalDataCaches"("expires_at");
