-- Model catalog card master flag (Lever 1): admin-dashboard one-click
-- show/hide for the workshop card. Key-value so future catalog switches can
-- live here without another migration. Absent key = card hidden (default off).

CREATE TABLE `catalog_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

-- Default OFF: the card stays hidden until enabled from the admin dashboard.
INSERT INTO `catalog_settings` (`key`, `value`) VALUES ('card_enabled', 'false')
ON CONFLICT(`key`) DO NOTHING;
