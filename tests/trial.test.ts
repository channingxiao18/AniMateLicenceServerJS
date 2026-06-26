import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestEnv, seedPlan, seedProduct } from "./helpers/setup";
import { decryptLicencePayload } from "../src/licence/codec";
import { trialGrants } from "../src/db/schema";
import { ActivationError } from "../src/services/activation";
import { listTrialGrants, startTrial } from "../src/services/trial";

async function catchActivationError(fn: () => Promise<unknown>): Promise<ActivationError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof ActivationError) return err;
    throw err;
  }
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
        trial_feature: "import_vrm",
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
      feature: "import_vrm",
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

  it("lists trial grants with the same plan features used for signed licences", async () => {
    const env = await createTestEnv();

    const result = await startTrial(env.db, env.config, {
      productId: "animate",
      fingerprint: "trial-machine-list",
      appVersion: "1.2.0",
      platform: "windows",
      ipAddress: "127.0.0.1",
    });

    const grants = await listTrialGrants(env.db, { page: 1, pageSize: 20 });

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
