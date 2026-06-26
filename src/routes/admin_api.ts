/**
 * Admin REST API routes.
 */

import { Hono } from "hono";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  adminDeactivateOrder,
  adminExtendEntitlement,
  adminReactivateOrder,
  adminRevokeOrder,
  adminUnbindDevice,
  adminUnbindOrder,
  adminIncreaseDeviceCount,
  adminCompensateSubscription,
  batchCreateLicenses,
  batchSuspendLicenses,
  batchRevokeLicenses,
  batchReactivateLicenses,
  createPlan,
  createProduct,
  createProviderMapping,
  ActivationError,
  setPlanActive,
  setProviderMappingActive,
  updatePlan,
  updateProduct,
} from "../services/activation";
import { deleteTrialGrant } from "../services/trial";

import type { ProviderRegistry } from "../services/provider";

function ip(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function readBody(c: {
  req: {
    header(name: string): string | undefined;
    raw: Request;
    json(): Promise<Record<string, unknown>>;
    parseBody(): Promise<Record<string, unknown>>;
    text(): Promise<string>;
  };
}) {
  const contentType = c.req.header("content-type") || "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await c.req.text();
      return Object.fromEntries(new URLSearchParams(text));
    }
    if (contentType.includes("multipart/form-data")) {
      return await c.req.parseBody();
    }
    return await c.req.json();
  } catch {
    return {};
  }
}

function errorResponse(c: any, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : undefined;
  console.error("Admin API error:", message, stack || "");

  let statusCode = 500;
  let errorBody: Record<string, unknown> = { error: "SERVER_ERROR", message: "服务器内部错误" };

  if (err instanceof ActivationError) {
    statusCode = err.statusCode;
    errorBody = { error: err.error, message: err.message };
  } else if (typeof message === "string") {
    if (message.includes("UNIQUE constraint failed")) {
      const match = message.match(/UNIQUE constraint failed: (\S+)/);
      const field = match ? match[1] : "unknown";
      statusCode = 409;
      errorBody = { error: "DUPLICATE_ENTRY", message: `${field} 已存在，请勿重复创建` };
    } else if (message.includes("FOREIGN KEY constraint failed")) {
      statusCode = 400;
      errorBody = { error: "REFERENCE_ERROR", message: "引用的数据不存在，请检查关联字段" };
    } else if (message.includes("NOT NULL constraint failed")) {
      const match = message.match(/NOT NULL constraint failed: (\S+)/);
      const field = match ? match[1] : "unknown";
      statusCode = 400;
      errorBody = { error: "REQUIRED_FIELD", message: `必填字段 ${field} 不能为空` };
    }
  }

  // If this is a browser form submission, redirect back with error message.
  const accept = c.req.header("accept") || "";
  const referer =
    c.req.header("referer") ||
    c.req.header("origin") ||
    "/admin/";
  if (accept.includes("text/html") || referer.includes("/admin")) {
    try {
      const url = new URL(referer, "http://localhost");
      url.searchParams.set("error", String(errorBody.message));
      return c.redirect(url.pathname + url.search);
    } catch {
      // fall through to JSON
    }
  }

  return c.json(errorBody, statusCode);
}

function readPlanMetadata(body: Record<string, unknown>): Record<string, unknown> | null {
  let metadata: Record<string, unknown> = {};
  const raw = body.metadata_json;
  if (raw !== undefined && raw !== null && String(raw).trim()) {
    try {
      const parsed = JSON.parse(String(raw));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      throw new ActivationError("INVALID_REQUEST", "metadata_json 格式无效", 400);
    }
  }

  delete metadata.trial_feature;
  delete metadata.duration_seconds;

  const durationRaw = String(body.trial_duration_seconds || "").trim();
  if (durationRaw) {
    const duration = Number(durationRaw);
    if (!Number.isInteger(duration) || duration < 60) {
      throw new ActivationError("INVALID_REQUEST", "试用时长秒数至少为 60", 400);
    }
    metadata.duration_seconds = duration;
  }

  return Object.keys(metadata).length ? metadata : null;
}

function parseBatchKeys(body: Record<string, unknown>): string[] {
  const raw = body.license_keys || body.keys || "";
  if (typeof raw === "string") {
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return [];
}

function okOrRedirect(c: any, payload: Record<string, unknown>) {
  const accept = c.req.header("accept") || "";
  if (accept.includes("text/html")) {
    const referer = c.req.header("referer") || "/admin/";
    const url = new URL(referer, "http://localhost");
    url.searchParams.set("success", "操作成功");
    return c.redirect(url.pathname + url.search);
  }
  return c.json(payload);
}

export function createAdminApiRouter(db: Database, _config: AppConfig, registry: ProviderRegistry): Hono {
  const router = new Hono();

  router.post("/products", async (c) => {
    const body = await readBody(c);
    try {
      await createProduct(db, {
        productId: String(body.product_id || ""),
        name: String(body.name || ""),
        status: String(body.status || "active"),
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/products/:id", async (c) => {
    const body = await readBody(c);
    try {
      await updateProduct(db, {
        productId: c.req.param("id"),
        name: body.name ? String(body.name) : null,
        status: body.status ? String(body.status) : null,
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/products/:id/deactivate", async (c) => {
    try {
      await updateProduct(db, {
        productId: c.req.param("id"),
        status: "inactive",
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/products/:id/activate", async (c) => {
    try {
      await updateProduct(db, {
        productId: c.req.param("id"),
        status: "active",
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/plans", async (c) => {
    const body = await readBody(c);
    try {
      await createPlan(db, {
        planId: String(body.plan_id || ""),
        productId: String(body.product_id || ""),
        name: String(body.name || ""),
        edition: String(body.edition || "companion"),
        tier: String(body.tier || "basic"),
        billingModel: String(body.billing_model || "lifetime"),
        licenseModel: String(body.license_model || "single_machine"),
        maxActivations: Number(body.max_activations || 1),
        maxAppMajor: Number(body.max_app_major || 1),
        durationDays: body.duration_days ? Number(body.duration_days) : null,
        billingPeriodDays: body.billing_period_days ? Number(body.billing_period_days) : null,
        graceDays: body.grace_days ? Number(body.grace_days) : null,
        refreshIntervalDays: body.refresh_interval_days ? Number(body.refresh_interval_days) : null,
        offlineCacheDays: body.offline_cache_days ? Number(body.offline_cache_days) : null,
        allowSelfDeactivate: body.allow_self_deactivate !== undefined
          ? String(body.allow_self_deactivate) === "true"
          : undefined,
        allowReactivation: body.allow_reactivation !== undefined
          ? String(body.allow_reactivation) === "true"
          : undefined,
        allowNewDeviceDuringGrace: body.allow_new_device_during_grace !== undefined
          ? String(body.allow_new_device_during_grace) === "true"
          : undefined,
        features: String(body.features || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        metadata: readPlanMetadata(body),
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/plans/:id/deactivate", async (c) => {
    try {
      await setPlanActive(db, {
        planId: c.req.param("id"),
        isActive: false,
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/plans/:id/activate", async (c) => {
    try {
      await setPlanActive(db, {
        planId: c.req.param("id"),
        isActive: true,
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/plans/:id/update", async (c) => {
    const body = await readBody(c);
    try {
      await updatePlan(db, {
        planId: c.req.param("id"),
        name: body.name ? String(body.name) : null,
        edition: body.edition ? String(body.edition) : null,
        tier: body.tier ? String(body.tier) : null,
        billingModel: body.billing_model ? String(body.billing_model) : null,
        licenseModel: body.license_model ? String(body.license_model) : null,
        maxActivations: body.max_activations ? Number(body.max_activations) : null,
        maxAppMajor: body.max_app_major ? Number(body.max_app_major) : null,
        durationDays: body.duration_days !== undefined && body.duration_days !== "" ? Number(body.duration_days) : null,
        billingPeriodDays: body.billing_period_days !== undefined && body.billing_period_days !== "" ? Number(body.billing_period_days) : null,
        graceDays: body.grace_days !== undefined && body.grace_days !== "" ? Number(body.grace_days) : null,
        refreshIntervalDays: body.refresh_interval_days !== undefined && body.refresh_interval_days !== "" ? Number(body.refresh_interval_days) : null,
        offlineCacheDays: body.offline_cache_days !== undefined && body.offline_cache_days !== "" ? Number(body.offline_cache_days) : null,
        allowSelfDeactivate: body.allow_self_deactivate !== undefined ? String(body.allow_self_deactivate) === "true" : null,
        allowReactivation: body.allow_reactivation !== undefined ? String(body.allow_reactivation) === "true" : null,
        allowNewDeviceDuringGrace: body.allow_new_device_during_grace !== undefined ? String(body.allow_new_device_during_grace) === "true" : null,
        features: body.features !== undefined
          ? String(body.features).split(",").map((x: string) => x.trim()).filter(Boolean)
          : null,
        metadata: readPlanMetadata(body),
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/licenses/batch", async (c) => {
    const body = await readBody(c);
    try {
      const created = await batchCreateLicenses(db, {
        count: Number(body.count || 1),
        planId: String(body.plan_id || body.product_id || ""),
        notes: body.notes ? String(body.notes) : null,
        batchId: body.batch_id ? String(body.batch_id) : null,
        customerEmail: body.customer_email ? String(body.customer_email) : null,
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { created, count: created.length });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/provider-mappings", async (c) => {
    const body = await readBody(c);
    try {
      await createProviderMapping(db, {
        provider: String(body.provider || ""),
        externalProductId: body.external_product_id ? String(body.external_product_id) : null,
        externalVariantId: body.external_variant_id ? String(body.external_variant_id) : null,
        localPlanId: String(body.local_plan_id || body.plan_id || ""),
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/provider-mappings/:id/deactivate", async (c) => {
    try {
      await setProviderMappingActive(db, Number(c.req.param("id")), false, "admin", ip(c));
      return c.redirect("/admin/providers?success=" + encodeURIComponent("已停用"));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/provider-mappings/:id/activate", async (c) => {
    try {
      await setProviderMappingActive(db, Number(c.req.param("id")), true, "admin", ip(c));
      return c.redirect("/admin/providers?success=" + encodeURIComponent("已启用"));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/licenses/:key/unbind", async (c) => {
    try {
      await adminUnbindOrder(db, registry, c.req.param("key"), ip(c));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/activations/:id/unbind", async (c) => {
    try {
      await adminUnbindDevice(db, Number(c.req.param("id")), ip(c));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/trials/:id/delete", async (c) => {
    try {
      await deleteTrialGrant(db, c.req.param("id"));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/licenses/:key/suspend", async (c) => {
    try {
      await adminDeactivateOrder(db, c.req.param("key"), ip(c));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/licenses/:key/revoke", async (c) => {
    try {
      await adminRevokeOrder(db, c.req.param("key"), ip(c));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/licenses/:key/reactivate", async (c) => {
    try {
      await adminReactivateOrder(db, c.req.param("key"), ip(c));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/entitlements/:id/extend", async (c) => {
    const body = await readBody(c);
    try {
      await adminExtendEntitlement(db, Number(c.req.param("id")), Number(body.days || 0), ip(c));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/webhook-events/:id/retry", async (c) => {
    try {
      const { retryWebhook } = await import("../services/webhook");
      const result = await retryWebhook(db, _config, registry, Number(c.req.param("id")));
      return okOrRedirect(c, { status: result.status, message: result.message });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── Feature #1: increase device count ──
  router.post("/entitlements/:id/increase-devices", async (c) => {
    const body = await readBody(c);
    try {
      await adminIncreaseDeviceCount(
        db,
        Number(c.req.param("id")),
        Number(body.max_activations || 1),
        ip(c)
      );
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── Feature #2: sync subscription ──
  router.post("/subscriptions/:id/sync", async (c) => {
    try {
      const { adminSyncSubscription } = await import("../services/webhook");
      const result = await adminSyncSubscription(db, registry, Number(c.req.param("id")));
      return okOrRedirect(c, { status: result.status, message: result.message });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── Feature #3: compensate subscription ──
  router.post("/subscriptions/:id/compensate", async (c) => {
    const body = await readBody(c);
    try {
      await adminCompensateSubscription(db, Number(c.req.param("id")), Number(body.days || 0), ip(c));
      return okOrRedirect(c, { status: "ok" });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── Feature #5: batch license operations ──
  router.post("/licenses/batch/suspend", async (c) => {
    const body = await readBody(c);
    try {
      const keys = parseBatchKeys(body);
      const result = await batchSuspendLicenses(db, keys, ip(c));
      return okOrRedirect(c, { status: "ok", ...result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/licenses/batch/revoke", async (c) => {
    const body = await readBody(c);
    try {
      const keys = parseBatchKeys(body);
      const result = await batchRevokeLicenses(db, keys, ip(c));
      return okOrRedirect(c, { status: "ok", ...result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/licenses/batch/reactivate", async (c) => {
    const body = await readBody(c);
    try {
      const keys = parseBatchKeys(body);
      const result = await batchReactivateLicenses(db, keys, ip(c));
      return okOrRedirect(c, { status: "ok", ...result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Backward-compatible endpoints used by the previous UI.
  router.post("/orders/batch", async (c) => {
    const body = await readBody(c);
    try {
      const created = await batchCreateLicenses(db, {
        count: Number(body.count || 1),
        planId: String(body.plan_id || body.product_id || ""),
        notes: body.notes ? String(body.notes) : null,
        batchId: body.batch_id ? String(body.batch_id) : null,
        customerEmail: body.customer_email ? String(body.customer_email) : null,
        actor: "admin",
        ipAddress: ip(c),
      });
      return okOrRedirect(c, { created, count: created.length });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
  router.post("/orders/:key/unbind", async (c) => {
    await adminUnbindOrder(db, registry, c.req.param("key"), ip(c));
    return c.redirect("/admin/licenses?success=" + encodeURIComponent("操作成功"));
  });
  router.post("/orders/:key/deactivate", async (c) => {
    await adminDeactivateOrder(db, c.req.param("key"), ip(c));
    return c.redirect("/admin/licenses?success=" + encodeURIComponent("操作成功"));
  });
  router.post("/orders/:key/revoke", async (c) => {
    await adminRevokeOrder(db, c.req.param("key"), ip(c));
    return c.redirect("/admin/licenses?success=" + encodeURIComponent("操作成功"));
  });
  router.post("/orders/:key/reactivate", async (c) => {
    await adminReactivateOrder(db, c.req.param("key"), ip(c));
    return c.redirect("/admin/licenses?success=" + encodeURIComponent("操作成功"));
  });

  return router;
}
