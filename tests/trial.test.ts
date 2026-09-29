import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestEnv, seedPlan, seedProduct } from "./helpers/setup";
import { decryptLicencePayload } from "../src/licence/codec";
import { activations, entitlements, plans, telemetryEvents, trialGrants } from "../src/db/schema";
import { createAdminApiRouter } from "../src/routes/admin_api";
import { ActivationError } from "../src/services/activation";
import { listTrialGrants, startTrial } from "../src/services/trial";
import { aesEncrypt, getAesKey, packAesBlob } from "../src/crypto/aes";

async function catchActivationError(fn: () => Promise<unknown>): Promise<ActivationError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof ActivationError) return err;
    throw err;
  }
}

async function fingerprintBlobForMachine(machineId: string, iv: string): Promise<string> {
  const deviceInfo = {
    licence_sdk_version: "animate-1.0.0",
    product_serial_ok: false,
    product_serial: "",
    product_uuid_ok: true,
    product_uuid: machineId,
    time: Date.now(),
  };
  const ciphertextHex = await aesEncrypt(getAesKey(), iv, JSON.stringify(deviceInfo));
  return packAesBlob(iv, ciphertextHex);
}

async function machineHashForMachineId(machineId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`animate-telemetry-v1:${machineId}`)
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("trial licence grants", () => {
  it("creates a first trial grant and signs a trial-only licence", async () => {
    const env = await createTestEnv();
    const before = Date.now();

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-001",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    expect(result.trial.code).toBe("TRIAL_STARTED");
    expect(result.trial.status).toBe("active");
    expect(result.trial.feature).toBe("trial");
    expect(result.trial.features).toEqual(["import_vrm", "import_dance", "import_stage"]);
    expect(result.trial.product_id).toBe("animate");
    expect(result.trial.plan_id).toBe("animate-import-vrm-trial-24h-v1");
    expect(result.trial.duration_seconds).toBe(86400);

    const [auth, fingerprint] = await decryptLicencePayload(
      result.licence,
      env.keys.publicKeySpkiHex
    );
    expect(fingerprint).toBe("trial-machine-001");
    expect(auth.product_id).toBe("animate");
    expect(auth.tier).toBe("trial");
    expect(auth.licence_kind).toBe("trial");
    expect(auth.features).toEqual(["import_vrm", "import_dance", "import_stage"]);
    expect(auth.valid_day).toBe(0);
    expect(typeof auth.valid_until).toBe("number");

    const validUntilMs = Number(auth.valid_until) * 1000;
    expect(validUntilMs - before).toBeGreaterThan(86_390_000);
    expect(validUntilMs - before).toBeLessThan(86_410_000);

    const stored = await env.db.select().from(trialGrants).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].planId).toBe("animate-import-vrm-trial-24h-v1");
    expect(stored[0].feature).toBe("trial");
    expect(stored[0].fingerprintHash).not.toContain("trial-machine-001");
    expect(stored[0].licenceTokenHash).toBeTruthy();
  });

  it("returns the existing active trial without extending valid_until", async () => {
    const env = await createTestEnv();

    const first = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-002",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });
    const second = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-002",
      appVersion: "1.2.1",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    expect(second.trial.code).toBe("TRIAL_ACTIVE");
    expect(second.trial.trial_id).toBe(first.trial.trial_id);
    expect(second.trial.started_at).toBe(first.trial.started_at);
    expect(second.trial.valid_until).toBe(first.trial.valid_until);

    const grants = await env.db.select().from(trialGrants).all();
    expect(grants).toHaveLength(1);
  });

  it("treats changing fingerprint blobs from the same physical machine as the same trial device", async () => {
    const env = await createTestEnv();
    const firstFingerprint = await fingerprintBlobForMachine(
      "trial-same-physical-machine",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    const secondFingerprint = await fingerprintBlobForMachine(
      "trial-same-physical-machine",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    const thirdFingerprint = await fingerprintBlobForMachine(
      "trial-same-physical-machine",
      "cccccccccccccccccccccccccccccccc"
    );

    expect(secondFingerprint).not.toBe(firstFingerprint);

    const first = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: firstFingerprint,
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });
    const second = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: secondFingerprint,
      appVersion: "1.2.1",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    expect(second.trial.code).toBe("TRIAL_ACTIVE");
    expect(second.trial.trial_id).toBe(first.trial.trial_id);

    await env.db
      .update(trialGrants)
      .set({
        validUntil: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
      })
      .where(eq(trialGrants.id, first.trial.trial_id));

    const err = await catchActivationError(() =>
      startTrial(env.db, env.config, {
        productId: "animate",
        fingerprint: thirdFingerprint,
        appVersion: "1.2.2",
        platform: "windows",
        ipAddress: "127.0.0.1",
      })
    );

    expect(err).not.toBeNull();
    expect(err!.error).toBe("TRIAL_ALREADY_USED");
    expect(err!.details?.trial).toMatchObject({
      trial_id: first.trial.trial_id,
      status: "expired",
      code: "TRIAL_ALREADY_USED",
    });

    const grants = await env.db.select().from(trialGrants).all();
    expect(grants).toHaveLength(1);
  });

  it("uses the matching product trial plan for another product", async () => {
    const env = await createTestEnv();
    await seedProduct(env.db, "animuse", "AniMuse");
    await seedPlan(env.db, {
      planId: "animuse-vrm-trial-12h",
      productId: "animuse",
      name: "AniMuse VRM Trial 12h",
      edition: "studio",
      tier: "trial",
      billingModel: "trial",
      licenseModel: "single_machine",
      maxActivations: 1,
      maxAppMajor: 3,
      durationDays: null,
      featuresJson: JSON.stringify(["import_vrm", "animuse_preview"]),
      metadataJson: JSON.stringify({
        duration_seconds: 43200,
      }),
    });

    const result = await startTrial(env.db, env.config, {
      productId: "animuse",
      fingerprint: "trial-machine-animuse",
      appVersion: "3.0.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    expect(result.trial.plan_id).toBe("animuse-vrm-trial-12h");
    expect(result.trial.features).toEqual(["import_vrm", "animuse_preview"]);
    expect(result.trial.duration_seconds).toBe(43200);

    const [auth, fingerprint] = await decryptLicencePayload(
      result.licence,
      env.keys.publicKeySpkiHex
    );
    expect(fingerprint).toBe("trial-machine-animuse");
    expect(auth.product_id).toBe("animuse");
    expect(auth.edition).toBe("studio");
    expect(auth.max_app_major).toBe(3);
    expect(auth.features).toEqual(["import_vrm", "animuse_preview"]);
  });

  it("rejects a repeat request after the trial has expired and returns trial details", async () => {
    const env = await createTestEnv();

    const first = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-003",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    await env.db
      .update(trialGrants)
      .set({
        validUntil: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
      })
      .where(eq(trialGrants.id, first.trial.trial_id));

    const err = await catchActivationError(() =>
      startTrial(env.db, env.config, {
        productId: "animate",
        fingerprint: "trial-machine-003",
        appVersion: "1.2.0",
        platform: "windows",
        ipAddress: "127.0.0.1",
      })
    );

    expect(err).not.toBeNull();
    expect(err!.error).toBe("TRIAL_ALREADY_USED");
    expect(err!.statusCode).toBe(409);
    expect(err!.details?.trial).toMatchObject({
      trial_id: first.trial.trial_id,
      status: "expired",
      code: "TRIAL_ALREADY_USED",
      feature: "trial",
      valid_until: "2026-01-01T00:00:00Z",
    });

    const grant = await env.db
      .select()
      .from(trialGrants)
      .where(eq(trialGrants.id, first.trial.trial_id))
      .get();
    expect(grant?.status).toBe("expired");
  });

  it("always signs the server-configured plan features", async () => {
    const env = await createTestEnv();

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-004",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    expect(result.trial.features).toEqual(["import_vrm", "import_dance", "import_stage"]);

    const [auth] = await decryptLicencePayload(
      result.licence,
      env.keys.publicKeySpkiHex
    );
    expect(auth.features).toEqual(["import_vrm", "import_dance", "import_stage"]);
  });

  it("normalizes malformed stored plan features before signing trial licences", async () => {
    const env = await createTestEnv();
    const malformedFeatures = '["[\\"import_vrm\\"","\\"import_dance\\"","\\"import_stage\\"]"]';
    await env.db
      .update(plans)
      .set({ featuresJson: malformedFeatures })
      .where(eq(plans.planId, "animate-import-vrm-trial-24h-v1"));

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-malformed-features",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    expect(result.trial.features).toEqual(["import_vrm", "import_dance", "import_stage"]);

    const [auth] = await decryptLicencePayload(
      result.licence,
      env.keys.publicKeySpkiHex
    );
    expect(auth.features).toEqual(["import_vrm", "import_dance", "import_stage"]);
  });

  it("lists trial grants with the same plan features used for signed licences", async () => {
    const env = await createTestEnv();

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-list",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    const grants = await listTrialGrants(env.db, env.config, { page: 1, pageSize: 20 });

    expect(grants.total).toBe(1);
    expect(grants.items[0].id).toBe(result.trial.trial_id);
    expect(grants.items[0].product?.name).toBe("AniMate");
    expect(grants.items[0].plan?.planId).toBe("animate-import-vrm-trial-24h-v1");
    expect(JSON.parse(grants.items[0].plan?.featuresJson || "[]")).toEqual([
      "import_vrm",
      "import_dance",
      "import_stage",
    ]);
  });

  it("searches trial grants by fingerprint hash, machine hash and install id", async () => {
    const env = await createTestEnv();
    const machineId = "search-machine-uuid-0001";
    const fingerprint = await fingerprintBlobForMachine(
      machineId,
      "abcdef0123456789abcdef0123456789"
    );

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint,
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });
    await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "unrelated-opaque-fingerprint",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    const grant = await env.db
      .select()
      .from(trialGrants)
      .where(eq(trialGrants.id, result.trial.trial_id))
      .get();
    expect(grant).toBeTruthy();
    expect(grant!.telemetryMachineHash).toBeTruthy();

    // Full and prefix fingerprint hash both narrow down to the single grant.
    for (const term of [grant!.fingerprintHash, grant!.fingerprintHash.slice(0, 16)]) {
      const found = await listTrialGrants(env.db, env.config, { page: 1, pageSize: 20, search: term });
      expect(found.total).toBe(1);
      expect(found.items[0].id).toBe(grant!.id);
    }

    // Telemetry machine hash (what the admin sees on telemetry pages).
    const byMachineHash = await listTrialGrants(env.db, env.config, {
      page: 1,
      pageSize: 20,
      search: grant!.telemetryMachineHash!,
    });
    expect(byMachineHash.total).toBe(1);
    expect(byMachineHash.items[0].id).toBe(grant!.id);

    // Install id is resolved through telemetry_events to its machine hash.
    const installId = "install-id-for-search-machine";
    await env.db.insert(telemetryEvents).values({
      eventId: "evt-search-test-1",
      schemaVersion: 1,
      event: "app_launch",
      sourceId: "desktop_prod",
      receivedAtUnix: Math.floor(Date.now() / 1000),
      productId: "animate",
      machineHash: grant!.telemetryMachineHash!,
      installId,
      payloadJson: "{}",
      rawJson: "{}",
    });
    const byInstallId = await listTrialGrants(env.db, env.config, {
      page: 1,
      pageSize: 20,
      search: installId.toUpperCase(),
    });
    expect(byInstallId.total).toBe(1);
    expect(byInstallId.items[0].id).toBe(grant!.id);

    // An install id with no telemetry rows matches nothing.
    const unknownInstall = await listTrialGrants(env.db, env.config, {
      page: 1,
      pageSize: 20,
      search: "install-id-never-seen",
    });
    expect(unknownInstall.total).toBe(0);
  });

  it("finds legacy grants without telemetry_machine_hash via paid activation fingerprints", async () => {
    const env = await createTestEnv();
    const machineId = "legacy-bridge-machine-0001";
    const trialFingerprint = await fingerprintBlobForMachine(
      machineId,
      "101112131415161718191a1b1c1d1e1f"
    );

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: trialFingerprint,
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    // Simulate a pre-0009 grant: telemetry_machine_hash used to be NULL.
    await env.db
      .update(trialGrants)
      .set({ telemetryMachineHash: null })
      .where(eq(trialGrants.id, result.trial.trial_id))
      .run();

    // The same machine later activates a paid licence from a fresh blob
    // (different iv/timestamp), storing its raw fingerprint and machine hash.
    const activationFingerprint = await fingerprintBlobForMachine(
      machineId,
      "2122232425262728292a2b2c2d2e2f30"
    );
    const machineHash = await machineHashForMachineId(machineId);
    await env.db
      .insert(entitlements)
      .values({ productId: "animate", planId: "animate-companion-lifetime-basic-v1", status: "active" })
      .run();
    const entitlement = await env.db.select().from(entitlements).all();
    await env.db
      .insert(activations)
      .values({
        entitlementId: entitlement[entitlement.length - 1].id,
        fingerprint: activationFingerprint,
        telemetryMachineHash: machineHash,
      })
      .run();

    const found = await listTrialGrants(env.db, env.config, {
      page: 1,
      pageSize: 20,
      search: machineHash,
    });
    expect(found.total).toBe(1);
    expect(found.items[0].id).toBe(result.trial.trial_id);
    expect(found.items[0].telemetryMachineHash).toBeNull();
  });

  it("deletes trial grants through the admin API for testing", async () => {
    const env = await createTestEnv();

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-delete",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    const router = createAdminApiRouter(env.db, env.config, env.registry);
    const response = await router.request(
      `/trials/${encodeURIComponent(result.trial.trial_id)}/delete`,
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    const grants = await listTrialGrants(env.db, env.config, { page: 1, pageSize: 20 });
    expect(grants.total).toBe(0);
  });

  it("rejects mismatched products", async () => {
    const env = await createTestEnv();

    const err = await catchActivationError(() =>
      startTrial(env.db, env.config, {
        productId: "unknown-product",
        fingerprint: "trial-machine-005",
        appVersion: "1.2.0",
        platform: "windows",
        ipAddress: "127.0.0.1",
      })
    );

    expect(err).not.toBeNull();
    expect(err!.error).toBe("TRIAL_PRODUCT_MISMATCH");
    expect(err!.statusCode).toBe(400);
  });

  it("returns unavailable for products without an active trial plan", async () => {
    const env = await createTestEnv();
    await seedProduct(env.db, "no-trial-product", "No Trial Product");

    const err = await catchActivationError(() =>
      startTrial(env.db, env.config, {
        productId: "no-trial-product",
        fingerprint: "trial-machine-006",
        appVersion: "1.2.0",
        platform: "windows",
        ipAddress: "127.0.0.1",
      })
    );

    expect(err).not.toBeNull();
    expect(err!.error).toBe("TRIAL_UNAVAILABLE");
    expect(err!.statusCode).toBe(200);
  });

  it("returns unavailable when trial is disabled", async () => {
    const env = await createTestEnv();
    env.config.trialEnabled = false;

    const err = await catchActivationError(() =>
      startTrial(env.db, env.config, {
        productId: "animate",
        fingerprint: "trial-machine-007",
        appVersion: "1.2.0",
        platform: "windows",
        ipAddress: "127.0.0.1",
      })
    );

    expect(err).not.toBeNull();
    expect(err!.error).toBe("TRIAL_UNAVAILABLE");
    expect(err!.statusCode).toBe(200);
  });

  it("returns unavailable when a product has multiple active trial plans", async () => {
    const env = await createTestEnv();
    await seedPlan(env.db, {
      planId: "animate-second-trial",
      productId: "animate",
      name: "AniMate Second Trial",
      tier: "trial",
      billingModel: "trial",
      featuresJson: JSON.stringify(["import_vrm"]),
      metadataJson: JSON.stringify({ duration_seconds: 60 }),
    });

    const err = await catchActivationError(() =>
      startTrial(env.db, env.config, {
        productId: "animate",
        fingerprint: "trial-machine-008",
        appVersion: "1.2.0",
        platform: "windows",
        ipAddress: "127.0.0.1",
      })
    );

    expect(err).not.toBeNull();
    expect(err!.error).toBe("TRIAL_UNAVAILABLE");
    expect(err!.statusCode).toBe(200);
  });
});
