/**
 * Creem API client — license activation, validation, deactivation.
 * Uses fetch directly (no SDK dependency) for Cloudflare Workers compatibility.
 */

import { ActivationError } from "./activation";
import type { ProviderAdapter, CanonicalPaymentEvent, ExternalActivationResult } from "./provider";

export interface CreemLicenseResponse {
  id: string;
  product_id: string;
  status: "active" | "inactive" | "expired" | "disabled";
  key: string;
  activation: number;
  activation_limit: number;
  expires_at: string | null;
  instance?: {
    id: string;
    name: string;
    status: string;
  };
}

export interface CreemConfig {
  apiKey: string;
  testMode: boolean;
}

function baseUrl(testMode: boolean): string {
  return testMode
    ? "https://test-api.creem.io/v1"
    : "https://api.creem.io/v1";
}

export class CreemApiError extends Error {
  statusCode: number;
  creemError: string;

  constructor(statusCode: number, message: string, creemError: string) {
    super(message);
    this.statusCode = statusCode;
    this.creemError = creemError;
    this.name = "CreemApiError";
  }
}

async function creemRequest<T>(
  config: CreemConfig,
  endpoint: string,
  body: Record<string, string>
): Promise<T> {
  const url = `${baseUrl(config.testMode)}${endpoint}`;
  const keyPrefix = config.apiKey ? config.apiKey.substring(0, 10) + "..." : "(empty)";
  console.log("[Creem] Request:", JSON.stringify({ url, keyPrefix, body }));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let errMsg = `Creem API error ${res.status}`;
    let errCode = "CREEM_API_ERROR";
    try {
      const errBody = await res.json() as Record<string, string>;
      errMsg = errBody.message || errMsg;
      errCode = errBody.error || errCode;
      console.error("[Creem] API error:", JSON.stringify({ url, status: res.status, body: errBody }));
    } catch {
      const text = await res.text();
      console.error("[Creem] API error (raw):", JSON.stringify({ url, status: res.status, body: text }));
    }
    throw new CreemApiError(res.status, errMsg, errCode);
  }

  return (await res.json()) as T;
}

export async function creemActivate(
  config: CreemConfig,
  key: string,
  instanceName: string
): Promise<CreemLicenseResponse> {
  return creemRequest<CreemLicenseResponse>(config, "/licenses/activate", {
    key,
    instance_name: instanceName,
  });
}

export async function creemValidate(
  config: CreemConfig,
  key: string,
  instanceId: string
): Promise<CreemLicenseResponse> {
  return creemRequest<CreemLicenseResponse>(config, "/licenses/validate", {
    key,
    instance_id: instanceId,
  });
}

export async function creemDeactivate(
  config: CreemConfig,
  key: string,
  instanceId: string
): Promise<CreemLicenseResponse> {
  return creemRequest<CreemLicenseResponse>(config, "/licenses/deactivate", {
    key,
    instance_id: instanceId,
  });
}

/**
 * Detect whether a raw string is a Creem license key.
 *
 * Creem keys use a 5-group dash-separated format:
 *   40TJ0-U89OC-8843Y-37N0L-OU2D6
 *
 * Each group is 5 alphanumeric chars, 5 groups total.
 */
const CREEM_KEY_RE = /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i;

function isCreemKey(raw: string): boolean {
  return CREEM_KEY_RE.test(raw.trim());
}

function toWebhookSecret(apiKey: string): string {
  return `whsec_${apiKey}`;
}

export function createCreemAdapter(config: CreemConfig): ProviderAdapter {
  return {
    name: "creem",

    identifiesKey(key: string): boolean {
      return isCreemKey(key);
    },

    async activate(key: string, instanceName: string): Promise<ExternalActivationResult> {
      const result = await creemActivate(config, key, instanceName);
      if (!result.instance?.id) {
        throw new ActivationError("CREEM_ACTIVATION_FAILED", "Creem 未返回 instance ID", 502);
      }
      return {
        instanceId: result.instance.id,
        externalProductId: result.product_id,
        status: result.status,
        activationLimit: result.activation_limit,
        expiresAt: result.expires_at,
        metadata: {
          creem_product_id: result.product_id,
          creem_status: result.status,
        },
      };
    },

    async deactivate(key: string, instanceId: string): Promise<void> {
      await creemDeactivate(config, key, instanceId);
    },

    async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<boolean> {
      if (!config.apiKey) return true; // test mode without webhook verification
      const expected = headers["x-creem-signature"] || headers["creem-signature"] || "";
      if (!expected) return true; // no signature header provided
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(toWebhookSecret(config.apiKey)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
      );
      const sigBytes = new Uint8Array(expected.length / 2);
      for (let i = 0; i < expected.length; i += 2) {
        sigBytes[i / 2] = parseInt(expected.substring(i, i + 2), 16);
      }
      return crypto.subtle.verify(
        "HMAC",
        key,
        sigBytes,
        new TextEncoder().encode(rawBody)
      );
    },

    async parseWebhook(body: unknown): Promise<CanonicalPaymentEvent> {
      const data = body as Record<string, unknown>;
      const eventType = (data.event || data.type || "") as string;
      const canonicalType = mapCreemEventType(eventType);
      return {
        provider: "creem",
        eventType: canonicalType,
        externalCustomerId: data.customer_id as string | undefined,
        externalOrderId: (data.id || data.order_id) as string | undefined,
        externalSubscriptionId: data.subscription_id as string | undefined,
        externalLicenseKey: (data.license_key || data.key) as string | undefined,
        externalProductId: data.product_id as string | undefined,
        externalVariantId: data.variant_id as string | undefined,
        occurredAt: (data.created_at || data.occurred_at || new Date().toISOString()) as string,
        rawPayload: data,
      };
    },

    async getSubscription(
      externalSubscriptionId: string
    ): Promise<{ status: string; currentPeriodEnd?: string }> {
      // Creem doesn't have a public GET /subscriptions endpoint, but we can
      // validate the license to infer subscription health.
      // Return the last known status from a validate call or indicate that
      // manual sync is not fully supported.
      throw new ActivationError(
        "CREEM_SYNC_UNSUPPORTED",
        "Creem 暂不支持通过 API 查询订阅状态，请通过 Webhook 自动同步或前往 Creem 后台查看",
        400
      );
    },

    async cancelSubscription(externalSubscriptionId: string): Promise<void> {
      // Creem does not expose a public API for cancelling subscriptions.
      // The admin should cancel via the Creem dashboard.
      throw new ActivationError(
        "CREEM_CANCEL_UNSUPPORTED",
        "Creem 暂不支持通过 API 取消订阅，请前往 Creem 后台操作",
        400
      );
    },
  };
}

function mapCreemEventType(raw: string): CanonicalPaymentEvent["eventType"] {
  const normalized = raw.toLowerCase();
  if (normalized.includes("purchase") || normalized.includes("order.completed")) return "purchase.completed";
  if (normalized.includes("subscription.created")) return "subscription.created";
  if (normalized.includes("subscription.renew") || normalized.includes("invoice.paid")) return "subscription.renewed";
  if (normalized.includes("subscription.cancel") || normalized.includes("cancel")) return "subscription.cancelled";
  if (normalized.includes("payment.fail") || normalized.includes("invoice.payment_failed")) return "payment.failed";
  if (normalized.includes("refund")) return "refund.created";
  if (normalized.includes("chargeback") || normalized.includes("dispute")) return "chargeback.created";
  return "purchase.completed";
}
