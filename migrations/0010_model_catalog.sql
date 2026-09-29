-- Random sample-model catalog for trial machines (Lever 1, 2026-09-29 plan).
--
-- Additive only: two new tables, no existing table is touched.
-- catalog_models    — runtime selection fields; copy payload lives in the
--                     per-model manifest.json object in R2 (read once per claim).
-- catalog_grants    — one row per claim; quota ledger ("N per machine") and
--                     analysis record. Retries reuse the same row.

CREATE TABLE `catalog_models` (
  `id` text PRIMARY KEY NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `weight` integer NOT NULL DEFAULT 1,
  `sha256` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `r2_key_vrm` text NOT NULL,
  `r2_key_thumb` text NOT NULL,
  `manifest_key` text NOT NULL,
  `locales` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE `catalog_grants` (
  `grant_id` text PRIMARY KEY NOT NULL,
  `fingerprint_hash` text NOT NULL,
  `model_id` text NOT NULL,
  `locale` text NOT NULL,
  `country` text,
  `status` text NOT NULL DEFAULT 'claimed',
  `app_version` text,
  `platform` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `imported_at` text
);

CREATE INDEX `catalog_models_enabled_idx` ON `catalog_models` (`enabled`);
CREATE INDEX `catalog_grants_fingerprint_idx` ON `catalog_grants` (`fingerprint_hash`);
CREATE INDEX `catalog_grants_model_idx` ON `catalog_grants` (`model_id`);
