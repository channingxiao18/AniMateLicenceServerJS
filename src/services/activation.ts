/**
 * Core business logic for license activation, deactivation, and order management.
 * Ported from Python activation_service.py.
 */

import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/index";
import { products, entitlements, orders, activationLogs } from "../db/schema";
import type { AppConfig } from "../config";
import { createAuthInfo } from "../licence/auth_info";
import { issueLicence, parseAppMajor } from "../licence/codec";
import {
  validateOrderId,
  generateOrderId,
  OrderIdValidationError,
} from "../licence/order_id";

// ─── Helpers ─────────────────────────────────────────────────────────────

export class ActivationError extends Error {
  error: string;
  statusCode: number;

  constructor(error: string, message: string, statusCode = 400) {
    super(message);
    this.error = error;
    this.statusCode = statusCode;
    this.name = "ActivationError";
  }
}

function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return "unknown";
}

function nowISO(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

async function writeActivationLog(
  db: Database,
  params: {
    orderId: string | null;
    entitlementId: number | null;
    fingerprint: string | null;
    action: string;
    ipAddress: string;
    responseCode: number;
    detail?: Record<string, unknown> | null;
  }
): Promise<void> {
  await db.insert(activationLogs).values({
    orderId: params.orderId,
    entitlementId: params.entitlementId,
    fingerprint: params.fingerprint,
    action: params.action,
    ipAddress: params.ipAddress,
    responseCode: params.responseCode,
    detail: params.detail ? JSON.stringify(params.detail) : null,
  });
}

interface OrderBundle {
  order: typeof orders.$inferSelect;
  entitlement: typeof entitlements.$inferSelect;
  product: typeof products.$inferSelect;
}

async function loadOrderBundle(
  db: Database,
  orderId: string
): Promise<OrderBundle> {
  const order = await db
    .select()
    .from(orders)
    .where(eq(orders.orderId, orderId))
    .get();

  if (!order) {
    throw new ActivationError("ORDER_NOT_FOUND", "订单不存在", 404);
  }

  const entitlement = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.id, order.entitlementId))
    .get();

  if (!entitlement) {
    throw new ActivationError("ORDER_NOT_FOUND", "授权记录不存在", 404);
  }

  const product = await db
    .select()
    .from(products)
    .where(eq(products.productId, entitlement.productId))
    .get();

  if (!product) {
    throw new ActivationError("ORDER_NOT_FOUND", "产品不存在", 404);
  }

  return { order, entitlement, product };
}

function checkAppVersion(product: typeof products.$inferSelect, appVersion: string | null): void {
  const major = parseAppMajor(appVersion || "0.1.0");
  if (major === null) return;
  if (major > product.maxAppMajor) {
    throw new ActivationError(
      "APP_VERSION_NOT_COVERED",
      `当前 App 版本不受此授权 SKU 覆盖（最高 ${product.maxAppMajor}.x）`,
      403
    );
  }
}

// ─── Activate ────────────────────────────────────────────────────────────

export async function activateOrder(
  db: Database,
  config: AppConfig,
  params: {
    orderId: string;
    fingerprint: string;
    appVersion: string | null;
    platform: string | null;
    ipAddress: string;
  }
): Promise<{ licence: string; entitlement: Record<string, unknown> }> {
  if (!params.fingerprint.trim()) {
    throw new ActivationError("INVALID_REQUEST", "fingerprint 不能为空", 400);
  }

  let orderId: string;
  try {
    orderId = validateOrderId(params.orderId);
  } catch (exc) {
    if (exc instanceof OrderIdValidationError) {
      throw new ActivationError(exc.code, exc.message, 400);
    }
    throw exc;
  }

  const { order, entitlement, product } = await loadOrderBundle(db, orderId);

  if (order.status === "revoked" || entitlement.status === "revoked") {
    throw new ActivationError("ORDER_REVOKED", "订单已作废", 403);
  }

  if (entitlement.status === "deactivated") {
    throw new ActivationError("ENTITLEMENT_DEACTIVATED", "授权已停用", 403);
  }

  if (!product.isActive) {
    throw new ActivationError("PRODUCT_INACTIVE", "产品 SKU 已下架", 403);
  }

  if (product.type !== "lifetime") {
    throw new ActivationError(
      "NOT_SUPPORTED",
      "当前仅支持 lifetime 买断激活",
      400
    );
  }

  checkAppVersion(product, params.appVersion);

  let reissue = false;
  if (order.status === "used") {
    if (entitlement.fingerprint !== params.fingerprint) {
      throw new ActivationError(
        "ORDER_ALREADY_USED",
        "订单已绑定其他设备",
        409
      );
    }
    if (entitlement.status !== "active") {
      throw new ActivationError("ENTITLEMENT_DEACTIVATED", "授权已停用", 403);
    }
    reissue = true;
  } else if (order.status !== "unused") {
    throw new ActivationError("ORDER_NOT_FOUND", "订单状态异常", 404);
  } else {
    if (entitlement.status !== "pending" && entitlement.status !== "active") {
      throw new ActivationError("ORDER_NOT_FOUND", "授权状态不可激活", 404);
    }
  }

  const auth = createAuthInfo({
    productId: product.productId,
    edition: product.edition,
    tier: product.tier,
    features: JSON.parse(product.featuresJson || "[]"),
    maxAppMajor: product.maxAppMajor,
    validDay: 0,
  });

  const licenceStr = await issueLicence(
    params.fingerprint,
    auth,
    config.rsaPrivateKeyPkcs8Hex
  );

  const now = nowISO();
  if (!reissue) {
    await db
      .update(orders)
      .set({ status: "used", usedAt: now })
      .where(eq(orders.orderId, order.orderId));

    const meta = {
      platform: params.platform,
      app_version: params.appVersion,
    };

    await db
      .update(entitlements)
      .set({
        status: "active",
        fingerprint: params.fingerprint,
        validFrom: now,
        validUntil: null,
        edition: product.edition,
        tier: product.tier,
        featuresJson: product.featuresJson,
        maxAppMajor: product.maxAppMajor,
        metadataJson: JSON.stringify(meta),
      })
      .where(eq(entitlements.id, entitlement.id));
  }

  const action = reissue ? "activate_reissue" : "activate_success";
  await writeActivationLog(db, {
    orderId: order.orderId,
    entitlementId: entitlement.id,
    fingerprint: params.fingerprint,
    action,
    ipAddress: params.ipAddress,
    responseCode: 200,
    detail: {
      platform: params.platform,
      app_version: params.appVersion,
    },
  });

  return {
    licence: licenceStr,
    entitlement: {
      type: product.type,
      edition: entitlement.edition,
      tier: entitlement.tier,
      features: JSON.parse(entitlement.featuresJson || "[]"),
      max_app_major: entitlement.maxAppMajor,
      valid_until: null,
      product_id: product.productId,
    },
  };
}

// ─── Deactivate ──────────────────────────────────────────────────────────

export async function deactivateOrder(
  db: Database,
  params: {
    orderId: string;
    fingerprint: string;
    ipAddress: string;
    action?: string;
  }
): Promise<void> {
  const { order, entitlement } = await loadOrderBundle(db, params.orderId);

  if (order.status !== "used") {
    throw new ActivationError("ORDER_NOT_FOUND", "订单未激活", 404);
  }

  if (entitlement.fingerprint !== params.fingerprint) {
    throw new ActivationError("FINGERPRINT_MISMATCH", "机器指纹不匹配", 403);
  }

  if ((entitlement.status as string) === "revoked" || (order.status as string) === "revoked") {
    throw new ActivationError("ENTITLEMENT_REVOKED", "授权已作废", 403);
  }

  await db
    .update(entitlements)
    .set({ status: "deactivated" })
    .where(eq(entitlements.id, entitlement.id));

  await writeActivationLog(db, {
    orderId: order.orderId,
    entitlementId: entitlement.id,
    fingerprint: params.fingerprint,
    action: params.action || "deactivate_user",
    ipAddress: params.ipAddress,
    responseCode: 200,
  });
}

// ─── Admin operations ────────────────────────────────────────────────────

export async function adminUnbindOrder(
  db: Database,
  orderId: string,
  ipAddress: string
): Promise<void> {
  const { order, entitlement } = await loadOrderBundle(db, orderId);

  await db
    .update(orders)
    .set({ status: "unused", usedAt: null })
    .where(eq(orders.orderId, order.orderId));

  await db
    .update(entitlements)
    .set({
      status: "pending",
      fingerprint: null,
      validFrom: null,
      validUntil: null,
    })
    .where(eq(entitlements.id, entitlement.id));

  await writeActivationLog(db, {
    orderId: order.orderId,
    entitlementId: entitlement.id,
    fingerprint: null,
    action: "unbind",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminDeactivateOrder(
  db: Database,
  orderId: string,
  ipAddress: string
): Promise<void> {
  const { order, entitlement } = await loadOrderBundle(db, orderId);

  if (order.status !== "used") {
    throw new ActivationError("ORDER_NOT_FOUND", "订单未激活", 404);
  }

  await db
    .update(entitlements)
    .set({ status: "deactivated" })
    .where(eq(entitlements.id, entitlement.id));

  await writeActivationLog(db, {
    orderId: order.orderId,
    entitlementId: entitlement.id,
    fingerprint: entitlement.fingerprint,
    action: "deactivate_admin",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminRevokeOrder(
  db: Database,
  orderId: string,
  ipAddress: string
): Promise<void> {
  const { order, entitlement } = await loadOrderBundle(db, orderId);

  await db
    .update(orders)
    .set({ status: "revoked" })
    .where(eq(orders.orderId, order.orderId));

  await db
    .update(entitlements)
    .set({ status: "revoked" })
    .where(eq(entitlements.id, entitlement.id));

  await writeActivationLog(db, {
    orderId: order.orderId,
    entitlementId: entitlement.id,
    fingerprint: entitlement.fingerprint,
    action: "revoke",
    ipAddress,
    responseCode: 200,
  });
}

export async function adminReactivateOrder(
  db: Database,
  orderId: string,
  ipAddress: string
): Promise<void> {
  const { order, entitlement } = await loadOrderBundle(db, orderId);

  if (order.status === "revoked" || entitlement.status === "revoked") {
    throw new ActivationError(
      "ENTITLEMENT_REVOKED",
      "授权已作废，不可恢复",
      403
    );
  }

  if (order.status !== "used") {
    throw new ActivationError("ORDER_NOT_FOUND", "订单未激活", 404);
  }

  await db
    .update(entitlements)
    .set({ status: "active" })
    .where(eq(entitlements.id, entitlement.id));

  await writeActivationLog(db, {
    orderId: order.orderId,
    entitlementId: entitlement.id,
    fingerprint: entitlement.fingerprint,
    action: "reactivate",
    ipAddress,
    responseCode: 200,
  });
}

// ─── Batch create orders ─────────────────────────────────────────────────

export async function batchCreateOrders(
  db: Database,
  params: {
    count: number;
    productId: string;
    notes: string | null;
    batchId: string | null;
  }
): Promise<string[]> {
  if (params.count < 1 || params.count > 1000) {
    throw new ActivationError("INVALID_REQUEST", "count 须在 1–1000", 400);
  }

  const product = await db
    .select()
    .from(products)
    .where(eq(products.productId, params.productId))
    .get();

  if (!product) {
    throw new ActivationError("PRODUCT_NOT_FOUND", "产品不存在", 404);
  }

  if (!product.isActive) {
    throw new ActivationError("PRODUCT_INACTIVE", "产品 SKU 已下架", 403);
  }

  const created: string[] = [];
  for (let i = 0; i < params.count; i++) {
    let orderId = generateOrderId();
    // Retry on collision (extremely unlikely but handle it)
    let existing = await db
      .select()
      .from(orders)
      .where(eq(orders.orderId, orderId))
      .get();
    while (existing) {
      orderId = generateOrderId();
      existing = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, orderId))
        .get();
    }

    // Insert entitlement with Drizzle ORM, get back auto-increment ID
    const [inserted] = await db
      .insert(entitlements)
      .values({
        productId: product.productId,
        edition: product.edition,
        tier: product.tier,
        featuresJson: product.featuresJson,
        maxAppMajor: product.maxAppMajor,
        sourceChannel: "wechat_order",
        externalRef: orderId,
        status: "pending",
      })
      .returning({ id: entitlements.id });

    if (inserted?.id != null) {
      await db.insert(orders).values({
        orderId,
        entitlementId: inserted.id,
        status: "unused",
        channel: "wechat_order",
        batchId: params.batchId,
        notes: params.notes,
      });
      created.push(orderId);
    }
  }

  return created;
}

// ─── Query helpers for admin UI ──────────────────────────────────────────

export async function getOrderStats(db: Database): Promise<{
  total: number;
  unused: number;
  used: number;
  deactivated: number;
  revoked: number;
}> {
  const allOrders = await db.select().from(orders).all();
  const stats = { total: 0, unused: 0, used: 0, deactivated: 0, revoked: 0 };

  for (const o of allOrders) {
    stats.total++;
    if (o.status === "unused") stats.unused++;
    else if (o.status === "used") {
      // Check entitlement status
      const ent = await db
        .select()
        .from(entitlements)
        .where(eq(entitlements.id, o.entitlementId))
        .get();
      if (ent?.status === "deactivated") stats.deactivated++;
      else stats.used++;
    } else if (o.status === "revoked") stats.revoked++;
  }

  return stats;
}

export async function listOrders(
  db: Database,
  params: { page?: number; pageSize?: number; status?: string; search?: string }
): Promise<{ items: Array<typeof orders.$inferSelect & { entitlement: typeof entitlements.$inferSelect | null }>; total: number }> {
  const page = params.page || 1;
  const pageSize = params.pageSize || 20;

  let query = db.select().from(orders);
  // D1 / Drizzle don't support complex ORM filtering easily, so we filter in JS for simplicity
  // For a production app, use raw SQL
  const allOrders = await query.all();

  let filtered = allOrders;
  if (params.status) {
    filtered = filtered.filter((o) => o.status === params.status);
  }
  if (params.search) {
    const s = params.search.toUpperCase();
    filtered = filtered.filter((o) => o.orderId.includes(s));
  }

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const paged = filtered.slice(start, start + pageSize);

  const items: Array<typeof orders.$inferSelect & { entitlement: typeof entitlements.$inferSelect | null }> = [];
  for (const o of paged) {
    const ent = await db
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, o.entitlementId))
      .get();
    items.push({ ...o, entitlement: ent || null });
  }

  return { items, total };
}

export async function listActivationLogs(
  db: Database,
  params: { page?: number; pageSize?: number }
): Promise<{ items: Array<typeof activationLogs.$inferSelect>; total: number }> {
  const page = params.page || 1;
  const pageSize = params.pageSize || 50;

  const allLogs = await db
    .select()
    .from(activationLogs)
    .orderBy(desc(activationLogs.id))
    .all();

  const total = allLogs.length;
  const start = (page - 1) * pageSize;
  const paged = allLogs.slice(start, start + pageSize);

  return { items: paged, total };
}
