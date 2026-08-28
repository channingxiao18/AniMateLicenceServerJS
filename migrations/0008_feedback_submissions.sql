CREATE TABLE `feedback_submissions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source` text NOT NULL,
  `message` text NOT NULL,
  `contact` text,
  `app_version` text,
  `locale` text,
  `platform` text NOT NULL,
  `channel` text NOT NULL,
  `client_time_ms` integer,
  `machine_hash` text,
  `ip_address` text,
  `user_agent` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX `feedback_submissions_created_idx`
  ON `feedback_submissions` (`created_at`);
CREATE INDEX `feedback_submissions_source_idx`
  ON `feedback_submissions` (`source`, `created_at`);
CREATE INDEX `feedback_submissions_machine_idx`
  ON `feedback_submissions` (`machine_hash`, `created_at`);
CREATE INDEX `feedback_submissions_ip_idx`
  ON `feedback_submissions` (`ip_address`, `created_at`);
