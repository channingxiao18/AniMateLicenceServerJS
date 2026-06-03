import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../src/services/provider";
import type { ExternalActivationResult, ProviderAdapter } from "../src/services/provider";

function makeMockAdapter(
  name: string,
  prefix: string
): ProviderAdapter {
  return {
    name,
    identifiesKey(key: string): boolean {
      return key.startsWith(prefix);
    },
    async activate(_key: string, _instanceName: string): Promise<ExternalActivationResult> {
      return {
        instanceId: "mock-instance",
        externalProductId: "mock-product",
        status: "active",
        activationLimit: 1,
        expiresAt: null,
      };
    },
    async deactivate(): Promise<void> {},
    async verifyWebhook(): Promise<boolean> {
      return true;
    },
    async parseWebhook(body: unknown) {
      return {
        provider: name,
        eventType: "purchase.completed" as const,
        occurredAt: new Date().toISOString(),
        rawPayload: body,
      };
    },
  };
}

describe("ProviderRegistry", () => {
  it("returns null when empty", () => {
    const registry = createProviderRegistry();
    expect(registry.identifyProvider("any-key")).toBeNull();
  });

  it("registers and identifies adapters", () => {
    const registry = createProviderRegistry();
    const creemAdapter = makeMockAdapter("creem", "creem_");
    registry.register(creemAdapter);

    expect(registry.identifyProvider("creem_abc123")).toBe(creemAdapter);
    expect(registry.identifyProvider("AM-000000000000")).toBeNull();
    expect(registry.identifyProvider("lemonsqueezy_key")).toBeNull();
  });

  it("resolves multiple registered adapters by registration order", () => {
    const registry = createProviderRegistry();
    const creemAdapter = makeMockAdapter("creem", "creem_");
    const lemonAdapter = makeMockAdapter("lemonsqueezy", "ls_");

    registry.register(creemAdapter);
    registry.register(lemonAdapter);

    expect(registry.identifyProvider("creem_test")).toBe(creemAdapter);
    expect(registry.identifyProvider("ls_test")).toBe(lemonAdapter);
    expect(registry.get("creem")).toBe(creemAdapter);
    expect(registry.get("lemonsqueezy")).toBe(lemonAdapter);
  });

  it("get returns undefined for unregistered providers", () => {
    const registry = createProviderRegistry();
    expect(registry.get("stripe")).toBeUndefined();
  });

  it("first registered adapter wins for ambiguous keys", () => {
    const registry = createProviderRegistry();
    // Both adapters match any key (no AM- prefix means they could match)
    const adapterA = makeMockAdapter("a", "");
    const adapterB = makeMockAdapter("b", "");

    registry.register(adapterA);
    registry.register(adapterB);

    // Both adapters match the key (empty prefix), but adapterA was first
    expect(registry.identifyProvider("somekey")).toBe(adapterA);
  });
});
