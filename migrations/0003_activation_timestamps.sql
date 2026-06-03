-- Track licence issuance and refresh timestamps per activation.
ALTER TABLE `activations` ADD COLUMN `licence_issued_at` text;
ALTER TABLE `activations` ADD COLUMN `last_refresh_at` text;
