-- Add unique index on webhook_events for deduplication (Bug #3 fix).
-- external_event_id may be null for events that have neither order_id nor subscription_id.
-- The partial unique index only covers non-null values.
CREATE UNIQUE INDEX IF NOT EXISTS `webhook_events_provider_external_unique`
  ON `webhook_events` (`provider`, `external_event_id`)
  WHERE `external_event_id` IS NOT NULL;
