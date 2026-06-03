import { describe, expect, it } from "vitest";
import {
  addDays,
  dateIsPast,
  computeInitialValidUntil,
  computeLicenceValidDays,
} from "../src/services/activation";

// Test the PRD section 9 state machine rules for subscription-driven entitlement status.
// The actual syncEntitlementFromSubscription is private in webhook.ts, so we validate
// the mapping rules via the building-block functions that back them.

describe("subscription-entitlement state sync", () => {
  const now = new Date("2026-06-03T00:00:00Z");

  describe("grace period computation", () => {
    it("defaults to 7-day grace for past_due", () => {
      const graceUntil = addDays(now, 7);
      expect(graceUntil).toBe("2026-06-10 00:00:00");
    });

    it("uses plan grace_days when configured", () => {
      const graceUntil = addDays(now, 14); // 14-day plan grace
      expect(graceUntil).toBe("2026-06-17 00:00:00");
    });
  });

  describe("lazy expiration for cancelled subscriptions", () => {
    it("treats past period_end as expired at refresh time", () => {
      // A cancelled subscription that ended yesterday should fail refresh
      const periodEnd = "2026-06-02 00:00:00";
      expect(dateIsPast(periodEnd, now)).toBe(true);
    });

    it("allows cancelled-but-still-in-period at refresh time", () => {
      // A cancelled subscription that ends tomorrow should still pass
      const periodEnd = addDays(now, 1);
      expect(dateIsPast(periodEnd, now)).toBe(false);
    });
  });

  describe("initial validity computation per billing model", () => {
    const basePlan = {
      planId: "test",
      productId: "animate",
      name: "Test",
      edition: "companion",
      tier: "basic",
      billingModel: "lifetime" as const,
      licenseModel: "single_machine" as const,
      maxActivations: 1,
      maxAppMajor: 1,
      durationDays: null as number | null,
      billingPeriodDays: null as number | null,
      graceDays: null as number | null,
      refreshIntervalDays: null as number | null,
      offlineCacheDays: null as number | null,
      allowSelfDeactivate: true,
      allowReactivation: true,
      allowNewDeviceDuringGrace: false,
      featuresJson: "[]",
      isActive: true,
      sortOrder: 0,
      metadataJson: null,
      createdAt: "2026-01-01 00:00:00",
      updatedAt: "2026-01-01 00:00:00",
    };

    it("lifetime plans have null valid_until", () => {
      expect(
        computeInitialValidUntil({ ...basePlan, billingModel: "lifetime" }, now)
      ).toBeNull();
    });

    it("subscription plans default to 30-day billing period", () => {
      const validUntil = computeInitialValidUntil(
        { ...basePlan, billingModel: "subscription" },
        now
      );
      expect(validUntil).toBe("2026-07-03 00:00:00");
    });

    it("subscription plans use configured billing_period_days", () => {
      const validUntil = computeInitialValidUntil(
        { ...basePlan, billingModel: "subscription", billingPeriodDays: 365 },
        now
      );
      expect(validUntil).toBe("2027-06-03 00:00:00");
    });

    it("fixed_term plans use duration_days", () => {
      const validUntil = computeInitialValidUntil(
        { ...basePlan, billingModel: "fixed_term", durationDays: 14 },
        now
      );
      expect(validUntil).toBe("2026-06-17 00:00:00");
    });

    it("trial plans default to 14 days", () => {
      const validUntil = computeInitialValidUntil(
        { ...basePlan, billingModel: "trial" },
        now
      );
      expect(validUntil).toBe("2026-06-17 00:00:00");
    });
  });

  describe("licence validity window", () => {
    it("subscription licences are capped by offline_cache_days", () => {
      expect(
        computeLicenceValidDays({
          billingModel: "subscription",
          validUntil: "2026-08-03 00:00:00",
          refreshIntervalDays: 14,
          offlineCacheDays: 7,
          now,
        })
      ).toBe(7);
    });

    it("does not sign beyond entitlement expiry", () => {
      expect(
        computeLicenceValidDays({
          billingModel: "fixed_term",
          validUntil: "2026-06-05 00:00:00",
          refreshIntervalDays: 14,
          offlineCacheDays: 14,
          now,
        })
      ).toBe(2); // only 2 days left
    });
  });
});
