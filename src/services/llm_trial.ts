/**
 * Trial LLM key issuance (docs/plans/trial-llm-key-plan.md §3).
 *
 * Flow: the client asks for a trial profile when it opens the chat surface →
 * this endpoint resolves the machine's grant (idempotent: a machine keeps the
 * SAME key across restarts) or allocates one from the pool → returns the LLM
 * triple (base_url / model / api_key) plus the pool's expiry.
 *
 * Deliberate boundaries:
 * - **No gateway.** base_url + key come from the third-party gateway and are
 *   handed down as-is; that gateway owns the real quota. We never proxy chat.
 * - **Trial-gated only.** A machine needs an active `trial_grants` row; this is
 *   the "trial period only" form (not a permanent free tier).
 * - **Never re-issue.** A machine whose key was revoked or whose pool expired
 *   gets an error, not a fresh key — otherwise a machine could churn keys and
 *   drain the pool (plan §3.3 rule 1).
 * - **Pool disabled ≠ cut off.** `status='disabled'` on a pool only removes its
 *   keys from *new* allocation; machines already holding one keep working.
 *   Cutting them off is `revokeLlmTrialKey`.
 *
 * Allocation ordering: candidates are ordered by referenced-machine count ASC,
 * then `created_at` DESC — "prefer keys nobody uses yet, newest first". The same
 * ordering doubles as the fallback when every key has at least one reference;
 * `trialLlmReuseReferencedKeys` decides whether that fallback may run at all.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import { llmTrialGrants, llmTrialKeys, llmTrialPools, llmTrialSettings, trialGrants } from "../db/schema";
import { aesDecrypt, aesEncrypt, bytesToHex, getAesKey, packAesBlob, unpackAesBlob } from "../crypto/aes";
import {
  ActivationError,
  machineIdentityFromFingerprint,
  nowISO,
  telemetryMachineHashFromFingerprint,
  writeAuditLog,
} from "./activation";

type LlmTrialPool = typeof llmTrialPools.$inferSelect;
type LlmTrialKey = typeof llmTrialKeys.$inferSelect;
type LlmTrialGrant = typeof llmTrialGrants.$inferSelect;

export type TrialLlmProfile = {
  base_url: string;
  model: string;
  api_key: string;
};

export type TrialLlmProfileResponse = {
  grant_id: string;
  llm: TrialLlmProfile;
  /** Epoch seconds. Authoritative for the client's optimistic expiry check. */
  valid_until: number;
  /** Our per-machine soft turn cap — NOT the third-party remaining quota. */
  quota?: { max_requests: number };
  issued_at: number;
};

export type LlmTrialKeySummary = {
  id: string;
  poolId: string;
  status: string;
  note: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Last 4 characters, so an operator can tell keys apart. Never the full key. */
  keyHint: string | null;
  /** Machines currently holding this key (active grants). */
  referencedMachines: number;
};

export type LlmTrialPoolSummary = {
  id: string;
  name: string;
  note: string | null;
  productId: string;
  baseUrl: string;
  model: string;
  validUntil: string;
  /** Candidate filter — `null` means "any platform". Shown in the edit modal. */
  platform: string | null;
  status: string;
  expired: boolean;
  keyCount: number;
  activeKeyCount: number;
  /** Keys with zero active references — the "top up the pool" signal. */
  unusedKeyCount: number;
  referencedMachines: number;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────

/** UTC wall-clock seconds, same shape services/trial.ts writes. */
function dateToISOSeconds(date: Date): string {
  return date.toISOString().replace("T", " ").substring(0, 19);
}

function parseDbDate(value: string): Date {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(normalized);
}

function unixSeconds(value: string): number {
  return Math.floor(parseDbDate(value).getTime() / 1000);
}

function isPast(value: string, now = new Date()): boolean {
  return parseDbDate(value).getTime() <= now.getTime();
}

/**
 * Normalise an operator-supplied expiry into the DB shape.
 *
 * Accepts a `Date`, epoch seconds (number or numeric string), or a
 * `YYYY-MM-DD HH:MM[:SS]` / ISO-8601 `YYYY-MM-DDTHH:MM[:SS][.sss][Z]` stamp.
 * Stamp strings are treated as UTC — the dashboard labels the field accordingly,
 * and epoch seconds avoid the question entirely.
 *
 * The ISO branch matters: `new Date(...).toISOString()` (the obvious way to build
 * a timestamp in a script) carries milliseconds and a `Z`, and storing that
 * verbatim produces a value `parseDbDate` cannot read.
 */
export function normalizeValidUntil(value: number | string | Date): string {
  if (value instanceof Date) {
    return dateToISOSeconds(value);
  }
  if (typeof value === "number") {
    return dateToISOSeconds(new Date(value * 1000));
  }
  const trimmed = value.trim();
  if (/^\d{9,}$/.test(trimmed)) {
    return dateToISOSeconds(new Date(Number(trimmed) * 1000));
  }
  const stamp = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?Z?$/
  );
  if (stamp) {
    const [, day, hourMinute, seconds] = stamp;
    return `${day} ${hourMinute}:${seconds ?? "00"}`;
  }
  return trimmed;
}

/** Region gate, same shape as catalog's `isCountryEligible`. */
export function poolAllowsCountry(
  pool: Pick<LlmTrialPool, "excludedCountries">,
  country: string | null | undefined
): boolean {
  if (!country) return true;
  const excluded = parseStringArray(pool.excludedCountries);
  return !excluded.includes(country.toUpperCase());
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase())
      : [];
  } catch {
    return [];
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Both hash shapes a machine's rows may sit under: identity-normalised and raw.
 * Mirrors services/trial.ts and services/catalog.ts — all three MUST stay in
 * sync, or a machine's existing grant stops being found and it gets handed a
 * second key.
 */
export async function llmTrialFingerprintHashCandidates(
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<string[]> {
  const identity = await machineIdentityFromFingerprint(fingerprint);
  const stable = identity ? `${identity.kind}:${identity.value}` : fingerprint;
  return Array.from(new Set([
    await sha256Hex(`${config.trialFingerprintSalt}:${productId}:${stable}`),
    await sha256Hex(`${config.trialFingerprintSalt}:${productId}:${fingerprint}`),
  ]));
}

function randomGrantId(): string {
  return randomPrefixedId("lg_");
}

function randomPoolId(): string {
  return randomPrefixedId("lp_");
}

function randomKeyId(): string {
  return randomPrefixedId("lk_");
}

function randomPrefixedId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToHex(bytes)}`;
}

/** 32-char IV string; packAesBlob stores exactly that prefix. */
function randomIv(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * The operator-facing fragment of a key: its last 4 characters.
 *
 * Stored at creation time so listing keys never has to decrypt one. Four
 * characters are not enough to reconstruct or use a key, and the dashboard is
 * behind admin auth.
 */
function keyHintFrom(apiKey: string): string | null {
  const trimmed = apiKey.trim();
  if (trimmed.length < 4) return null;
  return trimmed.slice(-4);
}

/** Who did it — recorded in `audit_logs` for every pool/key mutation. */
export type LlmTrialAudit = {
  actor?: string;
  ipAddress?: string | null;
};

async function encryptApiKey(apiKey: string): Promise<string> {
  const iv = randomIv();
  return packAesBlob(iv, await aesEncrypt(getAesKey(), iv, apiKey));
}

async function decryptApiKey(blob: string): Promise<string> {
  // Validates the packed length header as a side effect.
  const [iv, dataHex] = unpackAesBlob(blob);
  return aesDecrypt(getAesKey(), iv, dataHex);
}

// ─── Dashboard master switch ───────────────────────────────────────────────

export const LLM_TRIAL_ENABLED_SETTING_KEY = "enabled";

/**
 * The dashboard master switch. **Absent = OFF**, so deploying this feature
 * changes no behaviour until an operator turns it on, and turning it off again is
 * one click rather than a redeploy.
 *
 * OFF stops *all* issuance — including machines that already hold a key, whose
 * next request is answered `TRIAL_LLM_DISABLED` and which then fall back to the
 * ordinary "configure your own service" path. Per-machine precision is what
 * revoking one key or disabling one pool is for; this is the global stop.
 */
export async function readLlmTrialEnabled(db: Database): Promise<boolean> {
  const row = await db
    .select()
    .from(llmTrialSettings)
    .where(eq(llmTrialSettings.key, LLM_TRIAL_ENABLED_SETTING_KEY))
    .get();
  return row?.value === "true";
}

export async function writeLlmTrialEnabled(db: Database, enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  await db
    .insert(llmTrialSettings)
    .values({ key: LLM_TRIAL_ENABLED_SETTING_KEY, value, updatedAt: nowISO() })
    .onConflictDoUpdate({
      target: llmTrialSettings.key,
      set: { value, updatedAt: nowISO() },
    });
}

// ─── DB-backed operations ─────────────────────────────────────────────────

async function hasActiveTrial(
  db: Database,
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<boolean> {
  const hashes = await llmTrialFingerprintHashCandidates(config, productId, fingerprint);
  const rows = await db
    .select({ validUntil: trialGrants.validUntil })
    .from(trialGrants)
    .where(and(inArray(trialGrants.fingerprintHash, hashes), eq(trialGrants.status, "active")))
    .all();
  const now = Date.now();
  return rows.some((row) => parseDbDate(row.validUntil).getTime() > now);
}

async function loadGrant(
  db: Database,
  hashes: string[]
): Promise<LlmTrialGrant | null> {
  const rows = await db
    .select()
    .from(llmTrialGrants)
    .where(inArray(llmTrialGrants.fingerprintHash, hashes))
    .all();
  // Prefer a live grant so a machine that somehow holds two rows keeps the one
  // that still works.
  return rows.find((row) => row.status === "active") ?? rows[0] ?? null;
}

async function loadKey(
  db: Database,
  keyId: string
): Promise<{ key: LlmTrialKey; pool: LlmTrialPool } | null> {
  const rows = await db
    .select({ key: llmTrialKeys, pool: llmTrialPools })
    .from(llmTrialKeys)
    .innerJoin(llmTrialPools, eq(llmTrialKeys.poolId, llmTrialPools.id))
    .where(eq(llmTrialKeys.id, keyId))
    .all();
  return rows[0] ?? null;
}

async function activeReferenceCounts(
  db: Database,
  keyIds: string[]
): Promise<Map<string, number>> {
  if (keyIds.length === 0) return new Map();
  const rows = await db
    .select({ keyId: llmTrialGrants.keyId, count: sql<number>`count(*)` })
    .from(llmTrialGrants)
    .where(and(inArray(llmTrialGrants.keyId, keyIds), eq(llmTrialGrants.status, "active")))
    .groupBy(llmTrialGrants.keyId)
    .all();
  return new Map(rows.map((row) => [row.keyId, Number(row.count ?? 0)]));
}

/** Mark a grant unusable so it stops counting as a live reference. */
async function closeGrant(db: Database, grantId: string, status: string): Promise<void> {
  await db
    .update(llmTrialGrants)
    .set({ status, updatedAt: nowISO() })
    .where(eq(llmTrialGrants.grantId, grantId));
}

function responseFrom(
  grantId: string,
  pool: LlmTrialPool,
  apiKey: string,
  issuedAtUnix: number,
  softMaxRequests: number
): TrialLlmProfileResponse {
  return {
    grant_id: grantId,
    llm: { base_url: pool.baseUrl, model: pool.model, api_key: apiKey },
    valid_until: unixSeconds(pool.validUntil),
    quota: softMaxRequests > 0 ? { max_requests: softMaxRequests } : undefined,
    issued_at: issuedAtUnix,
  };
}

/**
 * Issue (or re-return) this machine's trial LLM profile.
 *
 * Ordering is load-bearing — the idempotency check MUST come before allocation,
 * because the client re-requests on every cold start to sync revocations. Any
 * allocation-first ordering would hand out a brand-new unused key each launch
 * and drain the pool.
 */
export async function issueTrialLlmProfile(
  db: Database,
  config: AppConfig,
  params: {
    productId?: string | null;
    fingerprint: string;
    appVersion: string | null;
    platform: string | null;
    country?: string | null;
  }
): Promise<TrialLlmProfileResponse> {
  // The single gate. Checked BEFORE the idempotent return on purpose: a global
  // stop that left already-issued machines running would not be a stop. The
  // client treats this code as terminal and silently falls back to the
  // config-wall path. Absent key = off, so deploying this changes nothing.
  if (!(await readLlmTrialEnabled(db))) {
    throw new ActivationError("TRIAL_LLM_DISABLED", "试用额度暂未开放", 403);
  }

  const productId = (params.productId || config.defaultProductId).trim();
  const fingerprint = params.fingerprint.trim();
  if (!fingerprint) {
    throw new ActivationError("INVALID_REQUEST", "fingerprint 不能为空", 400);
  }

  if (!(await hasActiveTrial(db, config, productId, fingerprint))) {
    throw new ActivationError("TRIAL_REQUIRED", "试用额度仅在试用期内可用", 403);
  }

  const hashes = await llmTrialFingerprintHashCandidates(config, productId, fingerprint);
  const now = new Date();
  const issuedAtUnix = Math.floor(now.getTime() / 1000);

  // ── Step 1: existing grant → idempotent, or a terminal error. Never re-issue.
  const existing = await loadGrant(db, hashes);
  if (existing) {
    const loaded = await loadKey(db, existing.keyId);
    if (!loaded || loaded.key.status !== "active") {
      await closeGrant(db, existing.grantId, "revoked");
      throw new ActivationError(
        "LLM_KEY_REVOKED",
        "试用额度已结束",
        409,
        { grant_id: existing.grantId }
      );
    }
    if (isPast(loaded.pool.validUntil, now)) {
      await closeGrant(db, existing.grantId, "expired");
      throw new ActivationError(
        "LLM_KEY_EXPIRED",
        "试用额度已过期",
        409,
        { grant_id: existing.grantId }
      );
    }
    // Pool `status` is deliberately NOT checked here: disabling a pool stops new
    // issuance only, it must not cut off machines that already hold a key.
    //
    // Re-activate a grant we previously closed (e.g. it was marked `expired` and
    // ops later extended the pool): the reference ledger only counts active
    // grants, so leaving it closed would let another machine be handed this key
    // while this one still uses it.
    if (existing.status !== "active") {
      await db
        .update(llmTrialGrants)
        .set({ status: "active", validUntil: loaded.pool.validUntil, updatedAt: nowISO() })
        .where(eq(llmTrialGrants.grantId, existing.grantId));
    }
    return responseFrom(
      existing.grantId,
      loaded.pool,
      await decryptApiKey(loaded.key.apiKeyEnc),
      unixSeconds(existing.createdAt),
      config.trialLlmSoftMaxRequests
    );
  }

  // ── Step 2: first issuance. Defensive quota check (normally zero).
  const liveGrants = await db
    .select({ count: sql<number>`count(*)` })
    .from(llmTrialGrants)
    .where(and(inArray(llmTrialGrants.fingerprintHash, hashes), eq(llmTrialGrants.status, "active")))
    .all();
  if (Number(liveGrants[0]?.count ?? 0) >= Math.max(1, config.trialLlmMaxProfilesPerMachine)) {
    throw new ActivationError("LLM_ISSUE_LIMIT_REACHED", "试用额度已领取过", 409);
  }

  // ── Step 3: allocate. "Prefer keys nobody uses yet, newest first."
  const candidates = (await db
    .select({ key: llmTrialKeys, pool: llmTrialPools })
    .from(llmTrialKeys)
    .innerJoin(llmTrialPools, eq(llmTrialKeys.poolId, llmTrialPools.id))
    .where(and(eq(llmTrialKeys.status, "active"), eq(llmTrialPools.status, "active")))
    .all()
  ).filter(
    ({ pool }) =>
      pool.productId === productId &&
      !isPast(pool.validUntil, now) &&
      (!pool.platform || pool.platform === params.platform) &&
      poolAllowsCountry(pool, params.country)
  );

  if (candidates.length === 0) {
    throw new ActivationError("LLM_POOL_EMPTY", "试用额度暂不可用，请稍后再试", 503);
  }

  const references = await activeReferenceCounts(
    db,
    candidates.map(({ key }) => key.id)
  );
  const ordered = candidates
    .map(({ key, pool }) => ({ key, pool, refs: references.get(key.id) ?? 0 }))
    .sort((a, b) => {
      if (a.refs !== b.refs) return a.refs - b.refs;
      // Never-used first, then newest first. created_at is 'YYYY-MM-DD HH:MM:SS',
      // so a plain string compare is a chronological compare. Keys seeded in the
      // same second tie on created_at, so fall back to the id for determinism —
      // otherwise a batch of keys would be picked in query order.
      const byCreated = b.key.createdAt.localeCompare(a.key.createdAt);
      return byCreated !== 0 ? byCreated : a.key.id.localeCompare(b.key.id);
    });

  const fresh = ordered[0];
  if (fresh.refs > 0 && !config.trialLlmReuseReferencedKeys) {
    throw new ActivationError("LLM_POOL_EMPTY", "试用额度暂不可用，请稍后再试", 503);
  }

  const grantId = randomGrantId();
  await db.insert(llmTrialGrants).values({
    grantId,
    fingerprintHash: hashes[0] ?? fingerprint,
    keyId: fresh.key.id,
    telemetryMachineHash: await telemetryMachineHashFromFingerprint(fingerprint),
    validUntil: fresh.pool.validUntil,
    status: "active",
    appVersion: params.appVersion,
    platform: params.platform,
  });

  return responseFrom(
    grantId,
    fresh.pool,
    await decryptApiKey(fresh.key.apiKeyEnc),
    issuedAtUnix,
    config.trialLlmSoftMaxRequests
  );
}

// ─── Admin operations ─────────────────────────────────────────────────────

export async function createLlmTrialPool(
  db: Database,
  params: {
    name: string;
    note?: string | null;
    productId: string;
    baseUrl: string;
    model: string;
    validUntil: number | string | Date;
    platform?: string | null;
    excludedCountries?: string[] | null;
  },
  audit: LlmTrialAudit = {}
): Promise<LlmTrialPool> {
  const name = params.name.trim();
  const baseUrl = params.baseUrl.trim();
  const model = params.model.trim();
  if (!name || !baseUrl || !model) {
    throw new ActivationError("INVALID_REQUEST", "name / baseUrl / model 不能为空", 400);
  }
  const validUntil = normalizeValidUntil(params.validUntil);
  if (!validUntil || Number.isNaN(parseDbDate(validUntil).getTime())) {
    throw new ActivationError("INVALID_REQUEST", "valid_until 无法解析", 400);
  }

  const id = randomPoolId();
  await db.insert(llmTrialPools).values({
    id,
    name,
    note: params.note ?? null,
    productId: params.productId,
    baseUrl,
    model,
    validUntil,
    platform: params.platform ?? null,
    excludedCountries: params.excludedCountries
      ? JSON.stringify(params.excludedCountries.map((c) => c.toUpperCase()))
      : null,
    status: "active",
  });
  const pool = await db.select().from(llmTrialPools).where(eq(llmTrialPools.id, id)).get();
  if (!pool) throw new ActivationError("SERVER_ERROR", "读取池记录失败", 500);
  await writeAuditLog(db, {
    action: "llm_trial_pool_create",
    targetType: "llm_trial_pool",
    targetId: id,
    actor: audit.actor,
    ipAddress: audit.ipAddress,
    after: pool,
  });
  return pool;
}

/**
 * Patch a pool. Only the fields listed here are editable — `id`, `status` and the
 * derived counters are not.
 *
 * Extending `valid_until` is the operationally important one: expiry is read live
 * from the pool, so extending it revives machines that were already answered
 * `LLM_KEY_EXPIRED` instead of stranding them.
 */
export async function updateLlmTrialPool(
  db: Database,
  poolId: string,
  patch: {
    name?: string;
    note?: string | null;
    baseUrl?: string;
    model?: string;
    validUntil?: number | string | Date;
    platform?: string | null;
    excludedCountries?: string[] | null;
  },
  audit: LlmTrialAudit = {}
): Promise<LlmTrialPool> {
  const before = await db.select().from(llmTrialPools).where(eq(llmTrialPools.id, poolId)).get();
  if (!before) throw new ActivationError("POOL_NOT_FOUND", "池不存在", 404);

  const next: Partial<typeof llmTrialPools.$inferInsert> = { updatedAt: nowISO() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new ActivationError("INVALID_REQUEST", "name 不能为空", 400);
    next.name = name;
  }
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.baseUrl !== undefined) {
    const baseUrl = patch.baseUrl.trim();
    if (!baseUrl) throw new ActivationError("INVALID_REQUEST", "baseUrl 不能为空", 400);
    next.baseUrl = baseUrl;
  }
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (!model) throw new ActivationError("INVALID_REQUEST", "model 不能为空", 400);
    next.model = model;
  }
  if (patch.validUntil !== undefined) {
    const validUntil = normalizeValidUntil(patch.validUntil);
    if (!validUntil || Number.isNaN(parseDbDate(validUntil).getTime())) {
      throw new ActivationError("INVALID_REQUEST", "valid_until 无法解析", 400);
    }
    next.validUntil = validUntil;
  }
  if (patch.platform !== undefined) next.platform = patch.platform;
  if (patch.excludedCountries !== undefined) {
    next.excludedCountries = patch.excludedCountries
      ? JSON.stringify(patch.excludedCountries.map((c) => c.toUpperCase()))
      : null;
  }

  await db.update(llmTrialPools).set(next).where(eq(llmTrialPools.id, poolId));
  const after = await db.select().from(llmTrialPools).where(eq(llmTrialPools.id, poolId)).get();
  if (!after) throw new ActivationError("SERVER_ERROR", "读取池记录失败", 500);
  await writeAuditLog(db, {
    action: "llm_trial_pool_update",
    targetType: "llm_trial_pool",
    targetId: poolId,
    actor: audit.actor,
    ipAddress: audit.ipAddress,
    before,
    after,
  });
  return after;
}

export async function setLlmTrialPoolStatus(
  db: Database,
  poolId: string,
  status: "active" | "disabled",
  audit: LlmTrialAudit = {}
): Promise<void> {
  const pool = await db.select().from(llmTrialPools).where(eq(llmTrialPools.id, poolId)).get();
  if (!pool) throw new ActivationError("POOL_NOT_FOUND", "池不存在", 404);
  await db
    .update(llmTrialPools)
    .set({ status, updatedAt: nowISO() })
    .where(eq(llmTrialPools.id, poolId));
  await writeAuditLog(db, {
    action: status === "disabled" ? "llm_trial_pool_disable" : "llm_trial_pool_enable",
    targetType: "llm_trial_pool",
    targetId: poolId,
    actor: audit.actor,
    ipAddress: audit.ipAddress,
    before: { status: pool.status },
    after: { status },
  });
}

export async function createLlmTrialKey(
  db: Database,
  params: { poolId: string; apiKey: string; note?: string | null },
  audit: LlmTrialAudit = {}
): Promise<LlmTrialKey> {
  const pool = await db
    .select()
    .from(llmTrialPools)
    .where(eq(llmTrialPools.id, params.poolId))
    .get();
  if (!pool) throw new ActivationError("POOL_NOT_FOUND", "池不存在", 404);
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    throw new ActivationError("INVALID_REQUEST", "apiKey 不能为空", 400);
  }

  const id = randomKeyId();
  await db.insert(llmTrialKeys).values({
    id,
    poolId: params.poolId,
    apiKeyEnc: await encryptApiKey(apiKey),
    keyHint: keyHintFrom(apiKey),
    status: "active",
    note: params.note ?? null,
  });
  const key = await db.select().from(llmTrialKeys).where(eq(llmTrialKeys.id, id)).get();
  if (!key) throw new ActivationError("SERVER_ERROR", "读取 key 记录失败", 500);
  await writeAuditLog(db, {
    action: "llm_trial_key_create",
    targetType: "llm_trial_key",
    targetId: id,
    actor: audit.actor,
    ipAddress: audit.ipAddress,
    // Never the key itself — not even the encrypted form.
    after: { id, poolId: key.poolId, keyHint: key.keyHint, status: key.status },
  });
  return key;
}

/**
 * Paste-a-batch helper: one key per line.
 *
 * Deduplicates within the batch and drops blanks, so a re-pasted list cannot add
 * the same row twice in one submission. Cross-batch duplicates are *not* detected
 * (that would mean decrypting every stored key to compare); the returned counts
 * make what happened visible to the operator.
 */
export async function createLlmTrialKeys(
  db: Database,
  params: { poolId: string; apiKeys: string[]; note?: string | null },
  audit: LlmTrialAudit = {}
): Promise<{ created: number; skipped: number; ids: string[] }> {
  const seen = new Set<string>();
  const unique: string[] = [];
  let skipped = 0;
  for (const raw of params.apiKeys) {
    const key = raw.trim();
    if (!key) continue;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    unique.push(key);
  }
  if (unique.length === 0) {
    throw new ActivationError("INVALID_REQUEST", "没有可添加的 key", 400);
  }

  const ids: string[] = [];
  for (const apiKey of unique) {
    const created = await createLlmTrialKey(
      db,
      { poolId: params.poolId, apiKey, note: params.note ?? null },
      audit
    );
    ids.push(created.id);
  }
  await writeAuditLog(db, {
    action: "llm_trial_key_bulk_create",
    targetType: "llm_trial_pool",
    targetId: params.poolId,
    actor: audit.actor,
    ipAddress: audit.ipAddress,
    after: { created: ids.length, skipped },
  });
  return { created: ids.length, skipped, ids };
}

/**
 * Manual kill switch for one key. Because a key serves several machines, this
 * cuts off every machine referencing it — the admin UI shows that blast radius
 * before the operator clicks. Affected machines learn about it on their next
 * launch (the endpoint answers LLM_KEY_REVOKED) or immediately if the upstream
 * key also dies (401/403).
 */
export async function revokeLlmTrialKey(
  db: Database,
  keyId: string,
  audit: LlmTrialAudit = {}
): Promise<{ revokedGrants: number }> {
  const key = await db.select().from(llmTrialKeys).where(eq(llmTrialKeys.id, keyId)).get();
  if (!key) throw new ActivationError("KEY_NOT_FOUND", "key 不存在", 404);

  await db
    .update(llmTrialKeys)
    .set({ status: "revoked", revokedAt: nowISO(), updatedAt: nowISO() })
    .where(eq(llmTrialKeys.id, keyId));

  const affected = await db
    .select({ grantId: llmTrialGrants.grantId })
    .from(llmTrialGrants)
    .where(and(eq(llmTrialGrants.keyId, keyId), eq(llmTrialGrants.status, "active")))
    .all();
  if (affected.length > 0) {
    await db
      .update(llmTrialGrants)
      .set({ status: "revoked", updatedAt: nowISO() })
      .where(and(eq(llmTrialGrants.keyId, keyId), eq(llmTrialGrants.status, "active")));
  }
  await writeAuditLog(db, {
    action: "llm_trial_key_revoke",
    targetType: "llm_trial_key",
    targetId: keyId,
    actor: audit.actor,
    ipAddress: audit.ipAddress,
    before: { status: key.status, poolId: key.poolId, keyHint: key.keyHint },
    after: { status: "revoked", revokedGrants: affected.length },
  });
  return { revokedGrants: affected.length };
}

export async function listLlmTrialPools(db: Database): Promise<LlmTrialPoolSummary[]> {
  const pools = await db.select().from(llmTrialPools).all();
  const keys = await db.select().from(llmTrialKeys).all();
  const grants = await db
    .select({ keyId: llmTrialGrants.keyId, status: llmTrialGrants.status })
    .from(llmTrialGrants)
    .all();

  const refs = new Map<string, number>();
  for (const grant of grants) {
    if (grant.status !== "active") continue;
    refs.set(grant.keyId, (refs.get(grant.keyId) ?? 0) + 1);
  }

  const now = new Date();
  return pools.map((pool) => {
    const poolKeys = keys.filter((key) => key.poolId === pool.id);
    const activeKeys = poolKeys.filter((key) => key.status === "active");
    return {
      id: pool.id,
      name: pool.name,
      note: pool.note,
      productId: pool.productId,
      baseUrl: pool.baseUrl,
      model: pool.model,
      validUntil: pool.validUntil,
      platform: pool.platform ?? null,
      status: pool.status,
      expired: isPast(pool.validUntil, now),
      keyCount: poolKeys.length,
      activeKeyCount: activeKeys.length,
      unusedKeyCount: activeKeys.filter((key) => (refs.get(key.id) ?? 0) === 0).length,
      referencedMachines: activeKeys.reduce((sum, key) => sum + (refs.get(key.id) ?? 0), 0),
    };
  });
}

export async function listLlmTrialKeys(
  db: Database,
  params: { poolId?: string } = {}
): Promise<LlmTrialKeySummary[]> {
  const keys = params.poolId
    ? await db.select().from(llmTrialKeys).where(eq(llmTrialKeys.poolId, params.poolId)).all()
    : await db.select().from(llmTrialKeys).all();
  const grants = await db
    .select({ keyId: llmTrialGrants.keyId, status: llmTrialGrants.status })
    .from(llmTrialGrants)
    .all();

  const refs = new Map<string, number>();
  for (const grant of grants) {
    if (grant.status !== "active") continue;
    refs.set(grant.keyId, (refs.get(grant.keyId) ?? 0) + 1);
  }

  return keys.map((key) => ({
    id: key.id,
    poolId: key.poolId,
    status: key.status,
    note: key.note,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
    keyHint: key.keyHint ?? null,
    referencedMachines: refs.get(key.id) ?? 0,
  }));
}
