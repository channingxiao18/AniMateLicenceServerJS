import { describe, expect, it } from "vitest";
import { createCreemAdapter } from "../src/services/creem";

describe("Creem adapter", () => {
  const adapter = createCreemAdapter({ apiKey: "test-key-123", testMode: true });

  it("identifies non-AM keys as potential Creem keys", () => {
    // Creem keys (non-AM format)
    expect(adapter.identifiesKey("creem_abc123")).toBe(true);
    expect(adapter.identifiesKey("cus_abc123def456")).toBe(true);
    expect(adapter.identifiesKey("sk_live_abcdef")).toBe(true);
    expect(adapter.identifiesKey("random-key")).toBe(true);
    expect(adapter.identifiesKey("")).toBe(false);
  });

  it("rejects AM-XXXXXXXXXXXX format as non-Creem keys", () => {
    expect(adapter.identifiesKey("AM-000000000000")).toBe(false);
    expect(adapter.identifiesKey("AM-ABCDEF123456")).toBe(false);
    expect(adapter.identifiesKey("AM-ABCD12345678")).toBe(false);
  });

  it("is case-insensitive for AM- format detection", () => {
    expect(adapter.identifiesKey("am-000000000000")).toBe(false);
    expect(adapter.identifiesKey("Am-000000000000")).toBe(false);
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
