/**
 * Provider adapter interface and registry.
 *
 * Each payment platform (Creem, Lemon Squeezy, Stripe, Paddle) implements
 * ProviderAdapter. The registry resolves which adapter handles a given key.
 */

import { ActivationError } from "./activation";

// Canonical payment event — matches PRD section 11.1.
export interface CanonicalPaymentEvent {
  provider: string;
  eventType:
    | "purchase.completed"
    | "subscription.created"
    | "subscription.renewed"
    | "subscription.cancelled"
    | "payment.failed"
    | "refund.created"
    | "chargeback.created";
  externalCustomerId?: string;
  externalOrderId?: string;
  externalSubscriptionId?: string;
  externalLicenseKey?: string;
  externalProductId?: string;
  externalVariantId?: string;
  occurredAt: string;
  rawPayload: unknown;
}

// Result returned by a provider adapter after validating an external license key.
export interface ExternalActivationResult {
  instanceId: string;
  externalProductId: string;
  status: string;
  activationLimit: number;
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
}

// Each payment provider implements this interface.
export interface ProviderAdapter {
  readonly name: string;

  /** Return true if this adapter can handle the given license key. */
  identifiesKey(key: string): boolean;

  /** Call the external provider to activate/validate a key. */
  activate(key: string, instanceName: string): Promise<ExternalActivationResult>;

  /** Call the external provider to deactivate an instance. */
  deactivate(key: string, instanceId: string): Promise<void>;

  /** Verify a webhook request signature. Returns true if valid. */
  verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<boolean>;

  /** Parse a raw webhook payload into a canonical payment event. */
  parseWebhook(body: unknown): Promise<CanonicalPaymentEvent>;

  /** Optional: query subscription status from the external provider. */
  getSubscription?(
    externalSubscriptionId: string
  ): Promise<{ status: string; currentPeriodEnd?: string }>;

  /** Optional: cancel a subscription on the external provider. */
  cancelSubscription?(externalSubscriptionId: string): Promise<void>;
}

export interface ProviderRegistry {
  /** Find the adapter that handles this license key. Returns null if none match. */
  identifyProvider(key: string): ProviderAdapter | null;

  /** Get an adapter by name (for webhook routing). */
  get(name: string): ProviderAdapter | undefined;

  /** Register an adapter. */
  register(adapter: ProviderAdapter): void;
}

export function createProviderRegistry(): ProviderRegistry {
  const byName = new Map<string, ProviderAdapter>();

  return {
    identifyProvider(key: string): ProviderAdapter | null {
      for (const adapter of byName.values()) {
        if (adapter.identifiesKey(key)) return adapter;
      }
      return null;
    },

    get(name: string): ProviderAdapter | undefined {
      return byName.get(name);
    },

    register(adapter: ProviderAdapter): void {
      byName.set(adapter.name, adapter);
    },
  };
}
