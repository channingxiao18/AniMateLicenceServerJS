/**
 * Integration scenario tests — simulate real client flows against an in-memory
 * SQLite database covering all PRD usage patterns.
 *
 * Each describe block is a self-contained scenario; the database is rebuilt
 * for each to avoid cross-test pollution.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestEnv,
  seedProduct,
  seedPlan,
  seedProviderMapping,
  TestEnv,
} from "./helpers/setup";
import { aesEncrypt, getAesKey, packAesBlob } from "../src/crypto/aes";
import {
  activateOrder,
  refreshLicence,
  deactivateOrder,
  queryLicenseStatus,
  batchCreateLicenses,
  ActivationError,
  addDays,
  nowISO,
  adminDeactivateOrder,
  adminReactivateOrder,
  adminRevokeOrder,
  adminExtendEntitlement,
  adminUnbindDevice,
  adminIncreaseDeviceCount,
} from "../src/services/activation";
import { processWebhook } from "../src/services/webhook";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Small wrapper that catches ActivationError and returns it for assertions. */
async function catchError(fn: () => Promise<unknown>): Promise<ActivationError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof ActivationError) return err;
    throw err;
  }
}

const clientA = {
  productId: "animate",
  fingerprint: "machine-client-a-001",
  appVersion: "1.2.0",
  platform: "windows",
};

const clientB = {
  productId: "animate",
  fingerprint: "machine-client-b-002",
  appVersion: "1.2.0",
  platform: "macos",
};

async function activate(
  env: TestEnv,
  licenseKey: string,
  fingerprint: string,
  productId = "animate"
) {
  return activateOrder(env.db, env.config, env.registry, {
    licenseKey,
    productId,
    fingerprint,
    appVersion: "1.2.0",
    platform: "windows",
    ipAddress: "10.0.0.1",
  });
}

async function refresh(
  env: TestEnv,
  licenseKey: string,
  fingerprint: string,
  productId = "animate"
) {
  return refreshLicence(env.db, env.config, {
    licenseKey,
    productId,
    fingerprint,
    appVersion: "1.2.0",
    platform: "windows",
    ipAddress: "10.0.0.1",
  });
}

async function fingerprintBlobForMachine(
  machineId: string,
  iv: string,
  options: { useSerial?: boolean } = {}
): Promise<string> {
  const useSerial = options.useSerial ?? false;
  const deviceInfo = {
    licence_sdk_version: "animate-1.0.0",
    cpu_info: "",
    mac_info: {},
    product_name_ok: false,
    product_name: "",
    product_serial_ok: useSerial,
    product_serial: useSerial ? machineId : "",
    product_uuid_ok: !useSerial,
    product_uuid: useSerial ? "" : machineId,
    product_version_ok: false,
    product_version: "",
    bios_date_ok: false,
    bios_date: "",
    bios_vendor_ok: false,
    bios_vendor: "",
    bios_version_ok: false,
    bios_version: "",
    board_name_ok: false,
    board_name: "",
    board_serial_ok: false,
    board_serial: "",
    board_vendor_ok: false,
    board_vendor: "",
    board_version_ok: false,
    board_version: "",
    system_disk_name: "",
    system_disk_serial_number: "",
    time: 1,
  };
  const ciphertextHex = await aesEncrypt(getAesKey(), iv, JSON.stringify(deviceInfo));
  return packAesBlob(iv, ciphertextHex);
}

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.1 — Lifetime, single-machine
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.1: Lifetime single-machine licence", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    [licenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "scenario-7.1",
      batchId: "test-7.1",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
  });

  it("first activation succeeds", async () => {
    const result = await activate(env, licenseKey, clientA.fingerprint);
    expect(result.licence).toBeTruthy();
    expect(result.licence.length).toBeGreaterThan(200);
    const ent = result.entitlement;
    expect(ent.product_id).toBe("animate");
    expect(ent.billing_model).toBe("lifetime");
    expect(ent.license_model).toBe("single_machine");
    expect(ent.status).toBe("active");
    expect(ent.max_activations).toBe(1);
    expect(ent.used_activations).toBe(1);
  });

  it("same machine re-activation (reissue) succeeds", async () => {
    const result = await activate(env, licenseKey, clientA.fingerprint);
    expect(result.licence).toBeTruthy();
    expect(result.entitlement.used_activations).toBe(1); // still 1, same device
  });

  it("same physical machine re-activation succeeds when fingerprint blob changes", async () => {
    const [blobLicenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "scenario-7.1-reinstall",
      batchId: "test-7.1-reinstall",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
    const firstFingerprint = await fingerprintBlobForMachine(
      "uuid-reinstall-same-machine",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    const secondFingerprint = await fingerprintBlobForMachine(
      "uuid-reinstall-same-machine",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );

    expect(secondFingerprint).not.toBe(firstFingerprint);
    await activate(env, blobLicenseKey, firstFingerprint);

    const result = await activate(env, blobLicenseKey, secondFingerprint);
    expect(result.licence).toBeTruthy();
    expect(result.entitlement.used_activations).toBe(1);

    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey: blobLicenseKey,
      productId: "animate",
      fingerprint: secondFingerprint,
    });
    expect(status.entitlement.current_device_active).toBe(true);
  });

  it("different physical machine with fingerprint blobs is still rejected", async () => {
    const [blobLicenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "scenario-7.1-different-machine",
      batchId: "test-7.1-different-machine",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
    const firstFingerprint = await fingerprintBlobForMachine(
      "uuid-bound-machine",
      "cccccccccccccccccccccccccccccccc"
    );
    const secondFingerprint = await fingerprintBlobForMachine(
      "uuid-other-machine",
      "dddddddddddddddddddddddddddddddd"
    );

    await activate(env, blobLicenseKey, firstFingerprint);
    const err = await catchError(() => activate(env, blobLicenseKey, secondFingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ACTIVATION_LIMIT_REACHED");
  });

  it("second machine activation is rejected", async () => {
    const err = await catchError(() => activate(env, licenseKey, clientB.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ACTIVATION_LIMIT_REACHED");
  });

  it("deactivation frees a device slot", async () => {
    await deactivateOrder(env.db, env.config, env.registry, {
      licenseKey,
      productId: "animate",
      fingerprint: clientA.fingerprint,
      ipAddress: "10.0.0.1",
    });

    // Now client B can activate
    const result = await activate(env, licenseKey, clientB.fingerprint);
    expect(result.entitlement.used_activations).toBe(1);
  });

  it("client A cannot refresh after deactivation", async () => {
    const err = await catchError(() => refresh(env, licenseKey, clientA.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("DEVICE_NOT_ACTIVATED");
  });

  it("status query works without active device", async () => {
    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
      fingerprint: "unknown-machine",
    });
    expect(status.status).toBe("active");
    expect(status.entitlement.current_device_active).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.2 — Lifetime, multi-machine
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.2: Lifetime multi-machine licence", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-pro-family",
      productId: "animate",
      name: "AniMate Pro Family",
      billingModel: "lifetime",
      licenseModel: "multi_machine",
      maxActivations: 3,
    });
    [licenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-pro-family",
      notes: "scenario-7.2",
      batchId: "test-7.2",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
  });

  it("three machines can activate", async () => {
    for (const fp of ["m1", "m2", "m3"]) {
      const r = await activate(env, licenseKey, fp);
      expect(r.licence).toBeTruthy();
    }
    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    expect(status.entitlement.used_activations).toBe(3);
    expect(status.entitlement.max_activations).toBe(3);
  });

  it("fourth machine is rejected", async () => {
    const err = await catchError(() => activate(env, licenseKey, "m4"));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ACTIVATION_LIMIT_REACHED");
  });

  it("same machine re-activation does not increase count", async () => {
    const r = await activate(env, licenseKey, "m1");
    expect(r.entitlement.used_activations).toBe(3);
  });

  it("deactivating one machine frees a slot", async () => {
    await deactivateOrder(env.db, env.config, env.registry, {
      licenseKey,
      productId: "animate",
      fingerprint: "m1",
      ipAddress: "10.0.0.1",
    });
    // m4 can now activate
    const r = await activate(env, licenseKey, "m4");
    expect(r.entitlement.used_activations).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.3 — Fixed-term (trial) licence
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.3: Fixed-term (trial) licence", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-trial-14d",
      productId: "animate",
      name: "AniMate Trial 14 Days",
      billingModel: "fixed_term",
      licenseModel: "single_machine",
      durationDays: 14,
      maxActivations: 1,
    });
    [licenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-trial-14d",
      notes: "scenario-7.3",
      batchId: "test-7.3",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
  });

  it("first activation sets valid_until to now + 14 days", async () => {
    const result = await activate(env, licenseKey, clientA.fingerprint);
    expect(result.entitlement.status).toBe("active");
    expect(result.entitlement.valid_until).toBeTruthy();
    // valid_until should be roughly 14 days from now (±5 seconds tolerance)
    const expected = addDays(new Date(), 14);
    const expectedDate = new Date(expected.replace(" ", "T") + "Z");
    const actualDate = new Date(
      (result.entitlement.valid_until as string).replace(" ", "T") + "Z"
    );
    expect(
      Math.abs(actualDate.getTime() - expectedDate.getTime())
    ).toBeLessThan(10000); // within 10 seconds
    // Licence is short-lived (not lifetime / valid_day=0)
    expect(result.licence).toBeTruthy();
  });

  it("refresh within validity period succeeds", async () => {
    const result = await refresh(env, licenseKey, clientA.fingerprint);
    expect(result.entitlement.status).toBe("active");
  });

  it("re-activation does NOT reset the trial clock (PRD 7.3 rule)", async () => {
    const first = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    // Re-activate same machine
    await activate(env, licenseKey, clientA.fingerprint);
    const second = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    // valid_until should not have changed
    expect(second.entitlement.valid_until).toBe(first.entitlement.valid_until);
  });

  it("activation with expired entitlement is rejected", async () => {
    // Manually set entitlement to expired in the past
    const { entitlements } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await env.db
      .update(entitlements)
      .set({
        status: "expired",
        validUntil: "2020-01-01 00:00:00",
      })
      .where(eq(entitlements.id, 1));

    const err = await catchError(() => refresh(env, licenseKey, clientA.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_EXPIRED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.4 — Subscription licence with webhook lifecycle
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.4: Subscription licence (webhook lifecycle)", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-pro-monthly",
      productId: "animate",
      name: "AniMate Pro Monthly",
      billingModel: "subscription",
      licenseModel: "single_machine",
      billingPeriodDays: 30,
      graceDays: 7,
      maxActivations: 1,
    });
    await seedProviderMapping(env.db, "mockpay", "animate-pro-monthly", "mock-ext-prod-monthly");

    // Simulate purchase webhook via mock provider
    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_sub_001",
        event: "order.completed",
        product_id: "mock-ext-prod-monthly",
        subscription_id: "sub_ext_abc",
        customer_id: "cus_123",
        license_key: "mp_sub_abc123",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    licenseKey = "mp_sub_abc123";
  });

  it("subscription and entitlement are created by webhook", async () => {
    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    expect(status.status).toBe("active");
    expect(status.entitlement.billing_model).toBe("subscription");
    expect(status.entitlement.valid_until).toBeTruthy();
    expect(status.entitlement.source_provider).toBe("mockpay");
  });

  it("activation on subscribed plan succeeds", async () => {
    const result = await activate(env, licenseKey, clientA.fingerprint);
    expect(result.licence).toBeTruthy();
    expect(result.entitlement.status).toBe("active");
  });

  it("refresh returns a short-lived licence", async () => {
    const result = await refresh(env, licenseKey, clientA.fingerprint);
    expect(result.licence).toBeTruthy();
  });

  it("subscription renewal extends valid_until", async () => {
    // Simulate renewal webhook
    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_sub_002",
        eventType: "subscription.renewed",
        subscription_id: "sub_ext_abc",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    expect(status.status).toBe("active");
    // valid_until should be extended by another billing period
    expect(status.entitlement.valid_until).toBeTruthy();
  });

  it("subscription cancellation keeps entitlement active until period end", async () => {
    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_sub_003",
        eventType: "subscription.cancelled",
        subscription_id: "sub_ext_abc",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    // Still active (period hasn't ended)
    const result = await refresh(env, licenseKey, clientA.fingerprint);
    expect(result.entitlement.status).toBe("active");
  });

  it("past period_end cancellation → lazy expire on refresh", async () => {
    // Manually set currentPeriodEnd to yesterday
    const { subscriptions, entitlements } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await env.db
      .update(subscriptions)
      .set({ currentPeriodEnd: "2020-01-01 00:00:00" })
      .where(eq(subscriptions.externalSubscriptionId, "sub_ext_abc"));
    // Reset entitlement to active so lazy expiration can trigger
    await env.db
      .update(entitlements)
      .set({ status: "active" })
      .where(eq(entitlements.id, 1));

    const err = await catchError(() => refresh(env, licenseKey, clientA.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_EXPIRED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.5 — Payment failed and grace period
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.5: Grace period during payment failure", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-pro-yearly",
      productId: "animate",
      name: "AniMate Pro Yearly",
      billingModel: "subscription",
      licenseModel: "single_machine",
      billingPeriodDays: 365,
      graceDays: 7,
      maxActivations: 1,
      allowNewDeviceDuringGrace: false,
    });
    await seedProviderMapping(env.db, "mockpay", "animate-pro-yearly", "mock-ext-prod-yearly");

    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_grace_001",
        eventType: "purchase.completed",
        product_id: "mock-ext-prod-yearly",
        subscription_id: "sub_grace_001",
        license_key: "mp_grace_001",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    licenseKey = "mp_grace_001";
    await activate(env, licenseKey, clientA.fingerprint);
  });

  it("payment.failed puts subscription into past_due and entitlement into grace", async () => {
    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_grace_002",
        eventType: "payment.failed",
        subscription_id: "sub_grace_001",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    expect(status.status).toBe("grace");
  });

  it("existing device can still refresh during grace", async () => {
    const result = await refresh(env, licenseKey, clientA.fingerprint);
    expect(result.entitlement.status).toBe("grace");
  });

  it("new device activation is blocked during grace (allowNewDeviceDuringGrace=false)", async () => {
    // First deactivate client A so a slot is free
    await deactivateOrder(env.db, env.config, env.registry, {
      licenseKey,
      productId: "animate",
      fingerprint: clientA.fingerprint,
      ipAddress: "10.0.0.1",
    });

    const err = await catchError(() => activate(env, licenseKey, clientB.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_GRACE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.6 — Refund / chargeback → revoked
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.6: Revoked after refund/chargeback", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-pro-yearly-2",
      productId: "animate",
      name: "AniMate Pro Yearly",
      billingModel: "subscription",
      licenseModel: "single_machine",
      billingPeriodDays: 365,
      graceDays: 7,
      maxActivations: 1,
    });
    await seedProviderMapping(env.db, "mockpay", "animate-pro-yearly-2", "mock-ext-prod-yearly-2");

    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_revoke_001",
        eventType: "purchase.completed",
        product_id: "mock-ext-prod-yearly-2",
        subscription_id: "sub_revoke_001",
        license_key: "mp_revoke_001",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    licenseKey = "mp_revoke_001";
    await activate(env, licenseKey, clientA.fingerprint);
  });

  it("refund → entitlement becomes revoked", async () => {
    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_revoke_002",
        eventType: "refund.created",
        subscription_id: "sub_revoke_001",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    expect(status.status).toBe("revoked");
  });

  it("activate is rejected after revoke", async () => {
    const err = await catchError(() => activate(env, licenseKey, clientB.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_REVOKED");
  });

  it("refresh is rejected after revoke", async () => {
    const err = await catchError(() => refresh(env, licenseKey, clientA.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_REVOKED");
  });

  it("cancel webhook cannot overwrite revoked status (Bug #5 fix)", async () => {
    // Send a cancel webhook — should NOT revert entitlement to active
    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_revoke_003",
        eventType: "subscription.cancelled",
        subscription_id: "sub_revoke_001",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey,
      productId: "animate",
    });
    // Must still be revoked, not active
    expect(status.status).toBe("revoked");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.7 — Multi-product isolation
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.7: Product mismatch rejection", () => {
  let env: TestEnv;
  let animateKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    // Create a second product
    await seedProduct(env.db, "animuse", "AniMuse");
    await seedPlan(env.db, {
      planId: "animuse-basic-lifetime",
      productId: "animuse",
      name: "AniMuse Basic Lifetime",
      billingModel: "lifetime",
      licenseModel: "single_machine",
      maxActivations: 1,
    });
    [animateKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "scenario-7.7",
      batchId: "test-7.7",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
  });

  it("product A licence activates product A", async () => {
    const r = await activate(env, animateKey, clientA.fingerprint, "animate");
    expect(r.licence).toBeTruthy();
  });

  it("product A licence is rejected for product B", async () => {
    const err = await catchError(() =>
      activateOrder(env.db, env.config, env.registry, {
        licenseKey: animateKey,
        productId: "animuse",
        fingerprint: "animuse-machine-001",
        appVersion: "1.0.0",
        platform: "windows",
        ipAddress: "10.0.0.1",
      })
    );
    expect(err).not.toBeNull();
    expect(err!.error).toBe("LICENSE_PRODUCT_MISMATCH");
    expect(err!.message).toContain("不适用于当前产品");
  });

  it("missing product_id defaults to config.defaultProductId", async () => {
    // Should work because defaultProductId is "animate"
    const r = await activateOrder(env.db, env.config, env.registry, {
      licenseKey: animateKey,
      fingerprint: clientA.fingerprint,
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "10.0.0.1",
    });
    expect(r.licence).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.8 — External provider license key
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.8: External provider (mock) license key activation", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  it("'mp_' key is identified by mock adapter", () => {
    const adapter = env.registry.identifyProvider("mp_test_key_123");
    expect(adapter).not.toBeNull();
    expect(adapter!.name).toBe("mockpay");
  });

  it("external key activation creates local entitlement and license", async () => {
    const result = await activate(env, "mp_test_key_123", clientA.fingerprint);
    expect(result.licence).toBeTruthy();
    expect(result.entitlement.product_id).toBe("animate");
    // source_provider is in the status query, not the activate response
    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey: "mp_test_key_123",
      productId: "animate",
    });
    expect(status.entitlement.source_provider).toBe("mockpay");
  });

  it("subsequent activation with same external key treats it as reissue", async () => {
    // Already imported, should just load and reissue
    const result = await activate(env, "mp_test_key_123", clientA.fingerprint);
    expect(result.licence).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRD 7.9 / 10.2 — Admin operations
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn 7.9: Admin operations (suspend, revoke, extend, increase devices)", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    [licenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "scenario-admin",
      batchId: "test-admin",
      actor: "admin",
      ipAddress: "127.0.0.1",
    });
  });

  it("admin suspends license → activate blocked", async () => {
    await activate(env, licenseKey, clientA.fingerprint);
    await adminDeactivateOrder(env.db, licenseKey, "127.0.0.1");

    const err = await catchError(() => refresh(env, licenseKey, clientA.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_SUSPENDED");
  });

  it("admin reactivates license → refresh works again", async () => {
    await adminReactivateOrder(env.db, licenseKey, "127.0.0.1");
    const result = await refresh(env, licenseKey, clientA.fingerprint);
    expect(result.entitlement.status).toBe("active");
  });

  it("admin revokes license → cannot reactivate", async () => {
    await adminRevokeOrder(env.db, licenseKey, "127.0.0.1");

    // Reactivation should be blocked for revoked
    const err = await catchError(() =>
      adminReactivateOrder(env.db, licenseKey, "127.0.0.1")
    );
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_REVOKED");
  });

  it("admin extends entitlement days", async () => {
    // Create a fresh licence first
    const [freshKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "extend-test",
      batchId: "test-extend",
      actor: "admin",
      ipAddress: "127.0.0.1",
    });

    // Set a known valid_until
    const { entitlements } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await env.db
      .update(entitlements)
      .set({ validUntil: "2026-12-31 00:00:00" })
      .where(eq(entitlements.id, 2));

    await adminExtendEntitlement(env.db, 2, 30, "127.0.0.1");

    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey: freshKey,
      productId: "animate",
    });
    expect(status.entitlement.valid_until).toBe("2027-01-30 00:00:00");
  });

  it("admin increases device count", async () => {
    // Create a fresh license
    const [multiKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "increase-test",
      batchId: "test-increase",
      actor: "admin",
      ipAddress: "127.0.0.1",
    });

    // Plan has max 1 device, activate once
    await activate(env, multiKey, "dev-A");
    const err = await catchError(() => activate(env, multiKey, "dev-B"));
    expect(err!.error).toBe("ACTIVATION_LIMIT_REACHED");

    // Increase to 3
    await adminIncreaseDeviceCount(env.db, 3, 3, "127.0.0.1");

    // Now dev-B and dev-C can activate
    await activate(env, multiKey, "dev-B");
    await activate(env, multiKey, "dev-C");

    const status = await queryLicenseStatus(env.db, env.config, {
      licenseKey: multiKey,
      productId: "animate",
    });
    expect(status.entitlement.used_activations).toBe(3);
  });

  it("admin unbinds a single device frees a slot", async () => {
    // From the "increase devices" test above, we have:
    // - License with entitlement id=3 (the third batch create)
    // - 3 active devices: dev-A, dev-B, dev-C
    // Unbind dev-B and verify dev-D can then activate.
    const { activations, entitlements, licenses } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");

    const act = await env.db
      .select()
      .from(activations)
      .where(eq(activations.fingerprint, "dev-B"))
      .get();
    expect(act).toBeTruthy();
    expect(act!.status).toBe("active");

    await adminUnbindDevice(env.db, act!.id, "127.0.0.1");

    // Verify dev-B is now deactivated
    const actAfter = await env.db
      .select()
      .from(activations)
      .where(eq(activations.id, act!.id))
      .get();
    expect(actAfter!.status).toBe("deactivated");

    // The multi-key from the increase-test batch still has 2 active devices
    // Find it via the entitlement
    const ent = await env.db
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, act!.entitlementId))
      .get();
    const lic = await env.db
      .select()
      .from(licenses)
      .where(eq(licenses.entitlementId, ent!.id))
      .get();
    expect(lic).toBeTruthy();

    // dev-D should now be able to activate (slot freed)
    const result = await activate(env, lic!.licenseKey, "dev-D");
    expect(result.entitlement.used_activations).toBe(3); // dev-A, dev-C, dev-D
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug #6 — Refresh interval enforcement
// ═══════════════════════════════════════════════════════════════════════════
describe("Bug #6: Refresh interval enforced", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-daily-refresh",
      productId: "animate",
      name: "AniMate Daily Refresh Required",
      billingModel: "subscription",
      licenseModel: "single_machine",
      billingPeriodDays: 30,
      refreshIntervalDays: 1, // must wait 1 day between refreshes
      maxActivations: 1,
    });
    [licenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-daily-refresh",
      notes: "bug-6-test",
      batchId: "test-bug6",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
    await activate(env, licenseKey, clientA.fingerprint);
  });

  it("first refresh after activation is blocked because activation set lastSeenAt", async () => {
    // Activation set lastSeenAt, so refresh within refreshIntervalDays is blocked.
    const err = await catchError(() => refresh(env, licenseKey, clientA.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("REFRESH_TOO_FREQUENT");
    expect(err!.statusCode).toBe(429);
  });

  it("refresh works after manually clearing lastSeenAt", async () => {
    // Manually set lastSeenAt to 2 days ago to simulate elapsed interval.
    const { activations } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await env.db
      .update(activations)
      .set({ lastSeenAt: "2020-01-01 00:00:00" })
      .where(eq(activations.fingerprint, clientA.fingerprint));

    const result = await refresh(env, licenseKey, clientA.fingerprint);
    expect(result.licence).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug #4 — Subscription validUntil sync on refresh
// ═══════════════════════════════════════════════════════════════════════════
describe("Bug #4: Refresh syncs validUntil from subscription", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-sub-sync",
      productId: "animate",
      name: "AniMate Sub Sync",
      billingModel: "subscription",
      licenseModel: "single_machine",
      billingPeriodDays: 30,
      maxActivations: 1,
    });
    await seedProviderMapping(env.db, "mockpay", "animate-sub-sync", "mock-ext-sync");

    await processWebhook(
      env.db,
      env.config,
      env.registry,
      "mockpay",
      JSON.stringify({
        id: "ord_sync_001",
        eventType: "purchase.completed",
        product_id: "mock-ext-sync",
        subscription_id: "sub_sync_001",
        license_key: "mp_sync_001",
        created_at: new Date().toISOString(),
      }),
      {}
    );

    licenseKey = "mp_sync_001";
    await activate(env, licenseKey, clientA.fingerprint);
  });

  it("refresh updates stale entitlement.validUntil from subscription.currentPeriodEnd", async () => {
    // Manually advance subscription currentPeriodEnd to the far future
    // and set entitlement validUntil to the near past
    const { subscriptions, entitlements } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");

    await env.db
      .update(subscriptions)
      .set({
        status: "active",
        currentPeriodEnd: "2027-06-03 00:00:00", // far future
      })
      .where(eq(subscriptions.externalSubscriptionId, "sub_sync_001"));

    await env.db
      .update(entitlements)
      .set({ validUntil: "2026-07-01 00:00:00" }) // stale, near past
      .where(eq(entitlements.id, 1));

    // Refresh should sync validUntil from subscription
    const result = await refresh(env, licenseKey, clientA.fingerprint);
    expect(result.entitlement.valid_until).toBe("2027-06-03 00:00:00");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Webhook dedup (Bug #3 verification)
// ═══════════════════════════════════════════════════════════════════════════
describe("Bug #3: Webhook event deduplication", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-dedup",
      productId: "animate",
      name: "AniMate Dedup",
      billingModel: "subscription",
      licenseModel: "single_machine",
      billingPeriodDays: 30,
      maxActivations: 1,
    });
    await seedProviderMapping(env.db, "mockpay", "animate-dedup", "mock-ext-dedup");
  });

  it("duplicate events with order_id return 'duplicate'", async () => {
    const payload = JSON.stringify({
      id: "ord_dedup_001",
      eventType: "purchase.completed",
      product_id: "mock-ext-dedup",
      subscription_id: "sub_dedup_001",
      created_at: new Date().toISOString(),
    });

    const r1 = await processWebhook(env.db, env.config, env.registry, "mockpay", payload, {});
    expect(r1.status).toBe("ok");

    const r2 = await processWebhook(env.db, env.config, env.registry, "mockpay", payload, {});
    expect(r2.status).toBe("duplicate");
  });

  it("duplicate subscription events (no order_id) are also deduped", async () => {
    const payload = JSON.stringify({
      id: "evt_no_order_001",
      eventType: "subscription.renewed",
      subscription_id: "sub_dedup_001",
      created_at: new Date().toISOString(),
    });

    const r1 = await processWebhook(env.db, env.config, env.registry, "mockpay", payload, {});
    expect(r1.status).toBe("ok");

    const r2 = await processWebhook(env.db, env.config, env.registry, "mockpay", payload, {});
    expect(r2.status).toBe("duplicate");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deactivation policy (PRD 7.2 — allow_self_deactivate)
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn: Self-deactivation policy", () => {
  let env: TestEnv;
  let keyAllow: string;
  let keyDeny: string;

  beforeAll(async () => {
    env = await createTestEnv();

    await seedPlan(env.db, {
      planId: "animate-allow-self",
      productId: "animate",
      name: "AniMate Allow Self Deactivate",
      billingModel: "lifetime",
      licenseModel: "single_machine",
      maxActivations: 1,
      allowSelfDeactivate: true,
    });
    await seedPlan(env.db, {
      planId: "animate-deny-self",
      productId: "animate",
      name: "AniMate Deny Self Deactivate",
      billingModel: "lifetime",
      licenseModel: "single_machine",
      maxActivations: 1,
      allowSelfDeactivate: false,
    });

    [keyAllow] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-allow-self",
      notes: "allow-self",
      batchId: "test-self-allow",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
    [keyDeny] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-deny-self",
      notes: "deny-self",
      batchId: "test-self-deny",
      actor: "test",
      ipAddress: "127.0.0.1",
    });

    await activate(env, keyAllow, clientA.fingerprint);
    await activate(env, keyDeny, clientB.fingerprint);
  });

  it("allowSelfDeactivate=true → client can self-deactivate", async () => {
    await deactivateOrder(env.db, env.config, env.registry, {
      licenseKey: keyAllow,
      productId: "animate",
      fingerprint: clientA.fingerprint,
      ipAddress: "10.0.0.1",
    });
  });

  it("allowSelfDeactivate=false → client self-deactivate is rejected", async () => {
    const err = await catchError(() =>
      deactivateOrder(env.db, env.config, env.registry, {
        licenseKey: keyDeny,
        productId: "animate",
        fingerprint: clientB.fingerprint,
        ipAddress: "10.0.0.1",
      })
    );
    expect(err).not.toBeNull();
    expect(err!.error).toBe("SELF_DEACTIVATE_DISABLED");
  });

  it("admin deactivation bypasses allowSelfDeactivate", async () => {
    await deactivateOrder(env.db, env.config, env.registry, {
      licenseKey: keyDeny,
      productId: "animate",
      fingerprint: clientB.fingerprint,
      ipAddress: "10.0.0.1",
      action: "deactivate_admin",
    });
    // Should succeed — admin action bypasses policy check
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security: deactivate requires licence token fingerprint match
// ═══════════════════════════════════════════════════════════════════════════
describe("Security: Deactivate licence token verification", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();

    await seedPlan(env.db, {
      planId: "animate-sec-deact",
      productId: "animate",
      name: "AniMate for Deact Test",
      billingModel: "lifetime",
      licenseModel: "single_machine",
      maxActivations: 1,
      allowSelfDeactivate: true,
    });
    [licenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-sec-deact",
      notes: "security-deact-test",
      batchId: "test-sec-deact",
      actor: "test",
      ipAddress: "127.0.0.1",
    });

    // Activate the device
    await activateOrder(env.db, env.config, env.registry, {
      licenseKey,
      productId: "animate",
      fingerprint: "my-machine",
      appVersion: "1.0.0",
      platform: "windows",
      ipAddress: "10.0.0.1",
    });
  });

  it("rejects deactivate when expectedFingerprint does not match request", async () => {
    // Attacker uses another device's licence token (other-machine) to try to
    // deactivate "my-machine"
    const err = await catchError(() =>
      deactivateOrder(env.db, env.config, env.registry, {
        licenseKey,
        productId: "animate",
        fingerprint: "my-machine",
        ipAddress: "10.0.0.1",
        expectedFingerprint: "other-machine", // mismatch!
      })
    );
    expect(err).not.toBeNull();
    expect(err!.error).toBe("FINGERPRINT_MISMATCH");
  });

  it("allows deactivate when expectedFingerprint matches request", async () => {
    await deactivateOrder(env.db, env.config, env.registry, {
      licenseKey,
      productId: "animate",
      fingerprint: "my-machine",
      ipAddress: "10.0.0.1",
      expectedFingerprint: "my-machine", // matches
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// App version enforcement
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn: App version check (max_app_major)", () => {
  let env: TestEnv;
  let licenseKey: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-v1-only",
      productId: "animate",
      name: "AniMate V1 Only",
      billingModel: "lifetime",
      licenseModel: "single_machine",
      maxActivations: 1,
      maxAppMajor: 1,
    });
    [licenseKey] = await batchCreateLicenses(env.db, {
      count: 1,
      planId: "animate-v1-only",
      notes: "v1-only",
      batchId: "test-v1",
      actor: "test",
      ipAddress: "127.0.0.1",
    });
  });

  it("app v1.x activates successfully", async () => {
    const result = await activateOrder(env.db, env.config, env.registry, {
      licenseKey,
      productId: "animate",
      fingerprint: "dev-v1",
      appVersion: "1.5.0",
      platform: "windows",
      ipAddress: "10.0.0.1",
    });
    expect(result.licence).toBeTruthy();
  });

  it("app v2.x is rejected (maxAppMajor=1)", async () => {
    // Deactivate first
    await deactivateOrder(env.db, env.config, env.registry, {
      licenseKey,
      productId: "animate",
      fingerprint: "dev-v1",
      ipAddress: "10.0.0.1",
    });

    const err = await catchError(() =>
      activateOrder(env.db, env.config, env.registry, {
        licenseKey,
        productId: "animate",
        fingerprint: "dev-v2",
        appVersion: "2.0.0",
        platform: "windows",
        ipAddress: "10.0.0.1",
      })
    );
    expect(err).not.toBeNull();
    expect(err!.error).toBe("APP_VERSION_NOT_COVERED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Batch operations
// ═══════════════════════════════════════════════════════════════════════════
describe("Scn: Batch license operations", () => {
  let env: TestEnv;
  let keys: string[];

  beforeAll(async () => {
    env = await createTestEnv();
    keys = await batchCreateLicenses(env.db, {
      count: 5,
      planId: "animate-companion-lifetime-basic-v1",
      notes: "batch-test",
      batchId: "test-batch-ops",
      actor: "admin",
      ipAddress: "127.0.0.1",
    });
  });

  it("batch suspend succeeds for all keys", async () => {
    const { batchSuspendLicenses } = await import("../src/services/activation");
    const result = await batchSuspendLicenses(env.db, keys, "127.0.0.1");
    expect(result.succeeded.length).toBe(5);
    expect(result.failed.length).toBe(0);
  });

  it("activation is blocked for suspended licenses", async () => {
    const err = await catchError(() => activate(env, keys[0], clientA.fingerprint));
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ENTITLEMENT_SUSPENDED");
  });

  it("batch reactivate restores all", async () => {
    const { batchReactivateLicenses } = await import("../src/services/activation");
    const result = await batchReactivateLicenses(env.db, keys, "127.0.0.1");
    expect(result.succeeded.length).toBe(5);
  });

  it("activation works again after batch reactivate", async () => {
    const r = await activate(env, keys[0], clientA.fingerprint);
    expect(r.licence).toBeTruthy();
  });
});
