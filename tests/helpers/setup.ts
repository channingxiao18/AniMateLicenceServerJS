/**
 * Integration test helpers: in-memory SQLite, RSA keys, mock provider adapter.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../src/db/schema";
import type { Database as AppDb } from "../../src/db/index";
import type { AppConfig } from "../../src/config";
import {
  ProviderAdapter,
  CanonicalPaymentEvent,
  ExternalActivationResult,
  createProviderRegistry,
  ProviderRegistry,
} from "../../src/services/provider";
import { generateKeyPairSync } from "node:crypto";

// ─── SQLite in-memory DB ──────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS products (
  product_id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  metadata_json text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  plan_id text PRIMARY KEY NOT NULL,
  product_id text NOT NULL REFERENCES products(product_id),
  name text NOT NULL,
  edition text DEFAULT 'companion' NOT NULL,
  tier text DEFAULT 'basic' NOT NULL,
  billing_model text DEFAULT 'lifetime' NOT NULL,
  license_model text DEFAULT 'single_machine' NOT NULL,
  max_activations integer DEFAULT 1 NOT NULL,
  max_app_major integer DEFAULT 1 NOT NULL,
  duration_days integer,
  billing_period_days integer,
  grace_days integer,
  refresh_interval_days integer,
  offline_cache_days integer,
  allow_self_deactivate integer DEFAULT 1 NOT NULL,
  allow_reactivation integer DEFAULT 1 NOT NULL,
  allow_new_device_during_grace integer DEFAULT 0 NOT NULL,
  features_json text DEFAULT '[]' NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  metadata_json text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  product_id text NOT NULL REFERENCES products(product_id),
  plan_id text NOT NULL REFERENCES plans(plan_id),
  status text DEFAULT 'pending' NOT NULL,
  customer_email text,
  source_provider text DEFAULT 'manual' NOT NULL,
  source_channel text DEFAULT 'manual' NOT NULL,
  external_ref text,
  valid_from text,
  valid_until text,
  grace_until text,
  metadata_json text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  license_key text PRIMARY KEY NOT NULL,
  entitlement_id integer NOT NULL UNIQUE REFERENCES entitlements(id),
  status text DEFAULT 'unused' NOT NULL,
  channel text DEFAULT 'manual' NOT NULL,
  batch_id text,
  notes text,
  external_instance_id text,
  external_provider_key text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  used_at text
);

CREATE TABLE IF NOT EXISTS activations (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  entitlement_id integer NOT NULL REFERENCES entitlements(id),
  license_key text,
  fingerprint text NOT NULL,
  machine_name text,
  platform text,
  app_version text,
  status text DEFAULT 'active' NOT NULL,
  activated_at text DEFAULT (datetime('now')) NOT NULL,
  licence_issued_at text,
  last_refresh_at text,
  last_seen_at text,
  deactivated_at text,
  metadata_json text
);
CREATE UNIQUE INDEX IF NOT EXISTS activations_entitlement_fingerprint_unique ON activations (entitlement_id, fingerprint);

CREATE TABLE IF NOT EXISTS subscriptions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  entitlement_id integer NOT NULL REFERENCES entitlements(id),
  provider text NOT NULL,
  external_subscription_id text NOT NULL,
  external_customer_id text,
  status text DEFAULT 'active' NOT NULL,
  current_period_start text,
  current_period_end text,
  grace_until text,
  canceled_at text,
  metadata_json text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_external_unique ON subscriptions (provider, external_subscription_id);

CREATE TABLE IF NOT EXISTS provider_mappings (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  provider text NOT NULL,
  external_product_id text,
  external_variant_id text,
  local_plan_id text NOT NULL REFERENCES plans(plan_id),
  is_active integer DEFAULT 1 NOT NULL,
  metadata_json text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  provider text NOT NULL,
  external_event_id text,
  event_type text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  raw_payload_json text NOT NULL,
  error_message text,
  occurred_at text,
  processed_at text,
  created_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  actor text DEFAULT 'system' NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_json text,
  after_json text,
  reason text,
  ip_address text,
  created_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS activation_logs (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  license_key text,
  entitlement_id integer,
  fingerprint text,
  action text NOT NULL,
  ip_address text,
  response_code integer,
  detail text,
  created_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_grants (
  id text PRIMARY KEY NOT NULL,
  product_id text NOT NULL REFERENCES products(product_id),
  feature text NOT NULL,
  fingerprint_hash text NOT NULL,
  started_at text NOT NULL,
  valid_until text NOT NULL,
  duration_seconds integer NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  licence_token_hash text,
  app_version text,
  platform text,
  ip_hash text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trial_grants_product_feature_fingerprint_unique ON trial_grants (product_id, feature, fingerprint_hash);

CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id text PRIMARY KEY NOT NULL,
  schema_version integer NOT NULL,
  event text NOT NULL,
  source_id text NOT NULL,
  received_at text DEFAULT (datetime('now')) NOT NULL,
  received_at_unix integer NOT NULL,
  sent_at integer,
  product_id text NOT NULL,
  app_version text,
  platform text,
  channel text,
  machine_hash text,
  install_id text,
  session_id text,
  license_state text,
  activation_id text,
  payload_json text NOT NULL,
  raw_json text NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_events_received_idx ON telemetry_events (received_at);
CREATE INDEX IF NOT EXISTS telemetry_events_product_event_idx ON telemetry_events (product_id, event, received_at);
CREATE INDEX IF NOT EXISTS telemetry_events_machine_idx ON telemetry_events (machine_hash, received_at);
CREATE INDEX IF NOT EXISTS telemetry_events_install_idx ON telemetry_events (install_id, received_at);
CREATE INDEX IF NOT EXISTS telemetry_events_session_idx ON telemetry_events (session_id, received_at);

CREATE TABLE IF NOT EXISTS telemetry_session_state (
  session_id text PRIMARY KEY NOT NULL,
  product_id text NOT NULL,
  machine_hash text,
  install_id text,
  app_version text,
  platform text,
  channel text,
  license_state text,
  source_id text NOT NULL,
  started_at integer,
  last_event_at integer NOT NULL,
  last_process_duration_secs integer DEFAULT 0 NOT NULL,
  last_overlay_visible_secs integer DEFAULT 0 NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_session_state_machine_idx ON telemetry_session_state (machine_hash, updated_at);

CREATE TABLE IF NOT EXISTS telemetry_daily_metrics (
  day text NOT NULL,
  product_id text NOT NULL,
  source_id text NOT NULL,
  platform text DEFAULT 'unknown' NOT NULL,
  channel text DEFAULT 'official' NOT NULL,
  app_version text DEFAULT 'unknown' NOT NULL,
  license_state text DEFAULT 'unknown' NOT NULL,
  downloads integer DEFAULT 0 NOT NULL,
  installs integer DEFAULT 0 NOT NULL,
  launches integer DEFAULT 0 NOT NULL,
  active_secs integer DEFAULT 0 NOT NULL,
  overlay_visible_secs integer DEFAULT 0 NOT NULL,
  events integer DEFAULT 0 NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY (day, product_id, source_id, platform, channel, app_version, license_state)
);

CREATE TABLE IF NOT EXISTS telemetry_daily_uniques (
  day text NOT NULL,
  product_id text NOT NULL,
  unique_type text NOT NULL,
  unique_value text NOT NULL,
  source_id text NOT NULL,
  platform text DEFAULT 'unknown' NOT NULL,
  channel text DEFAULT 'official' NOT NULL,
  app_version text DEFAULT 'unknown' NOT NULL,
  license_state text DEFAULT 'unknown' NOT NULL,
  first_seen_at text DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY (day, product_id, unique_type, unique_value)
);
CREATE INDEX IF NOT EXISTS telemetry_daily_uniques_report_idx ON telemetry_daily_uniques (day, product_id, unique_type, source_id, platform, channel, app_version, license_state);
`;

export function createTestDb(): { sqlite: Database.Database; db: AppDb } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(CREATE_TABLES_SQL);
  const db = drizzle(sqlite, { schema }) as unknown as AppDb;
  return { sqlite, db };
}

// ─── RSA key generation ──────────────────────────────────────────────────

export function generateTestKeypair(): { privateKeyPkcs8Hex: string; publicKeySpkiHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "der" },
  });

  const { createPrivateKey, createPublicKey } = require("node:crypto");
  const privPkcs1 = createPrivateKey({ key: privateKey, format: "der", type: "pkcs1" });
  const privPkcs8 = privPkcs1.export({ format: "der", type: "pkcs8" }) as Buffer;

  const pubPkcs1 = createPublicKey({ key: publicKey, format: "der", type: "pkcs1" });
  const pubSpki = pubPkcs1.export({ format: "der", type: "spki" }) as Buffer;

  return {
    privateKeyPkcs8Hex: privPkcs8.toString("hex"),
    publicKeySpkiHex: pubSpki.toString("hex"),
  };
}

// ─── Test config ──────────────────────────────────────────────────────────

export function createTestConfig(rsaPrivateKeyPkcs8Hex: string): AppConfig {
  return {
    adminUsername: "admin",
    adminPassword: "test",
    sessionSecret: "test_secret_32_chars_long_key",
    rsaPrivateKeyPkcs8Hex,
    defaultAppVersion: "1.0.0",
    corsOrigins: ["http://localhost:1420"],
    apiHostnames: [],
    adminHostnames: [],
    activateRateLimitIpMax: 1000,
    activateRateLimitIpWindowSeconds: 60,
    activateRateLimitIpFailMax: 1000,
    activateRateLimitIpFailWindowSeconds: 300,
    activateRateLimitOrderFailMax: 1000,
    activateRateLimitOrderFailWindowSeconds: 3600,
    creemApiKey: "",
    creemTestMode: true,
    creemDefaultPlanId: "animate-companion-lifetime-basic-v1",
    defaultProductId: "animate",
    telemetryTokens: "animate-desktop-prod-v1:desktop_prod,animate-desktop-dev:desktop_dev",
    trialEnabled: true,
    trialImportVrmDurationSeconds: 86400,
    trialFingerprintSalt: "test_trial_salt",
  };
}

// ─── Mock provider adapter ────────────────────────────────────────────────

export function createMockProviderAdapter(
  overrides?: Partial<ProviderAdapter>
): ProviderAdapter {
  return {
    name: "mockpay",
    identifiesKey(key: string): boolean {
      return key.toLowerCase().startsWith("mp_");
    },
    async activate(
      _key: string,
      instanceName: string
    ): Promise<ExternalActivationResult> {
      return {
        instanceId: "mock-inst-" + instanceName,
        externalProductId: "mock-ext-prod-001",
        status: "active",
        activationLimit: 1,
        expiresAt: null,
        metadata: { mock_activated_at: new Date().toISOString() },
      };
    },
    async deactivate(_key: string, _instanceId: string): Promise<void> {
      // no-op
    },
    async verifyWebhook(
      _headers: Record<string, string>,
      _rawBody: string
    ): Promise<boolean> {
      return true;
    },
    async parseWebhook(body: unknown): Promise<CanonicalPaymentEvent> {
      const data = body as Record<string, unknown>;
      return {
        provider: "mockpay",
        eventType: (data.eventType as CanonicalPaymentEvent["eventType"]) || "purchase.completed",
        externalCustomerId: data.customer_id as string | undefined,
        externalOrderId: data.order_id as string | undefined,
        externalSubscriptionId: data.subscription_id as string | undefined,
        externalLicenseKey: data.license_key as string | undefined,
        externalProductId: data.product_id as string | undefined,
        externalVariantId: data.variant_id as string | undefined,
        occurredAt: (data.occurred_at as string) || new Date().toISOString(),
        rawPayload: data,
      };
    },
    ...overrides,
  };
}

// ─── Seed helpers ─────────────────────────────────────────────────────────

export async function seedProduct(
  db: AppDb,
  productId: string,
  name: string,
  status = "active"
): Promise<void> {
  await db.insert(schema.products).values({ productId, name, status }).run();
}

export async function seedPlan(
  db: AppDb,
  plan: Partial<typeof schema.plans.$inferInsert> & {
    planId: string;
    productId: string;
    name: string;
  }
): Promise<void> {
  await db
    .insert(schema.plans)
    .values({
      planId: plan.planId,
      productId: plan.productId,
      name: plan.name,
      edition: plan.edition ?? "companion",
      tier: plan.tier ?? "basic",
      billingModel: plan.billingModel ?? "lifetime",
      licenseModel: plan.licenseModel ?? "single_machine",
      maxActivations: plan.maxActivations ?? 1,
      maxAppMajor: plan.maxAppMajor ?? 1,
      durationDays: plan.durationDays ?? null,
      billingPeriodDays: plan.billingPeriodDays ?? null,
      graceDays: plan.graceDays ?? null,
      refreshIntervalDays: plan.refreshIntervalDays ?? null,
      offlineCacheDays: plan.offlineCacheDays ?? null,
      allowSelfDeactivate: plan.allowSelfDeactivate ?? true,
      allowReactivation: plan.allowReactivation ?? true,
      allowNewDeviceDuringGrace: plan.allowNewDeviceDuringGrace ?? false,
      featuresJson: plan.featuresJson ?? "[]",
      isActive: plan.isActive ?? true,
      sortOrder: plan.sortOrder ?? 0,
    })
    .run();
}

export async function seedProviderMapping(
  db: AppDb,
  provider: string,
  localPlanId: string,
  externalProductId?: string | null
): Promise<void> {
  await db
    .insert(schema.providerMappings)
    .values({
      provider,
      externalProductId: externalProductId ?? null,
      externalVariantId: null,
      localPlanId,
      isActive: true,
    })
    .run();
}

// ─── Full test environment factory ────────────────────────────────────────

export interface TestEnv {
  db: AppDb;
  config: AppConfig;
  registry: ProviderRegistry;
  keys: { privateKeyPkcs8Hex: string; publicKeySpkiHex: string };
}

export async function createTestEnv(): Promise<TestEnv> {
  const { db } = createTestDb();
  const keys = generateTestKeypair();
  const config = createTestConfig(keys.privateKeyPkcs8Hex);
  const registry = createProviderRegistry();

  // Register a mock external provider for testing external license keys.
  registry.register(createMockProviderAdapter());

  // Seed default product and plan.
  await seedProduct(db, "animate", "AniMate");
  await seedPlan(db, {
    planId: "animate-companion-lifetime-basic-v1",
    productId: "animate",
    name: "AniMate Companion Lifetime Basic",
    billingModel: "lifetime",
    licenseModel: "single_machine",
    maxActivations: 1,
  });
  await seedProviderMapping(db, "creem", "animate-companion-lifetime-basic-v1");
  await seedProviderMapping(db, "mockpay", "animate-companion-lifetime-basic-v1", "mock-ext-prod-001");

  return { db, config, registry, keys };
}
