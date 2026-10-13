import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestEnv, type TestEnv } from "./helpers/setup";
import { createV1Router } from "../src/routes/v1";
import { createAdminApiRouter } from "../src/routes/admin_api";
import { catalogFingerprintHashCandidates } from "../src/services/catalog";
import { ActivationError } from "../src/services/activation";
import { startTrial } from "../src/services/trial";
import {
  createLlmTrialKey,
  createLlmTrialPool,
  issueTrialLlmProfile,
  listLlmTrialKeys,
  listLlmTrialPools,
  llmTrialFingerprintHashCandidates,
  poolAllowsCountry,
  revokeLlmTrialKey,
  setLlmTrialPoolStatus,
} from "../src/services/llm_trial";
import { llmTrialGrants, llmTrialKeys, llmTrialPools } from "../src/db/schema";

// ─── helpers ──────────────────────────────────────────────────────────────

async function catchActivationError(fn: () => Promise<unknown>): Promise<ActivationError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ActivationError) return err;
    throw err;
  }
  throw new Error("expected ActivationError");
}

function future(): number {
  return Math.floor(Date.now() / 1000) + 86_400;
}

function past(): number {
  return Math.floor(Date.now() / 1000) - 60;
}

async function setup(overrides: Partial<{ enabled: boolean }> = {}): Promise<TestEnv> {
  const env = await createTestEnv();
  env.config.trialLlmEnabled = overrides.enabled ?? true;
  return env;
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

/** A machine with an active trial, ready to be issued a profile. */
async function trialMachine(env: TestEnv, fingerprint: string): Promise<string> {
  await startTrialFor(env, fingerprint);
  return fingerprint;
}

async function issue(
  env: TestEnv,
  fingerprint: string,
  extra: Partial<{ platform: string | null; country: string | null }> = {}
) {
  return issueTrialLlmProfile(env.db, env.config, {
    productId: "animate",
    fingerprint,
    appVersion: "0.13.0",
    platform: extra.platform === undefined ? "windows" : extra.platform,
    country: extra.country ?? null,
  });
}

async function seedPool(
  env: TestEnv,
  opts: Partial<{
    name: string;
    keyCount: number;
    baseUrl: string;
    model: string;
    validUntil: number;
    platform: string | null;
    excludedCountries: string[] | null;
  }> = {}
) {
  const pool = await createLlmTrialPool(env.db, {
    name: opts.name ?? "test pool",
    productId: "animate",
    baseUrl: opts.baseUrl ?? "https://gw.example/v1",
    model: opts.model ?? "test-model",
    validUntil: opts.validUntil ?? future(),
    platform: opts.platform ?? null,
    excludedCountries: opts.excludedCountries ?? null,
  });
  const keys = [];
  const count = opts.keyCount ?? 1;
  for (let i = 0; i < count; i++) {
    keys.push(
      await createLlmTrialKey(env.db, { poolId: pool.id, apiKey: `sk-${pool.id.slice(-4)}-${i}` })
    );
  }
  return { pool, keys };
}

/** created_at only has second resolution, so ordering tests pin it explicitly. */
async function setKeyCreatedAt(env: TestEnv, keyId: string, createdAt: string) {
  await env.db
    .update(llmTrialKeys)
    .set({ createdAt })
    .where(eq(llmTrialKeys.id, keyId));
}

async function keyRefs(env: TestEnv, keyId: string): Promise<number> {
  const rows = await env.db
    .select({ grantId: llmTrialGrants.grantId })
    .from(llmTrialGrants)
    .where(and(eq(llmTrialGrants.keyId, keyId), eq(llmTrialGrants.status, "active")))
    .all();
  return rows.length;
}

// ─── pure helpers ─────────────────────────────────────────────────────────

describe("llm trial pure helpers", () => {
  it("gates pools by country, allowing missing geo data through", () => {
    expect(poolAllowsCountry({ excludedCountries: '["CN"]' }, "CN")).toBe(false);
    expect(poolAllowsCountry({ excludedCountries: '["CN"]' }, "cn")).toBe(false);
    expect(poolAllowsCountry({ excludedCountries: '["CN"]' }, "US")).toBe(true);
    expect(poolAllowsCountry({ excludedCountries: '["CN"]' }, null)).toBe(true);
    expect(poolAllowsCountry({ excludedCountries: null }, "CN")).toBe(true);
    expect(poolAllowsCountry({ excludedCountries: "not-json" }, "CN")).toBe(true);
  });

  it("derives the same candidate hashes as the catalog ledger", async () => {
    const env = await setup();
    const mine = await llmTrialFingerprintHashCandidates(env.config, "animate", "machine-abc");
    // The three services must agree, or a machine's existing grant stops being
    // found and it gets handed a second key from the pool.
    const catalog = await catalogFingerprintHashCandidates(
      env.config,
      "animate",
      "machine-abc"
    );

    expect([...mine].sort()).toEqual([...catalog].sort());
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(new Set(mine).size).toBe(mine.length);
    expect(mine.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });
});

// ─── gating ───────────────────────────────────────────────────────────────

describe("llm trial gating", () => {
  it("is inert until TRIAL_LLM_ENABLED is on", async () => {
    const env = await setup({ enabled: false });
    await seedPool(env, { keyCount: 1 });
    await trialMachine(env, "m-disabled");

    const err = await catchActivationError(() => issue(env, "m-disabled"));
    expect(err.error).toBe("TRIAL_LLM_DISABLED");
    expect(err.statusCode).toBe(403);
  });

  it("requires an active trial grant", async () => {
    const env = await setup();
    await seedPool(env, { keyCount: 1 });

    const err = await catchActivationError(() => issue(env, "m-no-trial"));
    expect(err.error).toBe("TRIAL_REQUIRED");
    expect(err.statusCode).toBe(403);
  });

  it("rejects an empty fingerprint", async () => {
    const env = await setup();
    const err = await catchActivationError(() => issue(env, "  "));
    expect(err.error).toBe("INVALID_REQUEST");
  });

  it("reports LLM_POOL_EMPTY when no pool has a usable key", async () => {
    const env = await setup();
    await trialMachine(env, "m-empty");

    const err = await catchActivationError(() => issue(env, "m-empty"));
    expect(err.error).toBe("LLM_POOL_EMPTY");
    expect(err.statusCode).toBe(503);
  });
});

// ─── issuance ─────────────────────────────────────────────────────────────

describe("llm trial issuance", () => {
  it("returns the pool triple with the key decrypted and the pool expiry", async () => {
    const env = await setup();
    const { pool, keys } = await seedPool(env, {
      keyCount: 1,
      baseUrl: "https://gw.example/v1",
      model: "cheap-model",
    });
    await trialMachine(env, "m-happy");

    const profile = await issue(env, "m-happy");

    expect(profile.llm.base_url).toBe("https://gw.example/v1");
    expect(profile.llm.model).toBe("cheap-model");
    expect(profile.llm.api_key).toBe(`sk-${pool.id.slice(-4)}-0`);
    expect(profile.valid_until).toBe(
      Math.floor(new Date(`${pool.validUntil.replace(" ", "T")}Z`).getTime() / 1000)
    );
    expect(profile.quota).toEqual({ max_requests: 60 });
    expect(profile.grant_id).toMatch(/^lg_[0-9a-f]{32}$/);
    expect(await keyRefs(env, keys[0].id)).toBe(1);
  });

  it("never stores the plaintext key", async () => {
    const env = await setup();
    const { keys } = await seedPool(env, { keyCount: 1, name: "plain" });
    expect(keys[0].apiKeyEnc).not.toContain("sk-");
    expect(keys[0].apiKeyEnc.length).toBeGreaterThan(40);
  });

  it("keeps returning the same key across restarts (idempotent)", async () => {
    const env = await setup();
    const { keys } = await seedPool(env, { keyCount: 3 });
    await trialMachine(env, "m-restart");

    const first = await issue(env, "m-restart");
    const second = await issue(env, "m-restart");
    const third = await issue(env, "m-restart");

    expect(second.grant_id).toBe(first.grant_id);
    expect(second.llm.api_key).toBe(first.llm.api_key);
    expect(third.grant_id).toBe(first.grant_id);

    // The pool must not be drained by re-requests: exactly one key is bound and
    // the other two are still untouched. (Which one is bound depends on the
    // created_at tie-break, so assert on the shape, not the index.)
    const refs = await Promise.all(keys.map((key) => keyRefs(env, key.id)));
    expect(refs.filter((count) => count === 1)).toHaveLength(1);
    expect(refs.filter((count) => count === 0)).toHaveLength(2);
  });

  it("spreads machines over unused keys before reusing any", async () => {
    const env = await setup();
    const { keys } = await seedPool(env, { keyCount: 3 });

    const issued = [];
    for (const fp of ["m-1", "m-2", "m-3"]) {
      await trialMachine(env, fp);
      issued.push(await issue(env, fp));
    }

    expect(new Set(issued.map((p) => p.llm.api_key)).size).toBe(3);
    for (const key of keys) {
      expect(await keyRefs(env, key.id)).toBe(1);
    }
  });

  it("prefers a never-referenced key over a newer one that is already in use", async () => {
    const env = await setup();
    const older = await seedPool(env, { keyCount: 1, name: "older" });
    const newer = await seedPool(env, { keyCount: 1, name: "newer" });
    await setKeyCreatedAt(env, older.keys[0].id, "2026-01-01 00:00:00");
    await setKeyCreatedAt(env, newer.keys[0].id, "2026-06-01 00:00:00");

    await trialMachine(env, "m-a");
    const first = await issue(env, "m-a");
    // Newest first among the unused ones.
    expect(first.llm.api_key).toBe(`sk-${newer.pool.id.slice(-4)}-0`);

    await trialMachine(env, "m-b");
    const second = await issue(env, "m-b");
    // Unused beats newer: the older pool's untouched key wins over the newer
    // pool's already-referenced one.
    expect(second.llm.api_key).toBe(`sk-${older.pool.id.slice(-4)}-0`);
  });

  it("orders two unused keys newest-first deterministically", async () => {
    const env = await setup();
    const { keys } = await seedPool(env, { keyCount: 2 });
    await setKeyCreatedAt(env, keys[0].id, "2026-01-01 00:00:00");
    await setKeyCreatedAt(env, keys[1].id, "2026-06-01 00:00:00");

    await trialMachine(env, "m-newest");
    const profile = await issue(env, "m-newest");

    const bound = await env.db
      .select({ keyId: llmTrialGrants.keyId })
      .from(llmTrialGrants)
      .where(eq(llmTrialGrants.grantId, profile.grant_id))
      .get();
    expect(bound?.keyId).toBe(keys[1].id);
  });

  it("refuses to reuse a referenced key when TRIAL_LLM_REUSE_REFERENCED_KEYS is off", async () => {
    const env = await setup();
    env.config.trialLlmReuseReferencedKeys = false;
    await seedPool(env, { keyCount: 1 });

    await trialMachine(env, "m-only");
    await issue(env, "m-only");

    await trialMachine(env, "m-next");
    const err = await catchActivationError(() => issue(env, "m-next"));
    expect(err.error).toBe("LLM_POOL_EMPTY");
  });

  it("skips pools filtered out by platform or country", async () => {
    const env = await setup();
    await seedPool(env, { keyCount: 1, platform: "macos" });
    await trialMachine(env, "m-windows");

    const platformErr = await catchActivationError(() => issue(env, "m-windows"));
    expect(platformErr.error).toBe("LLM_POOL_EMPTY");

    // A windows pool that excludes CN still refuses a CN machine.
    await seedPool(env, { keyCount: 1, platform: "windows", excludedCountries: ["CN"] });
    const countryErr = await catchActivationError(() =>
      issue(env, "m-windows", { country: "CN" })
    );
    expect(countryErr.error).toBe("LLM_POOL_EMPTY");

    const ok = await issue(env, "m-windows", { country: "US" });
    expect(ok.llm.api_key).toContain("sk-");
  });

  it("ignores expired pools", async () => {
    const env = await setup();
    await seedPool(env, { keyCount: 1, validUntil: past() });
    await trialMachine(env, "m-old-pool");

    const err = await catchActivationError(() => issue(env, "m-old-pool"));
    expect(err.error).toBe("LLM_POOL_EMPTY");
  });
});

// ─── revocation & pool lifecycle ───────────────────────────────────────────

describe("llm trial revocation", () => {
  it("answers LLM_KEY_REVOKED for the revoked key's machine and leaves others alone", async () => {
    const env = await setup();
    await seedPool(env, { keyCount: 2 });

    await trialMachine(env, "m-revoked");
    const revokedProfile = await issue(env, "m-revoked");
    await trialMachine(env, "m-untouched");
    const otherProfile = await issue(env, "m-untouched");
    expect(otherProfile.llm.api_key).not.toBe(revokedProfile.llm.api_key);

    const bound = await env.db
      .select({ keyId: llmTrialGrants.keyId })
      .from(llmTrialGrants)
      .where(eq(llmTrialGrants.grantId, revokedProfile.grant_id))
      .get();
    expect(bound).toBeTruthy();
    expect(bound!.keyId).not.toBe(
      (
        await env.db
          .select({ keyId: llmTrialGrants.keyId })
          .from(llmTrialGrants)
          .where(eq(llmTrialGrants.grantId, otherProfile.grant_id))
          .get()
      )!.keyId
    );

    const { revokedGrants } = await revokeLlmTrialKey(env.db, bound!.keyId);
    expect(revokedGrants).toBe(1);

    const err = await catchActivationError(() => issue(env, "m-revoked"));
    expect(err.error).toBe("LLM_KEY_REVOKED");
    expect(err.statusCode).toBe(409);

    // The other machine keeps working, and a brand-new machine still gets served
    // by the remaining active key.
    const stillOk = await issue(env, "m-untouched");
    expect(stillOk.grant_id).toBe(otherProfile.grant_id);

    await trialMachine(env, "m-fresh");
    const fresh = await issue(env, "m-fresh");
    expect(fresh.llm.api_key).toContain("sk-");
  });

  it("does not re-issue a key to a machine whose key was revoked", async () => {
    const env = await setup();
    const { keys } = await seedPool(env, { keyCount: 2 });
    await trialMachine(env, "m-no-reissue");
    const profile = await issue(env, "m-no-reissue");

    const bound = await env.db
      .select({ keyId: llmTrialGrants.keyId })
      .from(llmTrialGrants)
      .where(eq(llmTrialGrants.grantId, profile.grant_id))
      .get();
    await revokeLlmTrialKey(env.db, bound!.keyId);

    // Repeated attempts stay rejected — no silent key churn.
    for (let i = 0; i < 3; i++) {
      const err = await catchActivationError(() => issue(env, "m-no-reissue"));
      expect(err.error).toBe("LLM_KEY_REVOKED");
    }
    expect(await keyRefs(env, keys[1].id)).toBe(0);
  });

  it("disabling a pool stops new issuance but keeps issued machines working", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 1 });

    await trialMachine(env, "m-inside");
    const first = await issue(env, "m-inside");

    await setLlmTrialPoolStatus(env.db, pool.id, "disabled");

    const again = await issue(env, "m-inside");
    expect(again.grant_id).toBe(first.grant_id);
    expect(again.llm.api_key).toBe(first.llm.api_key);

    await trialMachine(env, "m-outside");
    const err = await catchActivationError(() => issue(env, "m-outside"));
    expect(err.error).toBe("LLM_POOL_EMPTY");
  });

  it("expires an issued profile when its pool's expiry passes", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 1 });
    await trialMachine(env, "m-expiring");
    await issue(env, "m-expiring");

    await env.db
      .update(llmTrialPools)
      .set({ validUntil: new Date((past() - 60) * 1000).toISOString().replace("T", " ").substring(0, 19) })
      .where(eq(llmTrialPools.id, pool.id));

    const err = await catchActivationError(() => issue(env, "m-expiring"));
    expect(err.error).toBe("LLM_KEY_EXPIRED");
    expect(err.statusCode).toBe(409);
  });

  it("revives an expired machine when the pool expiry is extended", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 1 });
    await trialMachine(env, "m-revive");
    const first = await issue(env, "m-revive");

    // Expiry is read live from the pool, so extending it revives the machine
    // instead of stranding it behind a stale grant snapshot.
    await env.db
      .update(llmTrialPools)
      .set({ validUntil: "2020-01-01 00:00:00" })
      .where(eq(llmTrialPools.id, pool.id));
    await catchActivationError(() => issue(env, "m-revive"));

    await env.db
      .update(llmTrialPools)
      .set({
        validUntil: new Date((future() + 60) * 1000)
          .toISOString()
          .replace("T", " ")
          .substring(0, 19),
      })
      .where(eq(llmTrialPools.id, pool.id));

    const revived = await issue(env, "m-revive");
    expect(revived.grant_id).toBe(first.grant_id);
    expect(revived.llm.api_key).toBe(first.llm.api_key);

    // The revived grant must count as a live reference again, otherwise the pool
    // would hand the same key to a second machine.
    const row = await env.db
      .select({ status: llmTrialGrants.status })
      .from(llmTrialGrants)
      .where(eq(llmTrialGrants.grantId, first.grant_id))
      .get();
    expect(row?.status).toBe("active");
  });
});

// ─── admin summaries ───────────────────────────────────────────────────────

describe("llm trial admin views", () => {
  it("reports pool capacity and the unused-key signal", async () => {
    const env = await setup();
    const { pool, keys } = await seedPool(env, { keyCount: 3 });

    await trialMachine(env, "m-admin");
    await issue(env, "m-admin");

    const pools = await listLlmTrialPools(env.db);
    const summary = pools.find((p) => p.id === pool.id)!;
    expect(summary.keyCount).toBe(3);
    expect(summary.activeKeyCount).toBe(3);
    expect(summary.unusedKeyCount).toBe(2);
    expect(summary.referencedMachines).toBe(1);
    expect(summary.expired).toBe(false);

    const keySummaries = await listLlmTrialKeys(env.db, { poolId: pool.id });
    expect(keySummaries).toHaveLength(3);
    expect(keySummaries.reduce((sum, k) => sum + k.referencedMachines, 0)).toBe(1);
    expect(keySummaries.map((k) => k.id).sort()).toEqual(keys.map((k) => k.id).sort());

    await revokeLlmTrialKey(env.db, keys[0].id);
    const after = (await listLlmTrialKeys(env.db, { poolId: pool.id })).find(
      (k) => k.id === keys[0].id
    )!;
    expect(after.status).toBe("revoked");
    expect(after.revokedAt).toBeTruthy();
  });
});

// ─── admin routes ─────────────────────────────────────────────────────────

describe("llm trial admin routes", () => {
  it("seeds a pool and key, reports blast radius, and revokes without echoing the key", async () => {
    const env = await setup();
    const router = createAdminApiRouter(env.db, env.config, env.registry);

    const poolRes = await router.request("/llm-trial/pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ops pool",
        base_url: "https://gw.example/v1",
        model: "ops-model",
        valid_until: future(),
      }),
    });
    expect(poolRes.status).toBe(200);
    const { id: poolId } = (await poolRes.json()) as { id: string };
    expect(poolId).toMatch(/^lp_/);

    const keyRes = await router.request("/llm-trial/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool_id: poolId, api_key: "sk-ops-secret-1" }),
    });
    expect(keyRes.status).toBe(200);
    const keyBody = (await keyRes.json()) as { id: string };
    expect(JSON.stringify(keyBody)).not.toContain("sk-ops-secret-1");

    await trialMachine(env, "m-admin-route");
    const profile = await issue(env, "m-admin-route");
    expect(profile.llm.api_key).toBe("sk-ops-secret-1");

    const listRes = await router.request(`/llm-trial/keys?pool_id=${poolId}`);
    const list = (await listRes.json()) as { items: Array<{ referencedMachines: number }> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0].referencedMachines).toBe(1);

    const poolsRes = await router.request("/llm-trial/pools");
    const pools = (await poolsRes.json()) as {
      items: Array<{ unusedKeyCount: number; referencedMachines: number }>;
    };
    expect(pools.items[0].unusedKeyCount).toBe(0);
    expect(pools.items[0].referencedMachines).toBe(1);

    const revokeRes = await router.request(`/llm-trial/keys/${keyBody.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { revoked_grants: number };
    expect(revokeBody.revoked_grants).toBe(1);

    const err = await catchActivationError(() => issue(env, "m-admin-route"));
    expect(err.error).toBe("LLM_KEY_REVOKED");
  });

  it("rejects an invalid pool status", async () => {
    const env = await setup();
    const router = createAdminApiRouter(env.db, env.config, env.registry);
    const { pool } = await seedPool(env, { keyCount: 1 });

    const res = await router.request(`/llm-trial/pools/${pool.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── route wiring ─────────────────────────────────────────────────────────

describe("llm trial route", () => {
  it("serves the profile over POST /llm/trial-profile", async () => {
    const env = await setup();
    await seedPool(env, { keyCount: 1, model: "route-model" });
    await startTrialFor(env, "m-route");
    const router = createV1Router(env.db, env.config, env.registry);

    const response = await router.request("/llm/trial-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product_id: "animate",
        fingerprint: "m-route",
        app_version: "0.13.0",
        platform: "windows",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.llm).toEqual({
      base_url: "https://gw.example/v1",
      model: "route-model",
      api_key: expect.stringContaining("sk-"),
    });
    expect(typeof body.valid_until).toBe("number");
    expect(body.quota).toEqual({ max_requests: 60 });
  });

  it("returns 403 TRIAL_LLM_DISABLED while the feature flag is off", async () => {
    const env = await setup({ enabled: false });
    await seedPool(env, { keyCount: 1 });
    await startTrialFor(env, "m-route-off");
    const router = createV1Router(env.db, env.config, env.registry);

    const response = await router.request("/llm/trial-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: "animate", fingerprint: "m-route-off" }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("TRIAL_LLM_DISABLED");
  });
});
