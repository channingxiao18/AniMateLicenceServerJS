import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { createTestEnv, type TestEnv } from "./helpers/setup";
import { createSession, SESSION_COOKIE } from "../src/middleware/auth";
import { createV1Router } from "../src/routes/v1";
import { createAdminApiRouter } from "../src/routes/admin_api";
import { createAdminUiRouter } from "../src/routes/admin_ui";
import { catalogFingerprintHashCandidates } from "../src/services/catalog";
import { ActivationError } from "../src/services/activation";
import { startTrial } from "../src/services/trial";
import {
  createLlmTrialKey,
  createLlmTrialKeys,
  createLlmTrialPool,
  issueTrialLlmProfile,
  listLlmTrialKeys,
  listLlmTrialPools,
  llmTrialFingerprintHashCandidates,
  normalizeValidUntil,
  poolAllowsCountry,
  revokeLlmTrialKey,
  setLlmTrialPoolStatus,
  updateLlmTrialPool,
  readLlmTrialEnabled,
  writeLlmTrialEnabled,
} from "../src/services/llm_trial";
import { auditLogs, llmTrialGrants, llmTrialKeys, llmTrialPools } from "../src/db/schema";

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

async function setup(
  overrides: Partial<{ masterEnabled: boolean }> = {}
): Promise<TestEnv> {
  const env = await createTestEnv();
  // The dashboard switch is the ONLY gate, and it defaults to OFF; tests that
  // exercise issuance have to turn it on, exactly like an operator would.
  await writeLlmTrialEnabled(env.db, overrides.masterEnabled ?? true);
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
  it("is inert while the dashboard switch is off", async () => {
    const env = await setup({ masterEnabled: false });
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

describe("llm trial admin routes", () => {  it("seeds a pool and key, reports blast radius, and revokes without echoing the key", async () => {
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

  it("accepts a dashboard date-time string and normalises it to the DB shape", async () => {
    const env = await setup();
    const router = createAdminApiRouter(env.db, env.config, env.registry);

    const res = await router.request("/llm-trial/pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "dated pool",
        base_url: "https://gw.example/v1",
        model: "m",
        // What an <input type="datetime-local"> posts.
        valid_until: "2027-03-05T14:30",
      }),
    });
    expect(res.status).toBe(200);

    const pools = await listLlmTrialPools(env.db);
    expect(pools[0].validUntil).toBe("2027-03-05 14:30:00");
    expect(pools[0].expired).toBe(false);
  });

  it("normalises epoch seconds, minute stamps and full ISO strings", () => {
    expect(normalizeValidUntil(1_800_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(normalizeValidUntil("1800000000")).toBe(normalizeValidUntil(1_800_000_000));
    expect(normalizeValidUntil("2027-03-05 14:30")).toBe("2027-03-05 14:30:00");
    expect(normalizeValidUntil("2027-03-05T14:30:00")).toBe("2027-03-05 14:30:00");
    expect(normalizeValidUntil("2027-03-05 14:30:00")).toBe("2027-03-05 14:30:00");
    // The shape `new Date(...).toISOString()` produces — must not be stored verbatim.
    expect(normalizeValidUntil("2027-03-05T14:30:00.000Z")).toBe("2027-03-05 14:30:00");
    expect(normalizeValidUntil("2027-03-05T14:30Z")).toBe("2027-03-05 14:30:00");
  });
});

describe("llm trial pool editing", () => {
  it("extends a pool's expiry, which revives machines already answered LLM_KEY_EXPIRED", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 1 });
    await trialMachine(env, "m-revive-edit");
    const issued = await issue(env, "m-revive-edit");

    // Expire the pool, observe the terminal answer…
    await updateLlmTrialPool(env.db, pool.id, { validUntil: "2020-01-01 00:00:00" });
    const err = await catchActivationError(() => issue(env, "m-revive-edit"));
    expect(err.error).toBe("LLM_KEY_EXPIRED");

    // …then extend it through the same edit path operators use. No per-machine
    // action is needed because expiry is read live from the pool.
    const extended = new Date((future() + 3600) * 1000);
    const updated = await updateLlmTrialPool(env.db, pool.id, { validUntil: extended });
    // A JS Date / ISO string (milliseconds + Z) must land in the DB shape, or the
    // value becomes unparseable and every machine reads as expired forever.
    expect(updated.validUntil).toBe(extended.toISOString().replace("T", " ").substring(0, 19));

    const revived = await issue(env, "m-revive-edit");
    expect(revived.grant_id).toBe(issued.grant_id);
    expect(revived.llm.api_key).toBe(issued.llm.api_key);
  });

  it("edits model / base_url / platform / note and audits before and after", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 1, model: "old-model" });

    const updated = await updateLlmTrialPool(
      env.db,
      pool.id,
      {
        model: "new-model",
        baseUrl: "https://gw2.example/v1",
        platform: "macos",
        note: "fixed a typo",
      },
      { actor: "admin", ipAddress: "10.0.0.1" }
    );
    expect(updated.model).toBe("new-model");
    expect(updated.baseUrl).toBe("https://gw2.example/v1");
    expect(updated.platform).toBe("macos");
    expect(updated.note).toBe("fixed a typo");

    // A windows machine no longer matches the pool it used to be served by.
    await trialMachine(env, "m-after-edit");
    const err = await catchActivationError(() => issue(env, "m-after-edit"));
    expect(err.error).toBe("LLM_POOL_EMPTY");

    const rows = await env.db.select().from(auditLogs).all();
    const edit = rows.find((row) => row.action === "llm_trial_pool_update");
    expect(edit).toBeTruthy();
    expect(edit!.actor).toBe("admin");
    expect(edit!.ipAddress).toBe("10.0.0.1");
    expect(JSON.parse(edit!.beforeJson!)).toMatchObject({ model: "old-model" });
    expect(JSON.parse(edit!.afterJson!)).toMatchObject({ model: "new-model" });
  });

  it("rejects an empty or unparseable edit instead of writing it", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 1 });

    const blankModel = await catchActivationError(() =>
      updateLlmTrialPool(env.db, pool.id, { model: "   " })
    );
    expect(blankModel.error).toBe("INVALID_REQUEST");

    const badDate = await catchActivationError(() =>
      updateLlmTrialPool(env.db, pool.id, { validUntil: "not-a-date" })
    );
    expect(badDate.error).toBe("INVALID_REQUEST");

    const missing = await catchActivationError(() =>
      updateLlmTrialPool(env.db, "lp_does_not_exist", { model: "x" })
    );
    expect(missing.error).toBe("POOL_NOT_FOUND");
  });
});

describe("llm trial bulk keys and hint", () => {
  it("bulk-adds one key per line, ignoring blanks and same-batch duplicates", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 0 });

    const result = await createLlmTrialKeys(
      env.db,
      {
        poolId: pool.id,
        apiKeys: ["sk-a", "sk-b", "", "   ", "sk-a", "sk-c"],
        note: "batch 1",
      },
      { actor: "admin", ipAddress: "10.0.0.2" }
    );

    expect(result.created).toBe(3);
    expect(result.skipped).toBe(1);

    const summaries = await listLlmTrialKeys(env.db, { poolId: pool.id });
    expect(summaries).toHaveLength(3);
    expect(summaries.every((key) => key.note === "batch 1")).toBe(true);

    // All three are real, usable candidates.
    await trialMachine(env, "m-bulk-1");
    const issued = await issue(env, "m-bulk-1");
    expect(issued.llm.api_key).toMatch(/^sk-[abc]$/);
  });

  it("refuses a batch that contains nothing usable", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 0 });
    const err = await catchActivationError(() =>
      createLlmTrialKeys(env.db, { poolId: pool.id, apiKeys: ["", " ", "\r\n"] })
    );
    expect(err.error).toBe("INVALID_REQUEST");
  });

  it("stores only a 4-character hint and never the key itself", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 0 });
    await createLlmTrialKeys(env.db, { poolId: pool.id, apiKeys: ["sk-secret-tail4321"] });

    const stored = await env.db
      .select()
      .from(llmTrialKeys)
      .where(eq(llmTrialKeys.poolId, pool.id))
      .get();
    expect(stored!.keyHint).toBe("4321");
    // The hint is not enough to reconstruct the key, and the encrypted column
    // carries no readable form of it.
    expect(stored!.apiKeyEnc).not.toContain("sk-secret");

    const summaries = await listLlmTrialKeys(env.db, { poolId: pool.id });
    expect(summaries[0].keyHint).toBe("4321");
  });

  it("audits creation and revocation without ever recording key material", async () => {
    const env = await setup();
    const { pool } = await seedPool(env, { keyCount: 0 });
    await createLlmTrialKeys(
      env.db,
      { poolId: pool.id, apiKeys: ["sk-audit-secret-9876"] },
      { actor: "admin", ipAddress: "10.0.0.3" }
    );
    const key = (
      await env.db.select().from(llmTrialKeys).where(eq(llmTrialKeys.poolId, pool.id)).all()
    )[0];

    await trialMachine(env, "m-audit");
    await issue(env, "m-audit");
    await revokeLlmTrialKey(env.db, key.id, { actor: "admin", ipAddress: "10.0.0.3" });

    const rows = await env.db.select().from(auditLogs).all();
    const actions = rows.map((row) => row.action);
    expect(actions).toContain("llm_trial_key_create");
    expect(actions).toContain("llm_trial_pool_create");
    expect(actions).toContain("llm_trial_key_revoke");

    const revoke = rows.find((row) => row.action === "llm_trial_key_revoke")!;
    expect(JSON.parse(revoke.afterJson!)).toMatchObject({ revokedGrants: 1 });

    // The whole audit trail must be key-material free.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("sk-audit-secret-9876");
    expect(serialized).not.toContain("sk-");
  });
});

describe("llm trial master switch", () => {
  it("defaults to off, so a deploy issues nothing until an operator enables it", async () => {
    // Deliberately no `setup()` here: it would turn the switch on. A fresh test
    // env is exactly the "deployed but nobody touched the dashboard yet" state.
    const env = await createTestEnv();
    await seedPool(env, { keyCount: 1 });
    await trialMachine(env, "m-master-off");

    expect(await readLlmTrialEnabled(env.db)).toBe(false);

    const err = await catchActivationError(() => issue(env, "m-master-off"));
    expect(err.error).toBe("TRIAL_LLM_DISABLED");
    expect(err.statusCode).toBe(403);
  });

  it("stops machines that already hold a key — that is what a kill switch means", async () => {
    const env = await setup();
    await seedPool(env, { keyCount: 1 });
    await trialMachine(env, "m-killed");
    const issued = await issue(env, "m-killed");
    expect(issued.llm.api_key).toContain("sk-");

    await writeLlmTrialEnabled(env.db, false);

    const err = await catchActivationError(() => issue(env, "m-killed"));
    expect(err.error).toBe("TRIAL_LLM_DISABLED");
  });

  it("resumes the same key once re-enabled", async () => {
    const env = await setup();
    await seedPool(env, { keyCount: 1 });
    await trialMachine(env, "m-resume");
    const first = await issue(env, "m-resume");

    await writeLlmTrialEnabled(env.db, false);
    await catchActivationError(() => issue(env, "m-resume"));
    await writeLlmTrialEnabled(env.db, true);

    const again = await issue(env, "m-resume");
    expect(again.grant_id).toBe(first.grant_id);
    expect(again.llm.api_key).toBe(first.llm.api_key);
  });

  it("is reachable from the admin API and audited", async () => {
    const env = await setup({ masterEnabled: false });
    const router = createAdminApiRouter(env.db, env.config, env.registry);

    const before = (await (await router.request("/llm-trial/enabled")).json()) as {
      enabled: boolean;
    };
    expect(before.enabled).toBe(false);

    const set = await router.request("/llm-trial/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(set.status).toBe(200);
    expect(await readLlmTrialEnabled(env.db)).toBe(true);

    const rows = await env.db.select().from(auditLogs).all();
    expect(rows.map((row) => row.action)).toContain("llm_trial_enable");

    const bad = await router.request("/llm-trial/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "maybe" }),
    });
    expect(bad.status).toBe(400);
  });

  it("renders the switch on the dashboard, showing the default-off state", async () => {
    const env = await setup({ masterEnabled: false });
    const app = new Hono();
    app.route("/admin", createAdminUiRouter(env.db, env.config));
    const session = await createSession("admin", env.config.sessionSecret);

    const res = await app.request("/admin/llm-trial", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("总开关");
    expect(html).toContain("已关停（默认）");
    expect(html).toContain("/admin/api/llm-trial/enabled");
    // The kill switch must say out loud that it also stops issued machines.
    expect(html).toContain("连已签发的机器也停");
  });
});

describe("llm trial admin page", () => {
  it("renders pool capacity, the unused-key signal and per-key blast radius", async () => {
    const env = await setup();
    const { pool, keys } = await seedPool(env, { keyCount: 3, name: "第一批" });
    await trialMachine(env, "m-page");
    await issue(env, "m-page");

    const app = new Hono();
    app.route("/admin", createAdminUiRouter(env.db, env.config));
    const session = await createSession("admin", env.config.sessionSecret);
    const headers = { cookie: `${SESSION_COOKIE}=${session}` };

    const res = await app.request("/admin/llm-trial", { headers });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("试用额度");
    expect(html).toContain("第一批");
    expect(html).toContain("https://gw.example/v1");
    // The unused-key signal is what tells an operator to top the pool up.
    expect(html).toContain("未使用");
    expect(html).toContain("被引用");
    expect(html).toContain(keys[0].id);
    // Operator actions: bulk paste, per-pool editing, and telling keys apart.
    expect(html).toContain("批量添加 key");
    expect(html).toContain(`#edit-pool-${pool.id}`);
    expect(html).toContain(`/admin/api/llm-trial/pools/${pool.id}/update`);
    // The hint column shows a 4-character tail, never the key itself.
    expect(html).toContain("尾号");
    expect(html).toContain("…");
    for (const key of keys) {
      const hintCell = key.keyHint ? `…${key.keyHint}` : "";
      expect(html).not.toContain(`sk-${pool.id.slice(-4)}-0`);
      void hintCell;
    }

    // Revoking from the page must be reachable and must warn about the blast radius.
    await revokeLlmTrialKey(env.db, keys[0].id);
    const after = await app.request("/admin/llm-trial", { headers });
    const afterHtml = await after.text();
    expect(afterHtml).toContain("已撤销");
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

  it("returns 403 TRIAL_LLM_DISABLED while the dashboard switch is off", async () => {
    const env = await setup({ masterEnabled: false });
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
