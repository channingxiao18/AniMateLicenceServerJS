-- Lightweight anonymous product telemetry, isolated from licence tables.
CREATE TABLE `telemetry_events` (
  `event_id` text PRIMARY KEY NOT NULL,
  `schema_version` integer NOT NULL,
  `event` text NOT NULL,
  `source_id` text NOT NULL,
  `received_at` text DEFAULT (datetime('now')) NOT NULL,
  `received_at_unix` integer NOT NULL,
  `sent_at` integer,
  `product_id` text NOT NULL,
  `app_version` text,
  `platform` text,
  `channel` text,
  `machine_hash` text,
  `install_id` text,
  `session_id` text,
  `license_state` text,
  `activation_id` text,
  `payload_json` text NOT NULL,
  `raw_json` text NOT NULL
);

CREATE INDEX `telemetry_events_received_idx` ON `telemetry_events` (`received_at`);
CREATE INDEX `telemetry_events_product_event_idx` ON `telemetry_events` (`product_id`, `event`, `received_at`);
CREATE INDEX `telemetry_events_machine_idx` ON `telemetry_events` (`machine_hash`, `received_at`);
CREATE INDEX `telemetry_events_install_idx` ON `telemetry_events` (`install_id`, `received_at`);
CREATE INDEX `telemetry_events_session_idx` ON `telemetry_events` (`session_id`, `received_at`);

CREATE TABLE `telemetry_session_state` (
  `session_id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `machine_hash` text,
  `install_id` text,
  `app_version` text,
  `platform` text,
  `channel` text,
  `license_state` text,
  `source_id` text NOT NULL,
  `started_at` integer,
  `last_event_at` integer NOT NULL,
  `last_process_duration_secs` integer DEFAULT 0 NOT NULL,
  `last_overlay_visible_secs` integer DEFAULT 0 NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX `telemetry_session_state_machine_idx` ON `telemetry_session_state` (`machine_hash`, `updated_at`);

CREATE TABLE `telemetry_daily_metrics` (
  `day` text NOT NULL,
  `product_id` text NOT NULL,
  `source_id` text NOT NULL,
  `platform` text DEFAULT 'unknown' NOT NULL,
  `channel` text DEFAULT 'official' NOT NULL,
  `app_version` text DEFAULT 'unknown' NOT NULL,
  `license_state` text DEFAULT 'unknown' NOT NULL,
  `downloads` integer DEFAULT 0 NOT NULL,
  `installs` integer DEFAULT 0 NOT NULL,
  `launches` integer DEFAULT 0 NOT NULL,
  `active_secs` integer DEFAULT 0 NOT NULL,
  `overlay_visible_secs` integer DEFAULT 0 NOT NULL,
  `events` integer DEFAULT 0 NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY (`day`, `product_id`, `source_id`, `platform`, `channel`, `app_version`, `license_state`)
);

CREATE TABLE `telemetry_daily_uniques` (
  `day` text NOT NULL,
  `product_id` text NOT NULL,
  `unique_type` text NOT NULL,
  `unique_value` text NOT NULL,
  `source_id` text NOT NULL,
  `platform` text DEFAULT 'unknown' NOT NULL,
  `channel` text DEFAULT 'official' NOT NULL,
  `app_version` text DEFAULT 'unknown' NOT NULL,
  `license_state` text DEFAULT 'unknown' NOT NULL,
  `first_seen_at` text DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY (`day`, `product_id`, `unique_type`, `unique_value`)
);

CREATE INDEX `telemetry_daily_uniques_report_idx`
  ON `telemetry_daily_uniques` (`day`, `product_id`, `unique_type`, `source_id`, `platform`, `channel`, `app_version`, `license_state`);
