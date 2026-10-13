-- Trial LLM key pool (docs/plans/trial-llm-key-plan.md §3.3).
--
-- Additive only: three new tables, no existing table is touched.
--
-- llm_trial_pools — pool-level config. base_url/model/valid_until live here, not
--                   on the key, so switching model or gateway is one row insert
--                   and never needs a client release. `status='disabled'` stops
--                   NEW issuance only; machines already holding one of the
--                   pool's keys keep working (revoke the key to cut them off).
-- llm_trial_keys  — pool members. The api key value is AES-encrypted (same blob
--                   format as licence fingerprints); plaintext never lands here.
--                   `status='revoked'` is the manual kill switch for one key.
-- llm_trial_grants— one row per machine that was issued a key: the idempotency
--                   record (a machine keeps the SAME key across restarts) and the
--                   reference ledger used by the allocation ordering.
--
-- Allocation ordering (see services/llm_trial.ts): candidates ordered by
-- referenced-machine count ASC, then created_at DESC — i.e. "prefer keys nobody
-- uses yet, newest first".

CREATE TABLE `llm_trial_pools` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `note` text,
  `product_id` text NOT NULL,
  `base_url` text NOT NULL,
  `model` text NOT NULL,
  `valid_until` text NOT NULL,
  `platform` text,
  `excluded_countries` text,
  `status` text NOT NULL DEFAULT 'active',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE `llm_trial_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `pool_id` text NOT NULL,
  `api_key_enc` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `note` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `revoked_at` text,
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE `llm_trial_grants` (
  `grant_id` text PRIMARY KEY NOT NULL,
  `fingerprint_hash` text NOT NULL,
  `key_id` text NOT NULL,
  `telemetry_machine_hash` text,
  `valid_until` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `app_version` text,
  `platform` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX `llm_trial_pools_status_idx` ON `llm_trial_pools` (`status`);
CREATE INDEX `llm_trial_keys_pool_idx` ON `llm_trial_keys` (`pool_id`);
CREATE INDEX `llm_trial_keys_status_idx` ON `llm_trial_keys` (`status`);
CREATE INDEX `llm_trial_grants_fingerprint_idx` ON `llm_trial_grants` (`fingerprint_hash`);
CREATE INDEX `llm_trial_grants_key_idx` ON `llm_trial_grants` (`key_id`);
