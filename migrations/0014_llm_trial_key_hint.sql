-- Trial LLM key pool: operator-facing key hint.
--
-- Additive only (one column). The api key itself stays AES-encrypted in
-- `api_key_enc` and is never returned to the dashboard; this column holds only the
-- last 4 characters so an operator can tell two keys apart. A separate column
-- rather than decrypting on every page render: rendering then never touches
-- plaintext secrets, and the hint exists even for a revoked key.
--
-- Nullable because rows created before this migration have no hint; the dashboard
-- shows "—" for those.

ALTER TABLE `llm_trial_keys` ADD COLUMN `key_hint` text;
