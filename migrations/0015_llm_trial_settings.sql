-- Trial LLM pool: dashboard master switch.
--
-- Additive only (one new table, key-value, same shape as catalog_settings /
-- community_settings). Absent key = OFF, so a deploy of this feature changes no
-- behaviour until an operator turns it on from the dashboard — and turning it off
-- again is one click instead of a redeploy.
--
-- Semantics: OFF stops ALL issuance, including machines that already hold a key
-- (their next request gets TRIAL_LLM_DISABLED and the client falls back to the
-- pre-existing "configure your own service" path). That is the point of a kill
-- switch; per-machine precision is what revoking one key or disabling one pool is
-- for.

CREATE TABLE `llm_trial_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);
