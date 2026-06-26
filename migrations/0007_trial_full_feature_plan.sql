-- Align the default AniMate trial plan with the full-import trial spec.
-- This only updates the plan configuration; existing trial_grants records keep
-- their original started_at and valid_until values.
UPDATE `plans`
SET
  `name` = 'AniMate Full Feature Trial 24h',
  `features_json` = '["import_vrm","import_dance","import_stage"]',
  `updated_at` = datetime('now')
WHERE `plan_id` = 'animate-import-vrm-trial-24h-v1';

CREATE INDEX IF NOT EXISTS `trial_grants_product_fingerprint_idx`
  ON `trial_grants` (`product_id`, `fingerprint_hash`);
