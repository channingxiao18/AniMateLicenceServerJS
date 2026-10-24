-- 0019_pricing_offer.sql
-- Multi-touch pricing-offer campaign (docs/plans/pricing-offer-discount-experiment-plan.md v3).
--
-- Safety: CREATE only. No ALTER/UPDATE/DELETE against existing tables; every new
-- table can be dropped to roll back. The client only needs campaigns/arms/codes/
-- claims; assignments exist so the per-arm denominator is the randomized cohort
-- (ITT), not just the people who happened to claim.

-- Eligibility looks up install age by machine_hash; 0018 only indexed install_day
-- and (version, day).
CREATE INDEX IF NOT EXISTS idx_tip_machine ON telemetry_install_profile (machine_hash);

CREATE TABLE IF NOT EXISTS pricing_offer_campaigns (
  campaign_id                TEXT PRIMARY KEY NOT NULL,
  name                       TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'draft', -- draft|active|paused|ended
  product_id                 TEXT NOT NULL,
  creem_product_id           TEXT NOT NULL,
  applies_to_products_json   TEXT NOT NULL DEFAULT '[]',
  min_install_hours          INTEGER NOT NULL DEFAULT 48,
  min_active_days            INTEGER NOT NULL DEFAULT 2,
  code_expiry_days           INTEGER NOT NULL DEFAULT 14,
  price_cents                INTEGER NOT NULL DEFAULT 990,
  currency                   TEXT NOT NULL DEFAULT 'USD',
  max_impressions            INTEGER NOT NULL DEFAULT 2,
  impression_cooldown_days   INTEGER NOT NULL DEFAULT 7,
  purchase_base_url          TEXT NOT NULL DEFAULT 'https://getanimate.app/buy',
  started_at                 TEXT,
  ended_at                   TEXT,
  metadata_json              TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pricing_offer_campaigns_status_idx
  ON pricing_offer_campaigns (status, created_at);

CREATE TABLE IF NOT EXISTS pricing_offer_arms (
  arm_id             TEXT PRIMARY KEY NOT NULL,
  campaign_id        TEXT NOT NULL REFERENCES pricing_offer_campaigns(campaign_id),
  label              TEXT NOT NULL,              -- '9折' / '8折' / '7折' / '5折'
  discount_percent   INTEGER NOT NULL,          -- 10 / 20 / 30 / 50
  weight             INTEGER NOT NULL DEFAULT 25,
  pool_target        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pricing_offer_arms_campaign_idx
  ON pricing_offer_arms (campaign_id);

-- One row per eligible machine per campaign. The arm is decided here, before the
-- user claims, so the per-arm eligible denominator is a randomized cohort.
CREATE TABLE IF NOT EXISTS pricing_offer_assignments (
  campaign_id   TEXT NOT NULL,
  machine_hash  TEXT NOT NULL,
  arm_id        TEXT NOT NULL,
  assigned_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (campaign_id, machine_hash)
);
CREATE INDEX IF NOT EXISTS pricing_offer_assignments_arm_idx
  ON pricing_offer_assignments (campaign_id, arm_id);

CREATE TABLE IF NOT EXISTS pricing_offer_codes (
  code                   TEXT PRIMARY KEY NOT NULL,
  campaign_id            TEXT NOT NULL,
  arm_id                 TEXT NOT NULL,
  creem_discount_id      TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'available', -- available|issued|redeemed|expired|void
  issued_to_machine_hash TEXT,
  issued_at              TEXT,
  expires_at             TEXT,
  redeem_count           INTEGER NOT NULL DEFAULT 0,
  redeem_checked_at      TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS pricing_offer_codes_machine_unique
  ON pricing_offer_codes (campaign_id, issued_to_machine_hash)
  WHERE issued_to_machine_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS pricing_offer_codes_arm_status
  ON pricing_offer_codes (campaign_id, arm_id, status, created_at);

CREATE TABLE IF NOT EXISTS pricing_offer_claims (
  claim_id            TEXT PRIMARY KEY NOT NULL,
  campaign_id         TEXT NOT NULL,
  arm_id              TEXT NOT NULL,
  machine_hash        TEXT NOT NULL,
  code                TEXT NOT NULL,
  touchpoint          TEXT NOT NULL,              -- review_window|feature_recall|paywall_winback|settings
  stage               TEXT NOT NULL DEFAULT 'first',
  intent_tier         INTEGER,
  app_version         TEXT,
  channel             TEXT,
  locale              TEXT,
  install_age_hours   INTEGER,
  active_days         INTEGER,
  ip_hash             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS pricing_offer_claims_machine_unique
  ON pricing_offer_claims (campaign_id, machine_hash);
CREATE INDEX IF NOT EXISTS pricing_offer_claims_arm_idx
  ON pricing_offer_claims (campaign_id, arm_id, created_at);
