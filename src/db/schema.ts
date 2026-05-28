/**
 * Drizzle ORM schema — compatible with Python models.py (4 core tables).
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Products ────────────────────────────────────────────────────────────

export const products = sqliteTable("products", {
  productId: text("product_id").primaryKey(),
  name: text("name").notNull(),
  edition: text("edition").notNull().default("companion"),
  tier: text("tier").notNull().default("basic"),
  type: text("type").notNull().default("lifetime"),
  maxAppMajor: integer("max_app_major").notNull().default(1),
  billingPeriodDays: integer("billing_period_days"),
  graceDays: integer("grace_days"),
  featuresJson: text("features_json").notNull().default("[]"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Entitlements ────────────────────────────────────────────────────────

export const entitlements = sqliteTable("entitlements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: text("product_id")
    .notNull()
    .references(() => products.productId),
  edition: text("edition").notNull(),
  tier: text("tier").notNull(),
  featuresJson: text("features_json").notNull().default("[]"),
  maxAppMajor: integer("max_app_major").notNull().default(1),
  sourceChannel: text("source_channel").notNull().default("wechat_order"),
  externalRef: text("external_ref"),
  status: text("status").notNull().default("pending"),
  validFrom: text("valid_from"),
  validUntil: text("valid_until"),
  fingerprint: text("fingerprint"),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Orders ──────────────────────────────────────────────────────────────

export const orders = sqliteTable("orders", {
  orderId: text("order_id").primaryKey(),
  entitlementId: integer("entitlement_id")
    .notNull()
    .unique()
    .references(() => entitlements.id),
  status: text("status").notNull().default("unused"),
  channel: text("channel").notNull().default("wechat_order"),
  batchId: text("batch_id"),
  notes: text("notes"),
  externalInstanceId: text("external_instance_id"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  usedAt: text("used_at"),
});

// ─── Activation Logs ─────────────────────────────────────────────────────

export const activationLogs = sqliteTable("activation_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: text("order_id"),
  entitlementId: integer("entitlement_id"),
  fingerprint: text("fingerprint"),
  action: text("action").notNull(),
  ipAddress: text("ip_address"),
  responseCode: integer("response_code"),
  detail: text("detail"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
