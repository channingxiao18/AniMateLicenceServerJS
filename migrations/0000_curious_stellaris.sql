CREATE TABLE `products` (
  `product_id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `metadata_json` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plans` (
  `plan_id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `name` text NOT NULL,
  `edition` text DEFAULT 'companion' NOT NULL,
  `tier` text DEFAULT 'basic' NOT NULL,
  `billing_model` text DEFAULT 'lifetime' NOT NULL,
  `license_model` text DEFAULT 'single_machine' NOT NULL,
  `max_activations` integer DEFAULT 1 NOT NULL,
  `max_app_major` integer DEFAULT 1 NOT NULL,
  `duration_days` integer,
  `billing_period_days` integer,
  `grace_days` integer,
  `refresh_interval_days` integer,
  `offline_cache_days` integer,
  `allow_self_deactivate` integer DEFAULT true NOT NULL,
  `allow_reactivation` integer DEFAULT true NOT NULL,
  `allow_new_device_during_grace` integer DEFAULT false NOT NULL,
  `features_json` text DEFAULT '[]' NOT NULL,
  `is_active` integer DEFAULT true NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `metadata_json` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`product_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `entitlements` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `product_id` text NOT NULL,
  `plan_id` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `customer_email` text,
  `source_provider` text DEFAULT 'manual' NOT NULL,
  `source_channel` text DEFAULT 'manual' NOT NULL,
  `external_ref` text,
  `valid_from` text,
  `valid_until` text,
  `grace_until` text,
  `metadata_json` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`product_id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`plan_id`) REFERENCES `plans`(`plan_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `licenses` (
  `license_key` text PRIMARY KEY NOT NULL,
  `entitlement_id` integer NOT NULL,
  `status` text DEFAULT 'unused' NOT NULL,
  `channel` text DEFAULT 'manual' NOT NULL,
  `batch_id` text,
  `notes` text,
  `external_instance_id` text,
  `external_provider_key` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `used_at` text,
  FOREIGN KEY (`entitlement_id`) REFERENCES `entitlements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_entitlement_id_unique` ON `licenses` (`entitlement_id`);
--> statement-breakpoint
CREATE TABLE `activations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `entitlement_id` integer NOT NULL,
  `license_key` text,
  `fingerprint` text NOT NULL,
  `machine_name` text,
  `platform` text,
  `app_version` text,
  `status` text DEFAULT 'active' NOT NULL,
  `activated_at` text DEFAULT (datetime('now')) NOT NULL,
  `last_seen_at` text,
  `deactivated_at` text,
  `metadata_json` text,
  FOREIGN KEY (`entitlement_id`) REFERENCES `entitlements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activations_entitlement_fingerprint_unique` ON `activations` (`entitlement_id`, `fingerprint`);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `entitlement_id` integer NOT NULL,
  `provider` text NOT NULL,
  `external_subscription_id` text NOT NULL,
  `external_customer_id` text,
  `status` text DEFAULT 'active' NOT NULL,
  `current_period_start` text,
  `current_period_end` text,
  `grace_until` text,
  `canceled_at` text,
  `metadata_json` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`entitlement_id`) REFERENCES `entitlements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_provider_external_unique` ON `subscriptions` (`provider`, `external_subscription_id`);
--> statement-breakpoint
CREATE TABLE `provider_mappings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `provider` text NOT NULL,
  `external_product_id` text,
  `external_variant_id` text,
  `local_plan_id` text NOT NULL,
  `is_active` integer DEFAULT true NOT NULL,
  `metadata_json` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`local_plan_id`) REFERENCES `plans`(`plan_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `provider` text NOT NULL,
  `external_event_id` text,
  `event_type` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `raw_payload_json` text NOT NULL,
  `error_message` text,
  `occurred_at` text,
  `processed_at` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `actor` text DEFAULT 'system' NOT NULL,
  `action` text NOT NULL,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  `before_json` text,
  `after_json` text,
  `reason` text,
  `ip_address` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `activation_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `license_key` text,
  `entitlement_id` integer,
  `fingerprint` text,
  `action` text NOT NULL,
  `ip_address` text,
  `response_code` integer,
  `detail` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
