/**
 * Drizzle ORM schema for the multi-product licence platform.
 */

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sqliteTable } from "drizzle-orm/sqlite-core";

// Products are client-facing app boundaries, for example AniMate.
export const products = sqliteTable("products", {
  productId: text("product_id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  sortOrder: integer("sort_order").notNull().default(0),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Plans are purchasable SKUs under a product.
export const plans = sqliteTable("plans", {
  planId: text("plan_id").primaryKey(),
  productId: text("product_id")
    .notNull()
    .references(() => products.productId),
  name: text("name").notNull(),
  edition: text("edition").notNull().default("companion"),
  tier: text("tier").notNull().default("basic"),
  billingModel: text("billing_model").notNull().default("lifetime"),
  licenseModel: text("license_model").notNull().default("single_machine"),
  maxActivations: integer("max_activations").notNull().default(1),
  maxAppMajor: integer("max_app_major").notNull().default(1),
  durationDays: integer("duration_days"),
  billingPeriodDays: integer("billing_period_days"),
  graceDays: integer("grace_days"),
  refreshIntervalDays: integer("refresh_interval_days"),
  offlineCacheDays: integer("offline_cache_days"),
  allowSelfDeactivate: integer("allow_self_deactivate", { mode: "boolean" })
    .notNull()
    .default(true),
  allowReactivation: integer("allow_reactivation", { mode: "boolean" })
    .notNull()
    .default(true),
  allowNewDeviceDuringGrace: integer("allow_new_device_during_grace", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  featuresJson: text("features_json").notNull().default("[]"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Entitlements are the internal source of truth for a user's right to use a plan.
export const entitlements = sqliteTable("entitlements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: text("product_id")
    .notNull()
    .references(() => products.productId),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.planId),
  status: text("status").notNull().default("pending"),
  customerEmail: text("customer_email"),
  sourceProvider: text("source_provider").notNull().default("manual"),
  sourceChannel: text("source_channel").notNull().default("manual"),
  externalRef: text("external_ref"),
  validFrom: text("valid_from"),
  validUntil: text("valid_until"),
  graceUntil: text("grace_until"),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Licences are the codes users type into the client.
export const licenses = sqliteTable("licenses", {
  licenseKey: text("license_key").primaryKey(),
  entitlementId: integer("entitlement_id")
    .notNull()
    .unique()
    .references(() => entitlements.id),
  status: text("status").notNull().default("unused"),
  channel: text("channel").notNull().default("manual"),
  batchId: text("batch_id"),
  notes: text("notes"),
  externalInstanceId: text("external_instance_id"),
  externalProviderKey: text("external_provider_key"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  usedAt: text("used_at"),
});

// Backwards-compatible export name for code that still talks about orders.
export const orders = licenses;

export const activations = sqliteTable(
  "activations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entitlementId: integer("entitlement_id")
      .notNull()
      .references(() => entitlements.id),
    licenseKey: text("license_key"),
    fingerprint: text("fingerprint").notNull(),
    machineName: text("machine_name"),
    platform: text("platform"),
    appVersion: text("app_version"),
    status: text("status").notNull().default("active"),
    activatedAt: text("activated_at").notNull().default(sql`(datetime('now'))`),
    licenceIssuedAt: text("licence_issued_at"),
    lastRefreshAt: text("last_refresh_at"),
    lastSeenAt: text("last_seen_at"),
    deactivatedAt: text("deactivated_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    entitlementFingerprintIdx: uniqueIndex(
      "activations_entitlement_fingerprint_unique"
    ).on(table.entitlementId, table.fingerprint),
  })
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entitlementId: integer("entitlement_id")
      .notNull()
      .references(() => entitlements.id),
    provider: text("provider").notNull(),
    externalSubscriptionId: text("external_subscription_id").notNull(),
    externalCustomerId: text("external_customer_id"),
    status: text("status").notNull().default("active"),
    currentPeriodStart: text("current_period_start"),
    currentPeriodEnd: text("current_period_end"),
    graceUntil: text("grace_until"),
    canceledAt: text("canceled_at"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    providerSubscriptionIdx: uniqueIndex(
      "subscriptions_provider_external_unique"
    ).on(table.provider, table.externalSubscriptionId),
  })
);

export const providerMappings = sqliteTable("provider_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  externalProductId: text("external_product_id"),
  externalVariantId: text("external_variant_id"),
  localPlanId: text("local_plan_id")
    .notNull()
    .references(() => plans.planId),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const webhookEvents = sqliteTable("webhook_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  externalEventId: text("external_event_id"),
  eventType: text("event_type").notNull(),
  status: text("status").notNull().default("pending"),
  rawPayloadJson: text("raw_payload_json").notNull(),
  errorMessage: text("error_message"),
  occurredAt: text("occurred_at"),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actor: text("actor").notNull().default("system"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  reason: text("reason"),
  ipAddress: text("ip_address"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const activationLogs = sqliteTable("activation_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  licenseKey: text("license_key"),
  entitlementId: integer("entitlement_id"),
  fingerprint: text("fingerprint"),
  action: text("action").notNull(),
  ipAddress: text("ip_address"),
  responseCode: integer("response_code"),
  detail: text("detail"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const trialGrants = sqliteTable(
  "trial_grants",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.productId),
    feature: text("feature").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    startedAt: text("started_at").notNull(),
    validUntil: text("valid_until").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    status: text("status").notNull().default("active"),
    licenceTokenHash: text("licence_token_hash"),
    appVersion: text("app_version"),
    platform: text("platform"),
    ipHash: text("ip_hash"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    productFeatureFingerprintIdx: uniqueIndex(
      "trial_grants_product_feature_fingerprint_unique"
    ).on(table.productId, table.feature, table.fingerprintHash),
  })
);

export const telemetryEvents = sqliteTable(
  "telemetry_events",
  {
    eventId: text("event_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    event: text("event").notNull(),
    sourceId: text("source_id").notNull(),
    receivedAt: text("received_at").notNull().default(sql`(datetime('now'))`),
    receivedAtUnix: integer("received_at_unix").notNull(),
    sentAt: integer("sent_at"),
    productId: text("product_id").notNull(),
    appVersion: text("app_version"),
    platform: text("platform"),
    channel: text("channel"),
    machineHash: text("machine_hash"),
    installId: text("install_id"),
    sessionId: text("session_id"),
    licenseState: text("license_state"),
    activationId: text("activation_id"),
    payloadJson: text("payload_json").notNull(),
    rawJson: text("raw_json").notNull(),
  },
  (table) => ({
    receivedIdx: index("telemetry_events_received_idx").on(table.receivedAt),
    productEventIdx: index("telemetry_events_product_event_idx").on(
      table.productId,
      table.event,
      table.receivedAt
    ),
    machineIdx: index("telemetry_events_machine_idx").on(table.machineHash, table.receivedAt),
    installIdx: index("telemetry_events_install_idx").on(table.installId, table.receivedAt),
    sessionIdx: index("telemetry_events_session_idx").on(table.sessionId, table.receivedAt),
  })
);

export const telemetrySessionState = sqliteTable(
  "telemetry_session_state",
  {
    sessionId: text("session_id").primaryKey(),
    productId: text("product_id").notNull(),
    machineHash: text("machine_hash"),
    installId: text("install_id"),
    appVersion: text("app_version"),
    platform: text("platform"),
    channel: text("channel"),
    licenseState: text("license_state"),
    sourceId: text("source_id").notNull(),
    startedAt: integer("started_at"),
    lastEventAt: integer("last_event_at").notNull(),
    lastProcessDurationSecs: integer("last_process_duration_secs").notNull().default(0),
    lastOverlayVisibleSecs: integer("last_overlay_visible_secs").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    machineIdx: index("telemetry_session_state_machine_idx").on(table.machineHash, table.updatedAt),
  })
);

export const telemetryDailyMetrics = sqliteTable(
  "telemetry_daily_metrics",
  {
    day: text("day").notNull(),
    productId: text("product_id").notNull(),
    sourceId: text("source_id").notNull(),
    platform: text("platform").notNull().default("unknown"),
    channel: text("channel").notNull().default("official"),
    appVersion: text("app_version").notNull().default("unknown"),
    licenseState: text("license_state").notNull().default("unknown"),
    downloads: integer("downloads").notNull().default(0),
    installs: integer("installs").notNull().default(0),
    launches: integer("launches").notNull().default(0),
    activeSecs: integer("active_secs").notNull().default(0),
    overlayVisibleSecs: integer("overlay_visible_secs").notNull().default(0),
    events: integer("events").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.day,
        table.productId,
        table.sourceId,
        table.platform,
        table.channel,
        table.appVersion,
        table.licenseState,
      ],
    }),
  })
);

export const telemetryDailyUniques = sqliteTable(
  "telemetry_daily_uniques",
  {
    day: text("day").notNull(),
    productId: text("product_id").notNull(),
    uniqueType: text("unique_type").notNull(),
    uniqueValue: text("unique_value").notNull(),
    sourceId: text("source_id").notNull(),
    platform: text("platform").notNull().default("unknown"),
    channel: text("channel").notNull().default("official"),
    appVersion: text("app_version").notNull().default("unknown"),
    licenseState: text("license_state").notNull().default("unknown"),
    firstSeenAt: text("first_seen_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.day, table.productId, table.uniqueType, table.uniqueValue],
    }),
    reportIdx: index("telemetry_daily_uniques_report_idx").on(
      table.day,
      table.productId,
      table.uniqueType,
      table.sourceId,
      table.platform,
      table.channel,
      table.appVersion,
      table.licenseState
    ),
  })
);
