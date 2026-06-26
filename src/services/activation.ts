/**
 * Core business logic for product plans, licences, entitlements and devices.
 */

import { and, desc, eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  activationLogs,
  activations,
  auditLogs,
  entitlements,
  licenses,
  plans,
  products,
  providerMappings,
  subscriptions,
  webhookEvents,
} from "../db/schema";
import { createAuthInfo } from "../licence/auth_info";
import { issueLicence, parseAppMajor } from "../licence/codec";
import {
  generateOrderId,
  OrderIdValidationError,
  validateOrderId,
} from "../licence/order_id";
import type { ProviderAdapter, ProviderRegistry, ExternalActivationResult } from "./provider";

export class ActivationError extends Error {
  error: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    error: string,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.error = error;
    this.statusCode = statusCode;
    this.details = details;
    this.name = "ActivationError";
  }
}

export type LicenceResponse = {
  licence: string;
  entitlement: Record<string, unknown>;
};

type Product = typeof products.$inferSelect;
type Plan = typeof plans.$inferSelect;
type Entitlement = typeof entitlements.$inferSelect;
type License = typeof licenses.$inferSelect;
type Activation = typeof activations.$inferSelect;

type LicenceBundle = {
  license: License;
  entitlement: Entitlement;
  product: Product;
  plan: Plan;
};

export function nowISO(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

export function addDays(date: Date, days: number): string {
  const next = new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  return next.toISOString().replace("T", " ").substring(0, 19);
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateIsPast(value: string | null, now = new Date()): boolean {
  const date = parseDate(value);
  return !!date && date.getTime() < now.getTime();
}

export function daysUntil(value: string | null, now = new Date()): number {
  const date = parseDate(value);
  if (!date) return 0;
  return Math.max(1, Math.ceil((date.getTime() - now.getTime()) / 86400000));
}

export function computeLicenceValidDays(params: {
  billingModel: string;
  validUntil: string | null;
  refreshIntervalDays: number | null;
  offlineCacheDays: number | null;
  now?: Date;
}): number {
  if (params.billingModel === "lifetime") return 0;
  const now = params.now || new Date();
  const untilDays = daysUntil(params.validUntil, now);
  const policyDays = params.offlineCacheDays || params.refreshIntervalDays || 7;
  return Math.max(1, Math.min(untilDays || policyDays, policyDays));
}

export function computeInitialValidUntil(plan: Plan, now = new Date()): string | null {
  if (plan.billingModel === "lifetime") return null;
  if (plan.billingModel === "subscription") {
    return addDays(now, plan.billingPeriodDays || 30);
  }
  return addDays(now, plan.durationDays || plan.billingPeriodDays || 14);
}

function normalizeProductId(productId: string | null | undefined, config: AppConfig): string {
  return (productId || config.defaultProductId).trim();
}

function assertProductMatches(requestProductId: string, bundle: LicenceBundle): void {
  if (bundle.product.productId !== requestProductId) {
    throw new ActivationError(
      "LICENSE_PRODUCT_MISMATCH",
      "此授权码不适用于当前产品",
      403
    );
  }
}

function assertAppVersion(plan: Plan, appVersion: string | null): void {
  const major = parseAppMajor(appVersion || "0.1.0");
  if (major !== null && major > plan.maxAppMajor) {
    throw new ActivationError(
      "APP_VERSION_NOT_COVERED",
      `当前 App 版本不受此授权套餐覆盖（最高 ${plan.maxAppMajor}.x）`,
      403
    );
  }
}

function assertPlanUsable(product: Product, plan: Plan): void {
  if (product.status !== "active") {
    throw new ActivationError("PRODUCT_INACTIVE", "产品已停用", 403);
  }
  if (!plan.isActive) {
    throw new ActivationError("PLAN_INACTIVE", "授权套餐已停用", 403);
  }
}

function assertEntitlementUsable(
  entitlement: Entitlement,
  mode: "activate" | "refresh",
  plan?: Plan | null
): void {
  if (entitlement.status === "revoked") {
    throw new ActivationError("ENTITLEMENT_REVOKED", "授权已作废", 403);
  }
  if (entitlement.status === "suspended") {
    throw new ActivationError("ENTITLEMENT_SUSPENDED", "授权已暂停", 403);
  }
  if (entitlement.status === "expired" || dateIsPast(entitlement.validUntil)) {
    throw new ActivationError("ENTITLEMENT_EXPIRED", "授权已过期", 403);
  }
  if (mode === "activate" && entitlement.status === "grace") {
    if (!plan?.allowNewDeviceDuringGrace) {
      throw new ActivationError("ENTITLEMENT_GRACE", "宽限期内不允许新增设备", 403);
    }
  }
}

async function writeActivationLog(
  db: Database,
  params: {
    licenseKey: string | null;
    entitlementId: number | null;
    fingerprint: string | null;
    action: string;
    ipAddress: string;
    responseCode: number;
    detail?: Record<string, unknown> | null;
  }
): Promise<void> {
  await db.insert(activationLogs).values({
    licenseKey: params.licenseKey,
    entitlementId: params.entitlementId,
    fingerprint: params.fingerprint,
    action: params.action,
    ipAddress: params.ipAddress,
    responseCode: params.responseCode,
    detail: params.detail ? JSON.stringify(params.detail) : null,
  });
}

export async function writeAuditLog(
  db: Database,
  params: {
    action: string;
    targetType: string;
    targetId: string;
    actor?: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    ipAddress?: string | null;
  }
): Promise<void> {
  await db.insert(auditLogs).values({
    actor: params.actor || "system",
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    beforeJson: params.before ? JSON.stringify(params.before) : null,
    afterJson: params.after ? JSON.stringify(params.after) : null,
    reason: params.reason || null,
    ipAddress: params.ipAddress || null,
  });
}

export async function loadPlanBundle(db: Database, planId: string): Promise<{ plan: Plan; product: Product }> {
  const plan = await db.select().from(plans).where(eq(plans.planId, planId)).get();
  if (!plan) throw new ActivationError("PLAN_NOT_FOUND", "授权套餐不存在", 404);
  const product = await db
    .select()
    .from(products)
    .where(eq(products.productId, plan.productId))
    .get();
  if (!product) throw new ActivationError("PRODUCT_NOT_FOUND", "产品不存在", 404);
  return { plan, product };
}

async function loadLicenceBundle(db: Database, licenseKey: string): Promise<LicenceBundle> {
  const license = await db
    .select()
    .from(licenses)
    .where(eq(licenses.licenseKey, licenseKey))
    .get();
  if (!license) throw new ActivationError("LICENSE_NOT_FOUND", "授权码不存在", 404);

  const entitlement = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.id, license.entitlementId))
    .get();
  if (!entitlement) throw new ActivationError("ENTITLEMENT_NOT_FOUND", "授权记录不存在", 404);

  const { plan, product } = await loadPlanBundle(db, entitlement.planId);
  return { license, entitlement, plan, product };
}

export async function findProviderPlan(
  db: Database,
  provider: string,
  externalProductId: string | null,
  defaultPlanId: string
): Promise<{ plan: Plan; product: Product }> {
  let mapping = externalProductId
    ? await db
        .select()
        .from(providerMappings)
        .where(
          and(
            eq(providerMappings.provider, provider),
            eq(providerMappings.externalProductId, externalProductId),
            eq(providerMappings.isActive, true)
          )
        )
        .get()
    : null;

  if (!mapping) {
    mapping = await db
      .select()
      .from(providerMappings)
      .where(and(eq(providerMappings.provider, provider), eq(providerMappings.isActive, true)))
      .get();
  }

  const planId = mapping?.localPlanId || defaultPlanId;
  return loadPlanBundle(db, planId);
}

export async function createEntitlementAndLicense(
  db: Database,
  params: {
    licenseKey: string;
    plan: Plan;
    sourceProvider: string;
    sourceChannel: string;
    status?: string;
    customerEmail?: string | null;
    externalRef?: string | null;
    batchId?: string | null;
    notes?: string | null;
    externalInstanceId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<number> {
  const [inserted] = await db
    .insert(entitlements)
    .values({
      productId: params.plan.productId,
      planId: params.plan.planId,
      status: params.status || "pending",
      customerEmail: params.customerEmail || null,
      sourceProvider: params.sourceProvider,
      sourceChannel: params.sourceChannel,
      externalRef: params.externalRef || params.licenseKey,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
    })
    .returning({ id: entitlements.id });

  if (!inserted?.id) {
    throw new ActivationError("SERVER_ERROR", "创建授权记录失败", 500);
  }

  await db.insert(licenses).values({
    licenseKey: params.licenseKey,
    entitlementId: inserted.id,
    status: "unused",
    channel: params.sourceChannel,
    batchId: params.batchId || null,
    notes: params.notes || null,
    externalInstanceId: params.externalInstanceId || null,
    externalProviderKey: params.sourceProvider === "manual" ? null : params.licenseKey,
  });

  return inserted.id;
}

async function ensureExternalLicence(
  db: Database,
  config: AppConfig,
  registry: ProviderRegistry,
  params: {
    licenseKey: string;
    fingerprint: string;
    platform: string | null;
    appVersion: string | null;
  }
): Promise<string> {
  // Fast path: AM-XXXXXXXXXXXX is a locally-generated key.
  try {
    validateOrderId(params.licenseKey);
    return "manual";
  } catch {
    // Not a valid AM- key — proceed to external provider identification.
  }

  // Check if already imported from a previous activation.
  const existing = await db
    .select()
    .from(licenses)
    .where(eq(licenses.licenseKey, params.licenseKey))
    .get();
  if (existing) return existing.channel;

  // Phase 1: format-based identification — try the best-match adapter first.
  // Phase 2: if Phase 1's adapter failed or no format match, poll every
  // registered adapter by calling its real API. First to accept the key wins.
  const matchedAdapter = registry.identifyProvider(params.licenseKey);
  const errors: string[] = [];
  const tried = new Set<string>();

  if (matchedAdapter) {
    tried.add(matchedAdapter.name);
    try {
      return tryActivateWithAdapter(
        db, config, matchedAdapter,
        params.licenseKey, params.fingerprint,
        params.platform, params.appVersion,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${matchedAdapter.name}: ${msg}`);
      // Fall through to polling — Phase 1 failed.
    }
  }

  // Phase 2: poll remaining adapters (skip the one already tried).
  for (const adapter of registry.listAll()) {
    if (tried.has(adapter.name)) continue;
    try {
      return tryActivateWithAdapter(
        db, config, adapter,
        params.licenseKey, params.fingerprint,
        params.platform, params.appVersion,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${adapter.name}: ${msg}`);
    }
  }

  throw new ActivationError(
    "INVALID_KEY_FORMAT",
    errors.length
      ? `授权码验证失败（已尝试: ${errors.join("; ")}）`
      : "授权码格式无效，未找到匹配的支付平台",
    400,
  );
}

async function tryActivateWithAdapter(
  db: Database,
  config: AppConfig,
  adapter: ProviderAdapter,
  licenseKey: string,
  fingerprint: string,
  platform: string | null,
  appVersion: string | null,
): Promise<string> {
  let result: ExternalActivationResult;
  try {
    result = await adapter.activate(licenseKey, fingerprint);
  } catch (err) {
    if (err instanceof ActivationError) throw err;
    const message = err instanceof Error ? err.message : "未知错误";
    throw new ActivationError(
      "PROVIDER_ACTIVATION_FAILED",
      `${adapter.name} 激活失败: ${message}`,
      502,
    );
  }

  // Resolve local plan via provider_mappings table.
  const { plan } = await findProviderPlan(
    db,
    adapter.name,
    result.externalProductId,
    config.creemDefaultPlanId,
  );
  await createEntitlementAndLicense(db, {
    licenseKey,
    plan,
    sourceProvider: adapter.name,
    sourceChannel: adapter.name,
    status: "pending",
    externalRef: licenseKey,
    externalInstanceId: result.instanceId,
    metadata: {
      ...(result.metadata || {}),
      app_version: appVersion,
      platform,
    },
  });

  return adapter.name;
}

async function upsertActivation(
  db: Database,
  bundle: LicenceBundle,
  params: {
    fingerprint: string;
    platform: string | null;
    appVersion: string | null;
    machineName?: string | null;
  }
): Promise<{ activation: Activation; reissue: boolean }> {
  const existing = await db
    .select()
    .from(activations)
    .where(
      and(
        eq(activations.entitlementId, bundle.entitlement.id),
        eq(activations.fingerprint, params.fingerprint)
      )
    )
    .get();

  const now = nowISO();
  if (existing) {
    if (existing.status !== "active") {
      if (!bundle.plan.allowReactivation) {
        throw new ActivationError("DEVICE_DEACTIVATED", "该设备已解绑，不允许重新激活", 403);
      }
      await db
        .update(activations)
        .set({
          status: "active",
          platform: params.platform,
          appVersion: params.appVersion,
          machineName: params.machineName || existing.machineName,
          licenceIssuedAt: now,
          lastSeenAt: now,
          deactivatedAt: null,
        })
        .where(eq(activations.id, existing.id));
    } else {
      await db
        .update(activations)
        .set({
          platform: params.platform,
          appVersion: params.appVersion,
          machineName: params.machineName || existing.machineName,
          licenceIssuedAt: now,
          lastSeenAt: now,
        })
        .where(eq(activations.id, existing.id));
    }
    const updated = await db.select().from(activations).where(eq(activations.id, existing.id)).get();
    return { activation: updated || existing, reissue: true };
  }

  const activeDevices = await db
    .select()
    .from(activations)
    .where(and(eq(activations.entitlementId, bundle.entitlement.id), eq(activations.status, "active")))
    .all();

  if (activeDevices.length >= effectiveMaxActivations(bundle.entitlement, bundle.plan)) {
    throw new ActivationError("ACTIVATION_LIMIT_REACHED", "授权设备数量已达上限", 409);
  }

  const [inserted] = await db
    .insert(activations)
    .values({
      entitlementId: bundle.entitlement.id,
      licenseKey: bundle.license.licenseKey,
      fingerprint: params.fingerprint,
      machineName: params.machineName || null,
      platform: params.platform,
      appVersion: params.appVersion,
      status: "active",
      licenceIssuedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: activations.id });

  if (!inserted?.id) {
    throw new ActivationError("SERVER_ERROR", "创建设备激活记录失败", 500);
  }

  const activation = await db.select().from(activations).where(eq(activations.id, inserted.id)).get();
  if (!activation) throw new ActivationError("SERVER_ERROR", "读取设备激活记录失败", 500);
  return { activation, reissue: false };
}

async function issueBundleLicence(
  config: AppConfig,
  bundle: LicenceBundle,
  fingerprint: string
): Promise<string> {
  const validDay = computeLicenceValidDays({
    billingModel: bundle.plan.billingModel,
    validUntil: bundle.entitlement.validUntil || bundle.entitlement.graceUntil,
    refreshIntervalDays: bundle.plan.refreshIntervalDays,
    offlineCacheDays: bundle.plan.offlineCacheDays,
  });

  const auth = createAuthInfo({
    productId: bundle.product.productId,
    edition: bundle.plan.edition,
    tier: bundle.plan.tier,
    features: JSON.parse(bundle.plan.featuresJson || "[]"),
    maxAppMajor: bundle.plan.maxAppMajor,
    validDay,
  });

  return issueLicence(fingerprint, auth, config.rsaPrivateKeyPkcs8Hex);
}

async function entitlementPayload(db: Database, bundle: LicenceBundle): Promise<Record<string, unknown>> {
  const activeDevices = await db
    .select()
    .from(activations)
    .where(and(eq(activations.entitlementId, bundle.entitlement.id), eq(activations.status, "active")))
    .all();

  return {
    product_id: bundle.product.productId,
    product_name: bundle.product.name,
    plan_id: bundle.plan.planId,
    plan_name: bundle.plan.name,
    billing_model: bundle.plan.billingModel,
    license_model: bundle.plan.licenseModel,
    status: bundle.entitlement.status,
    edition: bundle.plan.edition,
    tier: bundle.plan.tier,
    features: JSON.parse(bundle.plan.featuresJson || "[]"),
    max_app_major: bundle.plan.maxAppMajor,
    max_activations: bundle.plan.maxActivations,
    used_activations: activeDevices.length,
    valid_from: bundle.entitlement.validFrom,
    valid_until: bundle.entitlement.validUntil,
    grace_until: bundle.entitlement.graceUntil,
  };
}

export async function activateOrder(
  db: Database,
  config: AppConfig,
  registry: ProviderRegistry,
  params: {
    orderId?: string;
    licenseKey?: string;
    productId?: string | null;
    fingerprint: string;
    appVersion: string | null;
    platform: string | null;
    machineName?: string | null;
    ipAddress: string;
  }
): Promise<LicenceResponse> {
  const licenseKey = (params.licenseKey || params.orderId || "").trim();
  const productId = normalizeProductId(params.productId, config);
  const fingerprint = params.fingerprint.trim();

  if (!licenseKey) {
    throw new ActivationError("INVALID_REQUEST", "license_key 不能为空", 400);
  }
  if (!fingerprint) {
    throw new ActivationError("INVALID_REQUEST", "fingerprint 不能为空", 400);
  }

  await ensureExternalLicence(db, config, registry, {
    licenseKey,
    fingerprint,
    platform: params.platform,
    appVersion: params.appVersion,
  });

  let bundle = await loadLicenceBundle(db, licenseKey);
  assertProductMatches(productId, bundle);
  assertPlanUsable(bundle.product, bundle.plan);
  assertEntitlementUsable(bundle.entitlement, "activate", bundle.plan);
  assertAppVersion(bundle.plan, params.appVersion);

  if (bundle.license.status === "revoked") {
    throw new ActivationError("LICENSE_REVOKED", "授权码已作废", 403);
  }

  const { reissue } = await upsertActivation(db, bundle, {
    fingerprint,
    platform: params.platform,
    appVersion: params.appVersion,
    machineName: params.machineName,
  });

  const now = nowISO();
  const validUntil =
    bundle.entitlement.validUntil || computeInitialValidUntil(bundle.plan, new Date());

  if (!reissue || bundle.entitlement.status === "pending") {
    await db
      .update(entitlements)
      .set({
        status: "active",
        validFrom: bundle.entitlement.validFrom || now,
        validUntil,
        updatedAt: now,
      })
      .where(eq(entitlements.id, bundle.entitlement.id));

    await db
      .update(licenses)
      .set({ status: "used", usedAt: bundle.license.usedAt || now })
      .where(eq(licenses.licenseKey, bundle.license.licenseKey));

    bundle = await loadLicenceBundle(db, licenseKey);
  }

  const licence = await issueBundleLicence(config, bundle, fingerprint);
  await writeActivationLog(db, {
    licenseKey,
    entitlementId: bundle.entitlement.id,
    fingerprint,
    action: reissue ? "activate_reissue" : "activate_success",
    ipAddress: params.ipAddress,
    responseCode: 200,
    detail: {
      product_id: productId,
      platform: params.platform,
      app_version: params.appVersion,
    },
  });

  return { licence, entitlement: await entitlementPayload(db, bundle) };
}

export async function refreshLicence(
  db: Database,
  config: AppConfig,
  params: {
    licenseKey: string;
    productId?: string | null;
    fingerprint: string;
    appVersion: string | null;
    platform: string | null;
    ipAddress: string;
  }
): Promise<LicenceResponse> {
  const licenseKey = params.licenseKey.trim();
  const productId = normalizeProductId(params.productId, config);
  const fingerprint = params.fingerprint.trim();

  const bundle = await loadLicenceBundle(db, licenseKey);
  assertProductMatches(productId, bundle);
  assertPlanUsable(bundle.product, bundle.plan);
  assertEntitlementUsable(bundle.entitlement, "refresh");
  assertAppVersion(bundle.plan, params.appVersion);

  // Lazy expiration: if subscription is canceled or past_due beyond grace, expire.
  const subscription = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.entitlementId, bundle.entitlement.id))
    .get();

  if (subscription) {
    if (subscription.status === "canceled" && subscription.currentPeriodEnd) {
      if (dateIsPast(subscription.currentPeriodEnd)) {
        await db
          .update(entitlements)
          .set({ status: "expired", updatedAt: nowISO() })
          .where(eq(entitlements.id, bundle.entitlement.id));
        throw new ActivationError("ENTITLEMENT_EXPIRED", "订阅已过期", 403);
      }
    }

    // Bug #4 fix: sync entitlement.validUntil from active subscription's currentPeriodEnd.
    // Handles edge cases where a renewal webhook was missed or processed out of order.
    if (
      (subscription.status === "active" || subscription.status === "trialing") &&
      subscription.currentPeriodEnd
    ) {
      const entitlementValidUntil = bundle.entitlement.validUntil;
      if (
        !entitlementValidUntil ||
        subscription.currentPeriodEnd > entitlementValidUntil
      ) {
        await db
          .update(entitlements)
          .set({
            validUntil: subscription.currentPeriodEnd,
            updatedAt: nowISO(),
          })
          .where(eq(entitlements.id, bundle.entitlement.id));
        bundle.entitlement.validUntil = subscription.currentPeriodEnd;
      }
    }

    // Also check past_due subscriptions that are past their grace period.
    if (subscription.status === "past_due" && subscription.currentPeriodEnd) {
      const graceDays = bundle.plan.graceDays || 7;
      const graceExpiry = addDays(
        new Date(subscription.currentPeriodEnd.replace(" ", "T") + "Z"),
        graceDays
      );
      if (dateIsPast(graceExpiry)) {
        await db
          .update(entitlements)
          .set({ status: "expired", updatedAt: nowISO() })
          .where(eq(entitlements.id, bundle.entitlement.id));
        throw new ActivationError("ENTITLEMENT_EXPIRED", "宽限期已过，订阅已过期", 403);
      }
    }
  }

  const activation = await db
    .select()
    .from(activations)
    .where(
      and(
        eq(activations.entitlementId, bundle.entitlement.id),
        eq(activations.fingerprint, fingerprint),
        eq(activations.status, "active")
      )
    )
    .get();

  if (!activation) {
    throw new ActivationError("DEVICE_NOT_ACTIVATED", "当前设备尚未激活", 403);
  }

  // Bug #6 fix: enforce refresh_interval_days based on last refresh time.
  const lastRefresh = activation.lastRefreshAt || activation.lastSeenAt;
  if (bundle.plan.refreshIntervalDays && lastRefresh) {
    const lastRefreshDate = parseDate(lastRefresh);
    if (lastRefreshDate) {
      const nextAllowed = new Date(
        lastRefreshDate.getTime() + bundle.plan.refreshIntervalDays * 86_400_000
      );
      if (new Date() < nextAllowed) {
        throw new ActivationError(
          "REFRESH_TOO_FREQUENT",
          `刷新过于频繁，请 ${Math.ceil((nextAllowed.getTime() - Date.now()) / 86_400_000)} 天后再试`,
          429
        );
      }
    }
  }

  await db
    .update(activations)
    .set({ lastRefreshAt: nowISO(), lastSeenAt: nowISO(), appVersion: params.appVersion, platform: params.platform })
    .where(eq(activations.id, activation.id));

  const licence = await issueBundleLicence(config, bundle, fingerprint);
  await writeActivationLog(db, {
    licenseKey,
    entitlementId: bundle.entitlement.id,
    fingerprint,
    action: "refresh_success",
    ipAddress: params.ipAddress,
    responseCode: 200,
    detail: { product_id: productId },
  });

  return { licence, entitlement: await entitlementPayload(db, bundle) };
}

export async function deactivateOrder(
  db: Database,
  config: AppConfig,
  registry: ProviderRegistry,
  params: {
    orderId?: string;
    licenseKey?: string;
    productId?: string | null;
    fingerprint: string;
    ipAddress: string;
    action?: string;
    /** Set by the route handler after verifying the licence token. */
    expectedFingerprint?: string | null;
  }
): Promise<void> {
  const licenseKey = (params.licenseKey || params.orderId || "").trim();
  const productId = normalizeProductId(params.productId, config);
  const bundle = await loadLicenceBundle(db, licenseKey);
  assertProductMatches(productId, bundle);

  if (!bundle.plan.allowSelfDeactivate && params.action !== "deactivate_admin") {
    throw new ActivationError("SELF_DEACTIVATE_DISABLED", "当前套餐不允许客户端自助解绑", 403);
  }

  // Security gate for client self-deactivation: the licence token fingerprint
  // must match the request fingerprint. Admin bypasses this check.
  if (params.expectedFingerprint && params.action !== "deactivate_admin") {
    if (params.expectedFingerprint !== params.fingerprint) {
      throw new ActivationError(
        "FINGERPRINT_MISMATCH",
        "licence_token 中的设备指纹与请求不匹配，解绑被拒绝",
        403
      );
    }
  }

  const activation = await db
    .select()
    .from(activations)
    .where(
      and(
        eq(activations.entitlementId, bundle.entitlement.id),
        eq(activations.fingerprint, params.fingerprint),
        eq(activations.status, "active")
      )
    )
    .get();

  if (!activation) {
    throw new ActivationError("DEVICE_NOT_ACTIVATED", "当前设备尚未激活", 404);
  }

  if (bundle.license.externalInstanceId && bundle.license.channel !== "manual") {
    const adapter = registry.get(bundle.license.channel);
    if (adapter) {
      try {
        await adapter.deactivate(licenseKey, bundle.license.externalInstanceId);
      } catch (err) {
        if (err instanceof ActivationError) throw err;
        throw new ActivationError(
          "PROVIDER_DEACTIVATION_FAILED",
          `${adapter.name} 停用失败: ${err instanceof Error ? err.message : "未知错误"}`,
          502
        );
      }
    }
  }

  await db
    .update(activations)
    .set({ status: "deactivated", deactivatedAt: nowISO() })
    .where(eq(activations.id, activation.id));

  const remaining = await db
    .select()
    .from(activations)
    .where(and(eq(activations.entitlementId, bundle.entitlement.id), eq(activations.status, "active")))
    .all();

  if (remaining.length === 0) {
    await db
      .update(licenses)
      .set({ status: "unused", usedAt: null })
      .where(eq(licenses.licenseKey, licenseKey));
  }

  await writeActivationLog(db, {
    licenseKey,
    entitlementId: bundle.entitlement.id,
    fingerprint: params.fingerprint,
    action: params.action || "deactivate_user",
    ipAddress: params.ipAddress,
    responseCode: 200,
  });
}

export async function queryLicenseStatus(
  db: Database,
  config: AppConfig,
  params: {
    licenseKey: string;
    productId?: string | null;
    fingerprint?: string | null;
  }
): Promise<{ status: string; entitlement: Record<string, unknown> }> {
  const licenseKey = params.licenseKey.trim();
  const productId = normalizeProductId(params.productId, config);

  if (!licenseKey) {
    throw new ActivationError("INVALID_REQUEST", "license_key 不能为空", 400);
  }

  const bundle = await loadLicenceBundle(db, licenseKey);
  const productMatches = bundle.product.productId === productId;

  const activeDevices = await db
    .select()
    .from(activations)
    .where(and(eq(activations.entitlementId, bundle.entitlement.id), eq(activations.status, "active")))
    .all();

  let currentDeviceActive = false;
  if (params.fingerprint) {
    const deviceActivation = await db
      .select()
      .from(activations)
      .where(
        and(
          eq(activations.entitlementId, bundle.entitlement.id),
          eq(activations.fingerprint, params.fingerprint.trim()),
          eq(activations.status, "active")
        )
      )
      .get();
    currentDeviceActive = !!deviceActivation;
  }

  // Check subscription for lazy expiration.
  const subscription = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.entitlementId, bundle.entitlement.id))
    .get();

  let effectiveStatus = bundle.entitlement.status;
  if (subscription && subscription.status === "canceled" && subscription.currentPeriodEnd) {
    if (dateIsPast(subscription.currentPeriodEnd)) {
      effectiveStatus = "expired";
    }
  }

  return {
    status: effectiveStatus,
    entitlement: {
      product_id: bundle.product.productId,
      product_name: bundle.product.name,
      plan_id: bundle.plan.planId,
      plan_name: bundle.plan.name,
      billing_model: bundle.plan.billingModel,
      license_model: bundle.plan.licenseModel,
      status: effectiveStatus,
      edition: bundle.plan.edition,
      tier: bundle.plan.tier,
      features: JSON.parse(bundle.plan.featuresJson || "[]"),
      max_app_major: bundle.plan.maxAppMajor,
      max_activations: bundle.plan.maxActivations,
      used_activations: activeDevices.length,
      valid_from: bundle.entitlement.validFrom,
      valid_until: bundle.entitlement.validUntil,
      grace_until: bundle.entitlement.graceUntil,
      product_matches: productMatches,
      current_device_active: currentDeviceActive,
      source_provider: bundle.entitlement.sourceProvider,
      subscription: subscription
        ? {
            provider: subscription.provider,
            status: subscription.status,
            current_period_end: subscription.currentPeriodEnd,
          }
        : null,
    },
  };
}

export async function batchCreateOrders(
  db: Database,
  params: {
    count: number;
    productId?: string | null;
    planId?: string | null;
    notes: string | null;
    batchId: string | null;
    customerEmail?: string | null;
    actor?: string;
    ipAddress?: string | null;
  }
): Promise<string[]> {
  if (params.count < 1 || params.count > 1000) {
    throw new ActivationError("INVALID_REQUEST", "count 须在 1-1000", 400);
  }

  const planId = params.planId || params.productId || "animate-companion-lifetime-basic-v1";
  const { plan } = await loadPlanBundle(db, planId);
  if (!plan.isActive) throw new ActivationError("PLAN_INACTIVE", "授权套餐已停用", 403);

  const created: string[] = [];
  for (let i = 0; i < params.count; i++) {
    let licenseKey = generateOrderId();
    let existing = await db.select().from(licenses).where(eq(licenses.licenseKey, licenseKey)).get();
    while (existing) {
      licenseKey = generateOrderId();
      existing = await db.select().from(licenses).where(eq(licenses.licenseKey, licenseKey)).get();
    }

    await createEntitlementAndLicense(db, {
      licenseKey,
      plan,
      sourceProvider: "manual",
      sourceChannel: "manual",
      customerEmail: params.customerEmail || null,
      batchId: params.batchId,
      notes: params.notes,
    });
    created.push(licenseKey);
  }

  await writeAuditLog(db, {
    actor: params.actor,
    action: "licenses.batch_create",
    targetType: "plan",
    targetId: plan.planId,
    after: { count: created.length, batch_id: params.batchId },
    ipAddress: params.ipAddress,
  });

  return created;
}

export const batchCreateLicenses = batchCreateOrders;

export async function createProduct(
  db: Database,
  params: { productId: string; name: string; status?: string; actor?: string; ipAddress?: string | null }
): Promise<void> {
  if (!params.productId.trim() || !params.name.trim()) {
    throw new ActivationError("INVALID_REQUEST", "产品 ID 和名称不能为空", 400);
  }
  await db.insert(products).values({
    productId: params.productId,
    name: params.name,
    status: params.status || "active",
  });
  await writeAuditLog(db, {
    actor: params.actor,
    action: "products.create",
    targetType: "product",
    targetId: params.productId,
    after: params,
    ipAddress: params.ipAddress,
  });
}

export async function updateProduct(
  db: Database,
  params: {
    productId: string;
    name?: string | null;
    status?: string | null;
    actor?: string;
    ipAddress?: string | null;
  }
): Promise<void> {
  const before = await db
    .select()
    .from(products)
    .where(eq(products.productId, params.productId))
    .get();
  if (!before) throw new ActivationError("PRODUCT_NOT_FOUND", "产品不存在", 404);

  const after = {
    name: params.name?.trim() || before.name,
    status: params.status || before.status,
    updatedAt: nowISO(),
  };
  await db.update(products).set(after).where(eq(products.productId, params.productId));
  await writeAuditLog(db, {
    actor: params.actor,
    action: "products.update",
    targetType: "product",
    targetId: params.productId,
    before,
    after,
    ipAddress: params.ipAddress,
  });
}

export async function createPlan(
  db: Database,
  params: {
    planId: string;
    productId: string;
    name: string;
    edition: string;
    tier: string;
    billingModel: string;
    licenseModel: string;
    maxActivations: number;
    maxAppMajor: number;
    durationDays?: number | null;
    billingPeriodDays?: number | null;
    graceDays?: number | null;
    refreshIntervalDays?: number | null;
    offlineCacheDays?: number | null;
    allowSelfDeactivate?: boolean;
    allowReactivation?: boolean;
    allowNewDeviceDuringGrace?: boolean;
    features?: string[];
    metadata?: Record<string, unknown> | null;
    actor?: string;
    ipAddress?: string | null;
  }
): Promise<void> {
  if (!params.planId.trim() || !params.name.trim()) {
    throw new ActivationError("INVALID_REQUEST", "套餐 ID 和名称不能为空", 400);
  }
  const product = await db
    .select()
    .from(products)
    .where(eq(products.productId, params.productId))
    .get();
  if (!product) throw new ActivationError("PRODUCT_NOT_FOUND", "产品不存在", 404);

  await db.insert(plans).values({
    planId: params.planId,
    productId: params.productId,
    name: params.name,
    edition: params.edition,
    tier: params.tier,
    billingModel: params.billingModel,
    licenseModel: params.licenseModel,
    maxActivations: params.maxActivations,
    maxAppMajor: params.maxAppMajor,
    durationDays: params.durationDays || null,
    billingPeriodDays: params.billingPeriodDays || null,
    graceDays: params.graceDays || null,
    refreshIntervalDays: params.refreshIntervalDays || null,
    offlineCacheDays: params.offlineCacheDays || null,
    allowSelfDeactivate: params.allowSelfDeactivate ?? true,
    allowReactivation: params.allowReactivation ?? true,
    allowNewDeviceDuringGrace: params.allowNewDeviceDuringGrace ?? false,
    featuresJson: JSON.stringify(params.features || []),
    metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
  });

  await writeAuditLog(db, {
    actor: params.actor,
    action: "plans.create",
    targetType: "plan",
    targetId: params.planId,
    after: params,
    ipAddress: params.ipAddress,
  });
}

export async function setPlanActive(
  db: Database,
  params: {
    planId: string;
    isActive: boolean;
    actor?: string;
    ipAddress?: string | null;
  }
): Promise<void> {
  const before = await db.select().from(plans).where(eq(plans.planId, params.planId)).get();
  if (!before) throw new ActivationError("PLAN_NOT_FOUND", "授权套餐不存在", 404);
  const after = { isActive: params.isActive, updatedAt: nowISO() };
  await db.update(plans).set(after).where(eq(plans.planId, params.planId));
  await writeAuditLog(db, {
    actor: params.actor,
    action: params.isActive ? "plans.activate" : "plans.deactivate",
    targetType: "plan",
    targetId: params.planId,
    before,
    after,
    ipAddress: params.ipAddress,
  });
}

export async function updatePlan(
  db: Database,
  params: {
    planId: string;
    name?: string | null;
    edition?: string | null;
    tier?: string | null;
    billingModel?: string | null;
    licenseModel?: string | null;
    maxActivations?: number | null;
    maxAppMajor?: number | null;
    durationDays?: number | null;
    billingPeriodDays?: number | null;
    graceDays?: number | null;
    refreshIntervalDays?: number | null;
    offlineCacheDays?: number | null;
    allowSelfDeactivate?: boolean | null;
    allowReactivation?: boolean | null;
    allowNewDeviceDuringGrace?: boolean | null;
    features?: string[] | null;
    metadata?: Record<string, unknown> | null;
    actor?: string;
    ipAddress?: string | null;
  }
): Promise<void> {
  const before = await db.select().from(plans).where(eq(plans.planId, params.planId)).get();
  if (!before) throw new ActivationError("PLAN_NOT_FOUND", "授权套餐不存在", 404);

  const after: Record<string, unknown> = { updatedAt: nowISO() };
  if (params.name !== undefined && params.name !== null) after.name = params.name.trim();
  if (params.edition !== undefined && params.edition !== null) after.edition = params.edition;
  if (params.tier !== undefined && params.tier !== null) after.tier = params.tier;
  if (params.billingModel !== undefined && params.billingModel !== null) after.billingModel = params.billingModel;
  if (params.licenseModel !== undefined && params.licenseModel !== null) after.licenseModel = params.licenseModel;
  if (params.maxActivations !== undefined && params.maxActivations !== null) after.maxActivations = params.maxActivations;
  if (params.maxAppMajor !== undefined && params.maxAppMajor !== null) after.maxAppMajor = params.maxAppMajor;
  if (params.durationDays !== undefined) after.durationDays = params.durationDays;
  if (params.billingPeriodDays !== undefined) after.billingPeriodDays = params.billingPeriodDays;
  if (params.graceDays !== undefined) after.graceDays = params.graceDays;
  if (params.refreshIntervalDays !== undefined) after.refreshIntervalDays = params.refreshIntervalDays;
  if (params.offlineCacheDays !== undefined) after.offlineCacheDays = params.offlineCacheDays;
  if (params.allowSelfDeactivate !== undefined && params.allowSelfDeactivate !== null) after.allowSelfDeactivate = params.allowSelfDeactivate;
  if (params.allowReactivation !== undefined && params.allowReactivation !== null) after.allowReactivation = params.allowReactivation;
  if (params.allowNewDeviceDuringGrace !== undefined && params.allowNewDeviceDuringGrace !== null) after.allowNewDeviceDuringGrace = params.allowNewDeviceDuringGrace;
  if (params.features !== undefined && params.features !== null) after.featuresJson = JSON.stringify(params.features);
  if (params.metadata !== undefined && params.metadata !== null) after.metadataJson = JSON.stringify(params.metadata);

  await db.update(plans).set(after).where(eq(plans.planId, params.planId));
  await writeAuditLog(db, {
    actor: params.actor,
    action: "plans.update",
    targetType: "plan",
    targetId: params.planId,
    before,
    after,
    ipAddress: params.ipAddress,
  });
}

export async function createProviderMapping(
  db: Database,
  params: {
    provider: string;
    externalProductId?: string | null;
    externalVariantId?: string | null;
    localPlanId: string;
    actor?: string;
    ipAddress?: string | null;
  }
): Promise<void> {
  await loadPlanBundle(db, params.localPlanId);
  await db.insert(providerMappings).values({
    provider: params.provider,
    externalProductId: params.externalProductId || null,
    externalVariantId: params.externalVariantId || null,
    localPlanId: params.localPlanId,
  });
  await writeAuditLog(db, {
    actor: params.actor,
    action: "provider_mappings.create",
    targetType: "provider_mapping",
    targetId: `${params.provider}:${params.externalProductId || "*"}`,
    after: params,
    ipAddress: params.ipAddress,
  });
}

export async function setProviderMappingActive(
  db: Database,
  mappingId: number,
  isActive: boolean,
  actor?: string,
  ipAddress?: string | null
): Promise<void> {
  const before = await db
    .select()
    .from(providerMappings)
    .where(eq(providerMappings.id, mappingId))
    .get();
  if (!before) throw new ActivationError("MAPPING_NOT_FOUND", "映射不存在", 404);
  await db
    .update(providerMappings)
    .set({ isActive, updatedAt: nowISO() })
    .where(eq(providerMappings.id, mappingId));
  await writeAuditLog(db, {
    actor,
    action: isActive ? "provider_mappings.activate" : "provider_mappings.deactivate",
    targetType: "provider_mapping",
    targetId: String(mappingId),
    before,
    after: { isActive },
    ipAddress,
  });
}

export async function adminUnbindOrder(
  db: Database,
  registry: ProviderRegistry,
  licenseKey: string,
  ipAddress: string
): Promise<void> {
  const bundle = await loadLicenceBundle(db, licenseKey);

  // Deactivate on external provider if applicable
  if (bundle.license.externalInstanceId && bundle.license.channel !== "manual") {
    const adapter = registry.get(bundle.license.channel);
    if (adapter) {
      try {
        await adapter.deactivate(licenseKey, bundle.license.externalInstanceId);
      } catch {
        // Log but don't block — local state is more important
        console.error(`Provider ${bundle.license.channel} deactivation failed for ${licenseKey}`);
      }
    }
  }
  await db
    .update(activations)
    .set({ status: "deactivated", deactivatedAt: nowISO() })
    .where(and(eq(activations.entitlementId, bundle.entitlement.id), eq(activations.status, "active")));
  await db.update(licenses).set({ status: "unused", usedAt: null }).where(eq(licenses.licenseKey, licenseKey));
  await writeActivationLog(db, {
    licenseKey,
    entitlementId: bundle.entitlement.id,
    fingerprint: null,
    action: "unbind_all",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminUnbindDevice(
  db: Database,
  activationId: number,
  ipAddress: string
): Promise<void> {
  const activation = await db.select().from(activations).where(eq(activations.id, activationId)).get();
  if (!activation) throw new ActivationError("DEVICE_NOT_FOUND", "设备记录不存在", 404);
  if (activation.status !== "active") {
    throw new ActivationError("DEVICE_NOT_ACTIVE", "设备已是非活跃状态", 400);
  }

  await db
    .update(activations)
    .set({ status: "deactivated", deactivatedAt: nowISO() })
    .where(eq(activations.id, activationId));

  // If no more active devices, set license back to unused
  const remaining = await db
    .select()
    .from(activations)
    .where(and(eq(activations.entitlementId, activation.entitlementId), eq(activations.status, "active")))
    .all();

  if (remaining.length === 0 && activation.licenseKey) {
    await db
      .update(licenses)
      .set({ status: "unused", usedAt: null })
      .where(eq(licenses.licenseKey, activation.licenseKey));
  }

  await writeActivationLog(db, {
    licenseKey: activation.licenseKey,
    entitlementId: activation.entitlementId,
    fingerprint: activation.fingerprint,
    action: "unbind_device",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminDeactivateOrder(db: Database, licenseKey: string, ipAddress: string): Promise<void> {
  const bundle = await loadLicenceBundle(db, licenseKey);
  await db
    .update(entitlements)
    .set({ status: "suspended", updatedAt: nowISO() })
    .where(eq(entitlements.id, bundle.entitlement.id));
  await writeActivationLog(db, {
    licenseKey,
    entitlementId: bundle.entitlement.id,
    fingerprint: null,
    action: "suspend_admin",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminRevokeOrder(db: Database, licenseKey: string, ipAddress: string): Promise<void> {
  const bundle = await loadLicenceBundle(db, licenseKey);
  await db.update(licenses).set({ status: "revoked" }).where(eq(licenses.licenseKey, licenseKey));
  await db
    .update(entitlements)
    .set({ status: "revoked", updatedAt: nowISO() })
    .where(eq(entitlements.id, bundle.entitlement.id));
  await writeActivationLog(db, {
    licenseKey,
    entitlementId: bundle.entitlement.id,
    fingerprint: null,
    action: "revoke",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminReactivateOrder(db: Database, licenseKey: string, ipAddress: string): Promise<void> {
  const bundle = await loadLicenceBundle(db, licenseKey);
  if (bundle.entitlement.status === "revoked" || bundle.license.status === "revoked") {
    throw new ActivationError("ENTITLEMENT_REVOKED", "授权已作废，不可恢复", 403);
  }
  await db
    .update(entitlements)
    .set({ status: "active", updatedAt: nowISO() })
    .where(eq(entitlements.id, bundle.entitlement.id));
  await writeActivationLog(db, {
    licenseKey,
    entitlementId: bundle.entitlement.id,
    fingerprint: null,
    action: "reactivate_admin",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminExtendEntitlement(
  db: Database,
  entitlementId: number,
  days: number,
  ipAddress: string
): Promise<void> {
  const entitlement = await db.select().from(entitlements).where(eq(entitlements.id, entitlementId)).get();
  if (!entitlement) throw new ActivationError("ENTITLEMENT_NOT_FOUND", "授权记录不存在", 404);
  const base = parseDate(entitlement.validUntil) || new Date();
  await db
    .update(entitlements)
    .set({ validUntil: addDays(base, days), updatedAt: nowISO() })
    .where(eq(entitlements.id, entitlementId));
  await writeAuditLog(db, {
    action: "entitlements.extend",
    targetType: "entitlement",
    targetId: String(entitlementId),
    before: entitlement,
    after: { days },
    ipAddress,
  });
}

export async function getDashboardStats(db: Database): Promise<Record<string, number>> {
  const [allProducts, allPlans, allLicenses, allEntitlements, allActivations, allSubs] =
    await Promise.all([
      db.select().from(products).all(),
      db.select().from(plans).all(),
      db.select().from(licenses).all(),
      db.select().from(entitlements).all(),
      db.select().from(activations).all(),
      db.select().from(subscriptions).all(),
    ]);
  return {
    products: allProducts.length,
    plans: allPlans.length,
    licenses: allLicenses.length,
    entitlements: allEntitlements.length,
    active_entitlements: allEntitlements.filter((x) => x.status === "active").length,
    active_devices: allActivations.filter((x) => x.status === "active").length,
    subscriptions: allSubs.length,
    revoked: allEntitlements.filter((x) => x.status === "revoked").length,
  };
}

export const getOrderStats = async (db: Database) => {
  const stats = await getDashboardStats(db);
  return {
    total: stats.licenses,
    unused: (await db.select().from(licenses).all()).filter((x) => x.status === "unused").length,
    used: (await db.select().from(licenses).all()).filter((x) => x.status === "used").length,
    deactivated: (await db.select().from(entitlements).all()).filter((x) => x.status === "suspended").length,
    revoked: stats.revoked,
  };
};

export async function listProducts(db: Database) {
  return db.select().from(products).orderBy(products.sortOrder).all();
}

export async function getProductReports(db: Database): Promise<
  Array<{
    product: Product;
    plans: number;
    licenses: number;
    activeEntitlements: number;
    activeDevices: number;
    revoked: number;
  }>
> {
  const [allProducts, allPlans, allEntitlements, allLicenses, allActivations] =
    await Promise.all([
      db.select().from(products).all(),
      db.select().from(plans).all(),
      db.select().from(entitlements).all(),
      db.select().from(licenses).all(),
      db.select().from(activations).all(),
    ]);

  return allProducts.map((product) => {
    const productPlans = allPlans.filter((plan) => plan.productId === product.productId);
    const productEntitlements = allEntitlements.filter(
      (entitlement) => entitlement.productId === product.productId
    );
    const entitlementIds = new Set(productEntitlements.map((entitlement) => entitlement.id));
    return {
      product,
      plans: productPlans.length,
      licenses: allLicenses.filter((license) => entitlementIds.has(license.entitlementId)).length,
      activeEntitlements: productEntitlements.filter((entitlement) => entitlement.status === "active").length,
      activeDevices: allActivations.filter(
        (activation) =>
          activation.status === "active" && entitlementIds.has(activation.entitlementId)
      ).length,
      revoked: productEntitlements.filter((entitlement) => entitlement.status === "revoked").length,
    };
  });
}

export async function listPlans(db: Database) {
  return db.select().from(plans).orderBy(plans.sortOrder).all();
}

export async function listProviderMappings(db: Database) {
  return db.select().from(providerMappings).orderBy(desc(providerMappings.id)).all();
}

export async function listWebhookEvents(db: Database) {
  return db.select().from(webhookEvents).orderBy(desc(webhookEvents.id)).limit(100).all();
}

export async function listAuditLogs(db: Database) {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(100).all();
}

export async function listLicenses(
  db: Database,
  params: { page?: number; pageSize?: number; status?: string; search?: string; productId?: string }
): Promise<{ items: Array<License & { entitlement: Entitlement | null; plan: Plan | null; product: Product | null }>; total: number }> {
  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const all = await db.select().from(licenses).orderBy(desc(licenses.createdAt)).all();

  const enriched = [];
  for (const license of all) {
    const entitlement = await db
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, license.entitlementId))
      .get();
    const plan = entitlement
      ? await db.select().from(plans).where(eq(plans.planId, entitlement.planId)).get()
      : null;
    const product = entitlement
      ? await db.select().from(products).where(eq(products.productId, entitlement.productId)).get()
      : null;
    enriched.push({ ...license, entitlement: entitlement || null, plan: plan || null, product: product || null });
  }

  let filtered = enriched;
  if (params.status) filtered = filtered.filter((x) => x.status === params.status);
  if (params.productId) filtered = filtered.filter((x) => x.entitlement?.productId === params.productId);
  if (params.search) {
    const s = params.search.toUpperCase();
    filtered = filtered.filter(
      (x) =>
        x.licenseKey.toUpperCase().includes(s) ||
        (x.entitlement?.customerEmail || "").toUpperCase().includes(s)
    );
  }

  const total = filtered.length;
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total };
}

export const listOrders = listLicenses;

export async function getLicenseDetail(db: Database, licenseKey: string) {
  const bundle = await loadLicenceBundle(db, licenseKey);
  const devices = await db
    .select()
    .from(activations)
    .where(eq(activations.entitlementId, bundle.entitlement.id))
    .orderBy(desc(activations.id))
    .all();
  const subscription = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.entitlementId, bundle.entitlement.id))
    .get();
  return { ...bundle, devices, subscription: subscription || null };
}

export async function listEntitlements(db: Database) {
  return db.select().from(entitlements).orderBy(desc(entitlements.id)).limit(200).all();
}

export async function listSubscriptions(db: Database) {
  return db.select().from(subscriptions).orderBy(desc(subscriptions.id)).limit(200).all();
}

export async function listActivationLogs(
  db: Database,
  params: { page?: number; pageSize?: number }
): Promise<{ items: Array<typeof activationLogs.$inferSelect>; total: number }> {
  const page = params.page || 1;
  const pageSize = params.pageSize || 50;
  const all = await db.select().from(activationLogs).orderBy(desc(activationLogs.id)).all();
  return {
    items: all.slice((page - 1) * pageSize, page * pageSize),
    total: all.length,
  };
}

// ─── Feature #1: increase device count ──────────────────────────────────────

/** Override the effective max_activations for a single entitlement. */
export async function adminIncreaseDeviceCount(
  db: Database,
  entitlementId: number,
  newMax: number,
  ipAddress: string
): Promise<void> {
  if (newMax < 1 || newMax > 1000) {
    throw new ActivationError("INVALID_REQUEST", "设备数须在 1-1000", 400);
  }
  const entitlement = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.id, entitlementId))
    .get();
  if (!entitlement) throw new ActivationError("ENTITLEMENT_NOT_FOUND", "授权记录不存在", 404);

  const currentMeta = entitlement.metadataJson
    ? (JSON.parse(entitlement.metadataJson) as Record<string, unknown>)
    : {};
  const before = { max_activations_override: currentMeta["max_activations_override"] ?? null };
  currentMeta["max_activations_override"] = newMax;
  await db
    .update(entitlements)
    .set({ metadataJson: JSON.stringify(currentMeta), updatedAt: nowISO() })
    .where(eq(entitlements.id, entitlementId));
  await writeAuditLog(db, {
    action: "entitlements.increase_devices",
    targetType: "entitlement",
    targetId: String(entitlementId),
    before,
    after: { max_activations_override: newMax },
    ipAddress,
  });
}

/** Return effective max_activations, respecting per-entitlement override. */
export function effectiveMaxActivations(entitlement: Entitlement, plan: Plan): number {
  if (entitlement.metadataJson) {
    try {
      const meta = JSON.parse(entitlement.metadataJson) as Record<string, unknown>;
      const override = meta["max_activations_override"];
      if (typeof override === "number" && override > 0) return override;
    } catch { /* ignore */ }
  }
  return plan.maxActivations;
}

// ─── Feature #3: compensate subscription days ───────────────────────────────

export async function adminCompensateSubscription(
  db: Database,
  subscriptionId: number,
  days: number,
  ipAddress: string
): Promise<void> {
  if (days < 1 || days > 3650) {
    throw new ActivationError("INVALID_REQUEST", "天数须在 1-3650", 400);
  }
  const sub = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .get();
  if (!sub) throw new ActivationError("SUBSCRIPTION_NOT_FOUND", "订阅不存在", 404);

  // Extend subscription currentPeriodEnd.
  const base = parseDate(sub.currentPeriodEnd) || new Date();
  const newPeriodEnd = addDays(base, days);
  await db
    .update(subscriptions)
    .set({ currentPeriodEnd: newPeriodEnd, updatedAt: nowISO() })
    .where(eq(subscriptions.id, subscriptionId));

  // Also extend entitlement validUntil.
  const entitlement = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.id, sub.entitlementId))
    .get();
  if (entitlement) {
    const entBase = parseDate(entitlement.validUntil) || new Date();
    await db
      .update(entitlements)
      .set({ validUntil: addDays(entBase, days), updatedAt: nowISO() })
      .where(eq(entitlements.id, entitlement.id));
  }

  await writeAuditLog(db, {
    action: "subscriptions.compensate",
    targetType: "subscription",
    targetId: String(subscriptionId),
    before: { periodEnd: sub.currentPeriodEnd },
    after: { days, newPeriodEnd },
    reason: `补偿 ${days} 天`,
    ipAddress,
  });
}

// ─── Feature #5: batch license operations ───────────────────────────────────

export async function batchSuspendLicenses(
  db: Database,
  licenseKeys: string[],
  ipAddress: string
): Promise<{ succeeded: string[]; failed: Array<{ key: string; error: string }> }> {
  if (licenseKeys.length > 200) {
    throw new ActivationError("INVALID_REQUEST", "单次最多 200 个", 400);
  }
  const succeeded: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const key of licenseKeys) {
    try {
      await adminDeactivateOrder(db, key, ipAddress);
      succeeded.push(key);
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { succeeded, failed };
}

export async function batchRevokeLicenses(
  db: Database,
  licenseKeys: string[],
  ipAddress: string
): Promise<{ succeeded: string[]; failed: Array<{ key: string; error: string }> }> {
  if (licenseKeys.length > 200) {
    throw new ActivationError("INVALID_REQUEST", "单次最多 200 个", 400);
  }
  const succeeded: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const key of licenseKeys) {
    try {
      await adminRevokeOrder(db, key, ipAddress);
      succeeded.push(key);
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { succeeded, failed };
}

export async function batchReactivateLicenses(
  db: Database,
  licenseKeys: string[],
  ipAddress: string
): Promise<{ succeeded: string[]; failed: Array<{ key: string; error: string }> }> {
  if (licenseKeys.length > 200) {
    throw new ActivationError("INVALID_REQUEST", "单次最多 200 个", 400);
  }
  const succeeded: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const key of licenseKeys) {
    try {
      await adminReactivateOrder(db, key, ipAddress);
      succeeded.push(key);
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { succeeded, failed };
}
