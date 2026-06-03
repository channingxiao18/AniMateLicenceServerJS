import { describe, expect, it } from "vitest";
import {
  addDays,
  computeInitialValidUntil,
  computeLicenceValidDays,
  dateIsPast,
} from "../src/services/activation";

const basePlan = {
  planId: "test-plan",
  productId: "animate",
  name: "Test Plan",
  edition: "companion",
  tier: "basic",
  billingModel: "lifetime",
  licenseModel: "single_machine",
  maxActivations: 1,
  maxAppMajor: 1,
  durationDays: null,
  billingPeriodDays: null,
  graceDays: null,
  refreshIntervalDays: null,
  offlineCacheDays: null,
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

describe("licence validity policy", () => {
  it("issues lifetime licences with valid_day 0", () => {
    expect(
      computeLicenceValidDays({
        billingModel: "lifetime",
        validUntil: null,
        refreshIntervalDays: null,
        offlineCacheDays: null,
      })
    ).toBe(0);
  });

  it("caps subscription licence duration by offline cache policy", () => {
    const now = new Date("2026-06-03T00:00:00Z");
    expect(
      computeLicenceValidDays({
        billingModel: "subscription",
        validUntil: "2026-07-03 00:00:00",
        refreshIntervalDays: 14,
        offlineCacheDays: 7,
        now,
      })
    ).toBe(7);
  });

  it("does not sign beyond entitlement expiry", () => {
    const now = new Date("2026-06-03T00:00:00Z");
    expect(
      computeLicenceValidDays({
        billingModel: "fixed_term",
        validUntil: "2026-06-05 00:00:00",
        refreshIntervalDays: 14,
        offlineCacheDays: 14,
        now,
      })
    ).toBe(2);
  });

  it("computes fixed-term initial expiry from duration_days", () => {
    const validUntil = computeInitialValidUntil(
      { ...basePlan, billingModel: "fixed_term", durationDays: 30 },
      new Date("2026-06-03T00:00:00Z")
    );
    expect(validUntil).toBe("2026-07-03 00:00:00");
  });

  it("recognizes expired timestamps", () => {
    expect(dateIsPast("2026-06-02 00:00:00", new Date("2026-06-03T00:00:00Z"))).toBe(true);
    expect(dateIsPast(addDays(new Date("2026-06-03T00:00:00Z"), 1), new Date("2026-06-03T00:00:00Z"))).toBe(false);
  });
});
