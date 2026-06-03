/**
 * Webhook processing pipeline.
 *
 * Receives raw webhook events from payment providers, validates them,
 * converts to canonical events, and updates local subscription/entitlement state.
 */

import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  entitlements,
  licenses,
  plans,
  providerMappings,
  subscriptions,
  webhookEvents,
} from "../db/schema";
import {
  ActivationError,
  addDays,
  computeInitialValidUntil,
  findProviderPlan,
  loadPlanBundle,
  nowISO,
  writeAuditLog,
} from "./activation";
import type { CanonicalPaymentEvent, ProviderRegistry } from "./provider";

export async function processWebhook(
  db: Database,
  config: AppConfig,
  registry: ProviderRegistry,
  provider: string,
  rawBody: string,
  headers: Record<string, string>
): Promise<{ status: "ok" | "duplicate" | "error"; message?: string }> {
  const adapter = registry.get(provider);
  if (!adapter) {
    return { status: "error", message: `未知的支付平台: ${provider}` };
  }

  // 1. Verify signature
  const valid = await adapter.verifyWebhook(headers, rawBody);
  if (!valid) {
    return { status: "error", message: "Webhook 签名验证失败" };
  }

  // 2. Parse body
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: "error", message: "Webhook 请求体格式无效" };
  }

  const event = await adapter.parseWebhook(body);

  // 3. Deduplicate — use externalOrderId if present, otherwise composite key.
  if (event.externalOrderId) {
    const existing = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, provider),
          eq(webhookEvents.externalEventId, event.externalOrderId)
        )
      )
      .get();
    if (existing && existing.status === "processed") {
      return { status: "duplicate", message: "事件已处理" };
    }
  } else if (event.externalSubscriptionId) {
    // Fallback: dedup by (provider, subscription_id, event_type) for events
    // that don't carry an order_id (cancel, renew, payment_failed, etc.).
    const dedupId = `${event.externalSubscriptionId}:${event.eventType}`;
    const existing = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, provider),
          eq(webhookEvents.externalEventId, dedupId)
        )
      )
      .get();
    if (existing && existing.status === "processed") {
      return { status: "duplicate", message: "事件已处理" };
    }
  }

  // 4. Store raw event. Build a stable externalEventId for dedup:
  // prefer order_id, otherwise use subscription_id:eventType composite.
  const externalEventId =
    event.externalOrderId ||
    (event.externalSubscriptionId
      ? `${event.externalSubscriptionId}:${event.eventType}`
      : null);

  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      provider,
      externalEventId,
      eventType: event.eventType,
      status: "pending",
      rawPayloadJson: rawBody,
      occurredAt: event.occurredAt,
    })
    .returning({ id: webhookEvents.id });

  // 5. Process canonical event
  try {
    await handleCanonicalEvent(db, config, event);

    if (inserted?.id) {
      await db
        .update(webhookEvents)
        .set({ status: "processed", processedAt: nowISO() })
        .where(eq(webhookEvents.id, inserted.id));
    }

    return { status: "ok" };
  } catch (err) {
    if (inserted?.id) {
      await db
        .update(webhookEvents)
        .set({
          status: "failed",
          errorMessage: err instanceof Error ? err.message : String(err),
          processedAt: nowISO(),
        })
        .where(eq(webhookEvents.id, inserted.id));
    }
    throw err;
  }
}

async function handleCanonicalEvent(
  db: Database,
  config: AppConfig,
  event: CanonicalPaymentEvent
): Promise<void> {
  switch (event.eventType) {
    case "purchase.completed":
    case "subscription.created":
      await handleSubscriptionCreated(db, config, event);
      break;
    case "subscription.renewed":
      await handleSubscriptionRenewed(db, event);
      break;
    case "subscription.cancelled":
      await handleSubscriptionCancelled(db, event);
      break;
    case "payment.failed":
      await handlePaymentFailed(db, event);
      break;
    case "refund.created":
    case "chargeback.created":
      await handleRevoked(db, event);
      break;
  }
}

async function handleSubscriptionCreated(
  db: Database,
  config: AppConfig,
  event: CanonicalPaymentEvent
): Promise<void> {
  // Find local plan via provider_mappings.
  // Match externalProductId when present (same pattern as findProviderPlan in activation.ts).
  let mapping = event.externalProductId
    ? await db
        .select()
        .from(providerMappings)
        .where(
          and(
            eq(providerMappings.provider, event.provider),
            eq(providerMappings.externalProductId, event.externalProductId),
            eq(providerMappings.isActive, true)
          )
        )
        .get()
    : null;

  if (!mapping) {
    mapping = await db
      .select()
      .from(providerMappings)
      .where(
        and(
          eq(providerMappings.provider, event.provider),
          eq(providerMappings.isActive, true)
        )
      )
      .get();
  }

  if (!mapping) {
    throw new ActivationError(
      "NO_PROVIDER_MAPPING",
      `未找到 ${event.provider} 的映射配置`,
      400
    );
  }

  const { plan, product } = await loadPlanBundle(db, mapping.localPlanId);

  // Create entitlement
  const [inserted] = await db
    .insert(entitlements)
    .values({
      productId: product.productId,
      planId: plan.planId,
      status: "active",
      sourceProvider: event.provider,
      sourceChannel: event.provider,
      externalRef: event.externalOrderId || event.externalSubscriptionId || null,
      validFrom: nowISO(),
      validUntil: computeInitialValidUntil(plan),
      metadataJson: JSON.stringify({ source: "webhook", event_type: event.eventType }),
    })
    .returning({ id: entitlements.id });

  if (!inserted?.id) {
    throw new ActivationError("SERVER_ERROR", "创建授权记录失败", 500);
  }

  // Create license if external key provided
  if (event.externalLicenseKey) {
    const existingLicense = await db
      .select()
      .from(licenses)
      .where(eq(licenses.licenseKey, event.externalLicenseKey))
      .get();
    if (!existingLicense) {
      await db.insert(licenses).values({
        licenseKey: event.externalLicenseKey,
        entitlementId: inserted.id,
        status: "unused",
        channel: event.provider,
        externalProviderKey: event.externalLicenseKey,
      });
    }
  }

  // Create subscription
  if (event.externalSubscriptionId) {
    await db.insert(subscriptions).values({
      entitlementId: inserted.id,
      provider: event.provider,
      externalSubscriptionId: event.externalSubscriptionId,
      externalCustomerId: event.externalCustomerId || null,
      status: "active",
      currentPeriodEnd: computeInitialValidUntil(plan),
      metadataJson: JSON.stringify(event.rawPayload),
    });
  }

  await writeAuditLog(db, {
    action: "webhook.subscription_created",
    targetType: "entitlement",
    targetId: String(inserted.id),
    after: {
      provider: event.provider,
      event_type: event.eventType,
      plan_id: plan.planId,
      subscription_id: event.externalSubscriptionId,
    },
    ipAddress: null,
  });
}

async function handleSubscriptionRenewed(
  db: Database,
  event: CanonicalPaymentEvent
): Promise<void> {
  if (!event.externalSubscriptionId) return;

  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, event.provider),
        eq(subscriptions.externalSubscriptionId, event.externalSubscriptionId)
      )
    )
    .get();

  if (!sub) return;

  const entitlement = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.id, sub.entitlementId))
    .get();

  if (!entitlement) return;

  const plan = await db
    .select()
    .from(plans)
    .where(eq(plans.planId, entitlement.planId))
    .get();

  const newPeriodEnd = plan
    ? computeInitialValidUntil(plan)
    : addDays(new Date(), 30);

  await db
    .update(subscriptions)
    .set({
      status: "active",
      currentPeriodEnd: newPeriodEnd,
      updatedAt: nowISO(),
    })
    .where(eq(subscriptions.id, sub.id));

  await syncEntitlementFromSubscription(db, sub.entitlementId, "active", {
    plan: plan ?? undefined,
    validUntil: newPeriodEnd,
  });

  await writeAuditLog(db, {
    action: "webhook.subscription_renewed",
    targetType: "subscription",
    targetId: String(sub.id),
    after: { status: "active", period_end: newPeriodEnd },
    ipAddress: null,
  });
}

async function handleSubscriptionCancelled(
  db: Database,
  event: CanonicalPaymentEvent
): Promise<void> {
  if (!event.externalSubscriptionId) return;

  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, event.provider),
        eq(subscriptions.externalSubscriptionId, event.externalSubscriptionId)
      )
    )
    .get();

  if (!sub) return;

  await db
    .update(subscriptions)
    .set({
      status: "canceled",
      canceledAt: nowISO(),
      updatedAt: nowISO(),
    })
    .where(eq(subscriptions.id, sub.id));

  // Keep entitlement active until period_end — lazy expiration handles the rest.
  await writeAuditLog(db, {
    action: "webhook.subscription_cancelled",
    targetType: "subscription",
    targetId: String(sub.id),
    after: { status: "canceled" },
    ipAddress: null,
  });
}

async function handlePaymentFailed(
  db: Database,
  event: CanonicalPaymentEvent
): Promise<void> {
  if (!event.externalSubscriptionId) return;

  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, event.provider),
        eq(subscriptions.externalSubscriptionId, event.externalSubscriptionId)
      )
    )
    .get();

  if (!sub) return;

  const entitlement = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.id, sub.entitlementId))
    .get();

  const plan = entitlement
    ? await db.select().from(plans).where(eq(plans.planId, entitlement.planId)).get()
    : null;

  await db
    .update(subscriptions)
    .set({
      status: "past_due",
      updatedAt: nowISO(),
    })
    .where(eq(subscriptions.id, sub.id));

  await syncEntitlementFromSubscription(db, sub.entitlementId, "past_due", {
    plan: plan ?? undefined,
    extendValidUntilByGrace:
      sub.currentPeriodEnd && plan?.graceDays
        ? { currentPeriodEnd: sub.currentPeriodEnd, graceDays: plan.graceDays }
        : null,
  });

  await writeAuditLog(db, {
    action: "webhook.payment_failed",
    targetType: "subscription",
    targetId: String(sub.id),
    after: { status: "past_due" },
    ipAddress: null,
  });
}

async function handleRevoked(
  db: Database,
  event: CanonicalPaymentEvent
): Promise<void> {
  if (!event.externalSubscriptionId) return;

  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, event.provider),
        eq(subscriptions.externalSubscriptionId, event.externalSubscriptionId)
      )
    )
    .get();

  if (!sub) return;

  await db
    .update(subscriptions)
    .set({
      status: "revoked",
      updatedAt: nowISO(),
    })
    .where(eq(subscriptions.id, sub.id));

  await syncEntitlementFromSubscription(db, sub.entitlementId, "revoked");

  await writeAuditLog(db, {
    action: `webhook.${event.eventType}`,
    targetType: "subscription",
    targetId: String(sub.id),
    after: { status: "revoked" },
    ipAddress: null,
  });
}

async function syncEntitlementFromSubscription(
  db: Database,
  entitlementId: number,
  subscriptionStatus: string,
  opts?: {
    plan?: { graceDays?: number | null; billingPeriodDays?: number | null } | null;
    validUntil?: string | null;
    extendValidUntilByGrace?: { currentPeriodEnd: string; graceDays: number } | null;
  }
): Promise<void> {
  const plan = opts?.plan;
  const statusMap: Record<string, { status: string; graceUntil?: string | null }> = {
    active: { status: "active" },
    trialing: { status: "active" },
    past_due: {
      status: "grace",
      graceUntil: addDays(new Date(), plan?.graceDays || 7),
    },
    canceled: { status: "active" },
    expired: { status: "expired" },
    revoked: { status: "revoked" },
  };

  const mapping = statusMap[subscriptionStatus];
  if (!mapping) return;

  // Bug #5 fix: never revert a revoked entitlement back to active (e.g. canceled webhook
  // arriving after a refund/chargeback). Once revoked, only manual admin reactivation can restore it.
  if (mapping.status === "active") {
    const current = await db
      .select({ status: entitlements.status })
      .from(entitlements)
      .where(eq(entitlements.id, entitlementId))
      .get();
    if (current && current.status === "revoked") {
      // Keep revoked; don't overwrite.
      return;
    }
  }

  // Extend valid_until during grace: period_end + grace_days (PRD 7.5)
  let finalValidUntil = opts?.validUntil ?? null;
  if (subscriptionStatus === "past_due" && opts?.extendValidUntilByGrace) {
    const { currentPeriodEnd, graceDays } = opts.extendValidUntilByGrace;
    finalValidUntil = addDays(new Date(currentPeriodEnd.replace(" ", "T") + "Z"), graceDays)
      .replace("T", " ").substring(0, 19);
  }

  await db
    .update(entitlements)
    .set({
      status: mapping.status,
      graceUntil: mapping.graceUntil ?? null,
      validUntil: finalValidUntil ?? undefined,
      updatedAt: nowISO(),
    })
    .where(eq(entitlements.id, entitlementId));
}

export async function retryWebhook(
  db: Database,
  config: AppConfig,
  registry: ProviderRegistry,
  eventId: number
): Promise<{ status: string; message: string }> {
  const event = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, eventId))
    .get();

  if (!event) return { status: "error", message: "事件不存在" };
  if (event.status === "processed") return { status: "ok", message: "事件已处理" };

  const adapter = registry.get(event.provider);
  if (!adapter) return { status: "error", message: `未知的支付平台: ${event.provider}` };

  let body: unknown;
  try {
    body = JSON.parse(event.rawPayloadJson);
  } catch {
    return { status: "error", message: "原始数据解析失败" };
  }

  try {
    const canonicalEvent = await adapter.parseWebhook(body);
    await handleCanonicalEvent(db, config, canonicalEvent);
    await db
      .update(webhookEvents)
      .set({ status: "processed", processedAt: nowISO(), errorMessage: null })
      .where(eq(webhookEvents.id, eventId));
    return { status: "ok", message: "重试成功" };
  } catch (err) {
    await db
      .update(webhookEvents)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        processedAt: nowISO(),
      })
      .where(eq(webhookEvents.id, eventId));
    return { status: "error", message: err instanceof Error ? err.message : "处理失败" };
  }
}

// ─── Feature #2: admin sync subscription ─────────────────────────────────

export async function adminSyncSubscription(
  db: Database,
  registry: ProviderRegistry,
  subscriptionId: number
): Promise<{ status: string; message: string }> {
  const sub = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .get();

  if (!sub) return { status: "error", message: "订阅不存在" };

  const adapter = registry.get(sub.provider);
  if (!adapter) return { status: "error", message: `未知的支付平台: ${sub.provider}` };
  if (!adapter.getSubscription) {
    return { status: "error", message: `${sub.provider} 不支持通过 API 查询订阅状态` };
  }

  try {
    const result = await adapter.getSubscription(sub.externalSubscriptionId);
    const now = nowISO();

    // Update subscription status.
    await db
      .update(subscriptions)
      .set({
        status: result.status,
        ...(result.currentPeriodEnd ? { currentPeriodEnd: result.currentPeriodEnd } : {}),
        updatedAt: now,
      })
      .where(eq(subscriptions.id, subscriptionId));

    // Sync entitlement if needed.
    const entitlement = await db
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, sub.entitlementId))
      .get();

    if (entitlement) {
      const plan = await db
        .select()
        .from(plans)
        .where(eq(plans.planId, entitlement.planId))
        .get();

      await syncEntitlementFromSubscription(
        db,
        sub.entitlementId,
        result.status,
        {
          plan: plan ?? undefined,
          validUntil: result.currentPeriodEnd || undefined,
          extendValidUntilByGrace:
            result.status === "past_due" && sub.currentPeriodEnd && plan?.graceDays
              ? { currentPeriodEnd: sub.currentPeriodEnd, graceDays: plan.graceDays }
              : null,
        }
      );
    }

    await writeAuditLog(db, {
      action: "subscriptions.admin_sync",
      targetType: "subscription",
      targetId: String(subscriptionId),
      after: { status: result.status, periodEnd: result.currentPeriodEnd || sub.currentPeriodEnd },
      ipAddress: null,
    });

    return { status: "ok", message: `同步成功: ${sub.status} → ${result.status}` };
  } catch (err) {
    if (err instanceof ActivationError) throw err;
    return {
      status: "error",
      message: err instanceof Error ? err.message : "同步失败",
    };
  }
}
