import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers/setup";
import { catalogGrants, catalogModels } from "../src/db/schema";
import { eq } from "drizzle-orm";
import {
  catalogFingerprintHashCandidates,
  catalogStatusFor,
  claimCatalogModel,
  isCountryEligible,
  modelServesLocale,
  parseLocales,
  pickRandomModel,
  presignedGetUrl,
  reportCatalogResult,
  resolveManifestContent,
  type CatalogObjectStore,
} from "../src/services/catalog";
import { ActivationError } from "../src/services/activation";
import { startTrial } from "../src/services/trial";

async function catchActivationError(fn: () => Promise<unknown>): Promise<ActivationError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ActivationError) return err;
    throw err;
  }
  throw new Error("expected ActivationError");
}

function fakeBucket(manifest: unknown): CatalogObjectStore {
  return { get: async () => ({ json: async () => manifest }) };
}

const TEST_MANIFEST = {
  id: "mdl_test",
  name: { en: "Test Model", ja: "テストモデル" },
  tags: { en: ["cute"], ja: ["かわいい"] },
  license_note: "test only",
};

async function seedModel(env: TestEnv, overrides: Partial<{ id: string; enabled: boolean }> = {}) {
  const id = overrides.id ?? "mdl_test";
  await env.db.insert(catalogModels).values({
    id,
    enabled: overrides.enabled ?? true,
    weight: 1,
    sha256: "a".repeat(64),
    sizeBytes: 8_300_000,
    r2KeyVrm: `catalog/${id}/model.vrm`,
    r2KeyThumb: `catalog/${id}/thumb.jpg`,
    manifestKey: `catalog/${id}/manifest.json`,
    locales: JSON.stringify(["en", "ja"]),
  });
}

/** Enable the catalog on the test config and point presigning at a dummy endpoint. */
function enableCatalog(env: TestEnv) {
  env.config.catalogEnabled = true;
  env.config.catalogR2Endpoint = "https://test-account.r2.cloudflarestorage.com/test-bucket";
  env.config.r2AccessKeyId = "test-key";
  env.config.r2SecretAccessKey = "test-secret";
}

async function startTrialFor(env: TestEnv, fingerprint: string) {
  return startTrial(env.db, env.config, {
    productId: "animate",
    fingerprint,
    appVersion: "0.13.0",
    platform: "windows",
    ipAddress: "127.0.0.1",
  });
}

describe("catalog pure helpers", () => {
  it("gates by country with CN excluded and missing geo allowed", () => {
    expect(isCountryEligible({ catalogExcludedCountries: ["CN"] }, "CN")).toBe(false);
    expect(isCountryEligible({ catalogExcludedCountries: ["CN"] }, "cn")).toBe(false);
    expect(isCountryEligible({ catalogExcludedCountries: ["CN"] }, "US")).toBe(true);
    expect(isCountryEligible({ catalogExcludedCountries: ["CN"] }, null)).toBe(true);
  });

  it("parses locale JSON defensively and matches locale coverage", () => {
    expect(parseLocales('["en","ja"]')).toEqual(["en", "ja"]);
    expect(parseLocales("not-json")).toEqual([]);
    expect(parseLocales(null)).toEqual([]);
    expect(modelServesLocale(["en", "ja"], "ja")).toBe(true);
    expect(modelServesLocale(["en"], "ja")).toBe(true); // en fallback
    expect(modelServesLocale(["ja"], "fr")).toBe(false);
  });

  it("resolves manifest copy with en fallback", () => {
    expect(resolveManifestContent(TEST_MANIFEST, "ja")).toEqual({
      name: "テストモデル",
      tags: ["かわいい"],
      locale: "ja",
    });
    expect(resolveManifestContent(TEST_MANIFEST, "fr")).toEqual({
      name: "Test Model",
      tags: ["cute"],
      locale: "en",
    });
    expect(resolveManifestContent({ name: {} }, "en")).toBeNull();
    expect(resolveManifestContent(null, "en")).toBeNull();
  });

  it("picks a member of the pool", () => {
    expect(pickRandomModel([])).toBeNull();
    const pool = ["a", "b", "c"];
    expect(pool).toContain(pickRandomModel(pool));
  });
});

describe("presigned GET url", () => {
  it("produces a sigv4 query-signed URL with expiry", async () => {
    const url = await presignedGetUrl({
      endpoint: "https://test-account.r2.cloudflarestorage.com/test-bucket",
      key: "catalog/mdl_test/model.vrm",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      expiresInSeconds: 900,
    });
    expect(url.startsWith("https://test-account.r2.cloudflarestorage.com/test-bucket/catalog/mdl_test/model.vrm")).toBe(true);
    expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(url).toContain("X-Amz-Expires=900");
    expect(url).toContain("X-Amz-SignedHeaders=host");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Credential=");
  });
});

describe("catalog claim flow", () => {
  it("rejects machines without an active trial", async () => {
    const env = await createTestEnv();
    enableCatalog(env);
    await seedModel(env);
    const err = await catchActivationError(() =>
      claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
        productId: "animate",
        fingerprint: "no-trial-machine",
        locale: "en",
        appVersion: "0.13.0",
        platform: "windows",
        country: "US",
        grantId: null,
      })
    );
    expect(err.error).toBe("TRIAL_REQUIRED");
  });

  it("rejects when the catalog is disabled or the country is excluded", async () => {
    const env = await createTestEnv();
    enableCatalog(env);
    await seedModel(env);
    await startTrialFor(env, "cn-machine");

    env.config.catalogEnabled = false;
    const disabled = await catchActivationError(() =>
      claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
        productId: "animate",
        fingerprint: "cn-machine",
        locale: "en",
        appVersion: null,
        platform: null,
        country: "US",
        grantId: null,
      })
    );
    expect(disabled.error).toBe("CATALOG_DISABLED");

    env.config.catalogEnabled = true;
    const excluded = await catchActivationError(() =>
      claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
        productId: "animate",
        fingerprint: "cn-machine",
        locale: "en",
        appVersion: null,
        platform: null,
        country: "CN",
        grantId: null,
      })
    );
    expect(excluded.error).toBe("REGION_NOT_ELIGIBLE");
  });

  it("claims a model, honours locale fallback, counts quota and supports grant retry", async () => {
    const env = await createTestEnv();
    enableCatalog(env);
    await seedModel(env);
    await startTrialFor(env, "trial-machine-100");

    const claim = await claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
      productId: "animate",
      fingerprint: "trial-machine-100",
      locale: "ja",
      appVersion: "0.13.0",
      platform: "windows",
      country: "US",
      grantId: null,
    });
    expect(claim.model.id).toBe("mdl_test");
    expect(claim.model.name).toBe("テストモデル");
    expect(claim.model.content_locale).toBe("ja");
    expect(claim.download.url).toContain("X-Amz-Signature=");
    expect(claim.download.sha256).toBe("a".repeat(64));

    const grants = await env.db
      .select()
      .from(catalogGrants)
      .where(eq(catalogGrants.grantId, claim.grant_id))
      .all();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.status).toBe("claimed");

    // Retry with the same grant_id → same model, no extra quota row.
    const retry = await claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
      productId: "animate",
      fingerprint: "trial-machine-100",
      locale: "en",
      appVersion: "0.13.0",
      platform: "windows",
      country: "US",
      grantId: claim.grant_id,
    });
    expect(retry.grant_id).toBe(claim.grant_id);
    expect(retry.model.id).toBe("mdl_test");

    // Two more new claims reach the quota of 3; a fourth is rejected.
    await claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
      productId: "animate",
      fingerprint: "trial-machine-100",
      locale: "en",
      appVersion: null,
      platform: null,
      country: "US",
      grantId: null,
    });
    await claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
      productId: "animate",
      fingerprint: "trial-machine-100",
      locale: "en",
      appVersion: null,
      platform: null,
      country: "US",
      grantId: null,
    });
    const exhausted = await catchActivationError(() =>
      claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
        productId: "animate",
        fingerprint: "trial-machine-100",
        locale: "en",
        appVersion: null,
        platform: null,
        country: "US",
        grantId: null,
      })
    );
    expect(exhausted.error).toBe("QUOTA_EXHAUSTED");
  });

  it("reports results and rejects reports from other machines", async () => {
    const env = await createTestEnv();
    enableCatalog(env);
    await seedModel(env);
    await startTrialFor(env, "report-machine");

    const claim = await claimCatalogModel(env.db, env.config, fakeBucket(TEST_MANIFEST), {
      productId: "animate",
      fingerprint: "report-machine",
      locale: "en",
      appVersion: "0.13.0",
      platform: "windows",
      country: "US",
      grantId: null,
    });

    await reportCatalogResult(env.db, env.config, {
      productId: "animate",
      fingerprint: "report-machine",
      grantId: claim.grant_id,
      result: "imported",
      appVersion: "0.13.0",
    });
    const grants = await env.db
      .select()
      .from(catalogGrants)
      .where(eq(catalogGrants.grantId, claim.grant_id))
      .all();
    expect(grants[0]?.status).toBe("imported");
    expect(grants[0]?.importedAt).toBeTruthy();

    const foreign = await catchActivationError(() =>
      reportCatalogResult(env.db, env.config, {
        productId: "animate",
        fingerprint: "some-other-machine",
        grantId: claim.grant_id,
        result: "imported",
        appVersion: null,
      })
    );
    expect(foreign.error).toBe("GRANT_NOT_FOUND");

    const invalid = await catchActivationError(() =>
      reportCatalogResult(env.db, env.config, {
        productId: "animate",
        fingerprint: "report-machine",
        grantId: claim.grant_id,
        result: "hacked",
        appVersion: null,
      })
    );
    expect(invalid.error).toBe("INVALID_REQUEST");
  });
});

describe("catalog status flag (trial bootstrap)", () => {
  it("is disabled when the flag is off or the country is excluded; counts quota when enabled", async () => {
    const env = await createTestEnv();
    enableCatalog(env);
    await seedModel(env);
    await startTrialFor(env, "status-machine");

    env.config.catalogEnabled = false;
    expect(
      await catalogStatusFor(env.db, env.config, {
        productId: "animate",
        fingerprint: "status-machine",
        country: "US",
      })
    ).toEqual({ enabled: false, remaining: 0, max: 3 });

    env.config.catalogEnabled = true;
    expect(
      await catalogStatusFor(env.db, env.config, {
        productId: "animate",
        fingerprint: "status-machine",
        country: "CN",
      })
    ).toEqual({ enabled: false, remaining: 0, max: 3 });

    expect(
      await catalogStatusFor(env.db, env.config, {
        productId: "animate",
        fingerprint: "status-machine",
        country: "US",
      })
    ).toEqual({ enabled: true, remaining: 3, max: 3 });

    const hashes = await catalogFingerprintHashCandidates(env.config, "animate", "status-machine");
    await env.db.insert(catalogGrants).values({
      grantId: "cg_seed",
      fingerprintHash: hashes[0] ?? "",
      modelId: "mdl_test",
      locale: "en",
      country: "US",
      status: "claimed",
    });
    expect(
      await catalogStatusFor(env.db, env.config, {
        productId: "animate",
        fingerprint: "status-machine",
        country: "US",
      })
    ).toEqual({ enabled: true, remaining: 2, max: 3 });
  });
});

describe("catalog status with an empty catalog", () => {
  it("hides the flag while zero models are enabled, shows once one is", async () => {
    const env = await createTestEnv();
    enableCatalog(env);
    const params = { productId: "animate", fingerprint: "empty-catalog-machine", country: "US" as string | null };
    await startTrialFor(env, params.fingerprint);

    expect(await catalogStatusFor(env.db, env.config, params)).toEqual({
      enabled: false,
      remaining: 0,
      max: 3,
    });

    await seedModel(env);
    expect(await catalogStatusFor(env.db, env.config, params)).toEqual({
      enabled: true,
      remaining: 3,
      max: 3,
    });

    await env.db.update(catalogModels).set({ enabled: false }).where(eq(catalogModels.id, "mdl_test"));
    expect(await catalogStatusFor(env.db, env.config, params)).toEqual({
      enabled: false,
      remaining: 0,
      max: 3,
    });
  });
});
