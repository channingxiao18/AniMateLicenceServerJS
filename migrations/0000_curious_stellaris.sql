CREATE TABLE `activation_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text,
	`entitlement_id` integer,
	`fingerprint` text,
	`action` text NOT NULL,
	`ip_address` text,
	`response_code` integer,
	`detail` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entitlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` text NOT NULL,
	`edition` text NOT NULL,
	`tier` text NOT NULL,
	`features_json` text DEFAULT '[]' NOT NULL,
	`max_app_major` integer DEFAULT 1 NOT NULL,
	`source_channel` text DEFAULT 'wechat_order' NOT NULL,
	`external_ref` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`valid_from` text,
	`valid_until` text,
	`fingerprint` text,
	`metadata_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`product_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`order_id` text PRIMARY KEY NOT NULL,
	`entitlement_id` integer NOT NULL,
	`status` text DEFAULT 'unused' NOT NULL,
	`channel` text DEFAULT 'wechat_order' NOT NULL,
	`batch_id` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`used_at` text,
	FOREIGN KEY (`entitlement_id`) REFERENCES `entitlements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_entitlement_id_unique` ON `orders` (`entitlement_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`product_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`edition` text DEFAULT 'companion' NOT NULL,
	`tier` text DEFAULT 'basic' NOT NULL,
	`type` text DEFAULT 'lifetime' NOT NULL,
	`max_app_major` integer DEFAULT 1 NOT NULL,
	`billing_period_days` integer,
	`grace_days` integer,
	`features_json` text DEFAULT '[]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
