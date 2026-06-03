import { describe, expect, it } from "vitest";
import { createCreemAdapter } from "../src/services/creem";

describe("Creem adapter", () => {
  const adapter = createCreemAdapter({ apiKey: "test-key-123", testMode: true });

  it("identifies Creem 5-group dash-separated keys", () => {
    // Real Creem format: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
    expect(adapter.identifiesKey("40TJ0-U89OC-8843Y-37N0L-OU2D6")).toBe(true);
    expect(adapter.identifiesKey("abcde-fghij-klmno-pqrst-uvwxy")).toBe(true);
    expect(adapter.identifiesKey("00000-11111-22222-33333-44444")).toBe(true);
    // Case insensitive
    expect(adapter.identifiesKey("40tj0-u89oc-8843y-37n0l-ou2d6")).toBe(true);
    expect(adapter.identifiesKey("")).toBe(false);
  });

  it("rejects AM-XXXXXXXXXXXX format (internal codes)", () => {
    expect(adapter.identifiesKey("AM-000000000000")).toBe(false);
    expect(adapter.identifiesKey("AM-ABCDEF123456")).toBe(false);
  });

  it("rejects non-Creem-format keys (will be handled by other adapters)", () => {
    // Stripe-style keys
    expect(adapter.identifiesKey("sub_abc123def456")).toBe(false);
    expect(adapter.identifiesKey("sk_live_abcdef")).toBe(false);
    expect(adapter.identifiesKey("pi_12345")).toBe(false);
    // Random / other formats
    expect(adapter.identifiesKey("random-key")).toBe(false);
    expect(adapter.identifiesKey("creem_abc123")).toBe(false);
  });

  it("has name 'creem'", () => {
    expect(adapter.name).toBe("creem");
  });

  it("parseWebhook maps purchase events", async () => {
    const event = await adapter.parseWebhook({
      id: "evt_123",
      event: "order.completed",
      product_id: "prod_abc",
      created_at: "2026-06-03T00:00:00Z",
    });
    expect(event.provider).toBe("creem");
    expect(event.eventType).toBe("purchase.completed");
    expect(event.externalProductId).toBe("prod_abc");
    expect(event.externalOrderId).toBe("evt_123");
  });

  it("parseWebhook maps subscription events", async () => {
    const event = await adapter.parseWebhook({
      id: "evt_456",
      type: "subscription.cancelled",
      subscription_id: "sub_xyz",
      customer_id: "cus_abc",
      created_at: "2026-06-03T00:00:00Z",
    });
    expect(event.provider).toBe("creem");
    expect(event.eventType).toBe("subscription.cancelled");
    expect(event.externalSubscriptionId).toBe("sub_xyz");
    expect(event.externalCustomerId).toBe("cus_abc");
  });

  it("parseWebhook handles missing fields gracefully", async () => {
    const event = await adapter.parseWebhook({});
    expect(event.provider).toBe("creem");
    expect(event.eventType).toBe("purchase.completed");
    expect(event.externalOrderId).toBeUndefined();
  });

  it("verifyWebhook returns true in test mode without signature", async () => {
    const result = await adapter.verifyWebhook({}, "{}");
    expect(result).toBe(true);
  });
});
