-- One-time trial licence grants keyed by product, feature and hashed fingerprint.
CREATE TABLE `trial_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `feature` text NOT NULL,
  `fingerprint_hash` text NOT NULL,
  `started_at` text NOT NULL,
  `valid_until` text NOT NULL,
  `duration_seconds` integer NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `licence_token_hash` text,
  `app_version` text,
  `platform` text,
  `ip_hash` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`product_id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `trial_grants_product_feature_fingerprint_unique`
  ON `trial_grants` (`product_id`, `feature`, `fingerprint_hash`);
