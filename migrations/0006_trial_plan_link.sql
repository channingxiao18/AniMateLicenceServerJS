-- Link trial grants to product trial plans so trial licensing follows the same
-- product/plan model as paid licences.
ALTER TABLE `trial_grants` ADD COLUMN `plan_id` text REFERENCES `plans`(`plan_id`);

INSERT INTO `plans` (
  `plan_id`,
  `product_id`,
  `name`,
  `edition`,
  `tier`,
  `billing_model`,
  `license_model`,
  `max_activations`,
  `max_app_major`,
  `duration_days`,
  `features_json`,
  `is_active`,
  `sort_order`,
  `metadata_json`
)
SELECT
  'animate-import-vrm-trial-24h-v1',
  'animate',
  'AniMate Import VRM Trial 24h',
  'companion',
  'trial',
  'trial',
  'single_machine',
  1,
  1,
  1,
  '["import_vrm"]',
  true,
  10,
  '{"trial_feature":"import_vrm","duration_seconds":86400}'
WHERE NOT EXISTS (
  SELECT 1 FROM `plans` WHERE `plan_id` = 'animate-import-vrm-trial-24h-v1'
);

UPDATE `trial_grants`
SET `plan_id` = 'animate-import-vrm-trial-24h-v1'
WHERE `product_id` = 'animate'
  AND `feature` = 'import_vrm'
  AND `plan_id` IS NULL;
