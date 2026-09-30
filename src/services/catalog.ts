/**
 * Random sample-model catalog for trial machines (Lever 1, 2026-09-29 plan).
 *
 * Flow: trial bootstrap carries a `model_catalog` flag → the workshop card
 * shows for eligible trial machines → claim picks one enabled model at random,
 * writes a `catalog_grants` row (the quota ledger, N per machine) and returns
 * presigned R2 URLs → the client downloads directly from R2 and imports it
 * through the regular user-import path.
 *
 * Field split: D1 `catalog_models` holds runtime selection fields only; the
 * copy payload (name/tags i18n, license note) lives in each model's
 * manifest.json object in R2 and is read once per claim.
 *
 * Quota semantics: a claim consumes one grant. Retries pass the same
 * `grant_id` and reuse the row — a failed download never burns extra quota.
 * There is no refund in v1 (anti-abuse; decided 2026-09-29).
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { AwsClient } from "aws4fetch";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import { catalogGrants, catalogModels, catalogSettings, trialGrants } from "../db/schema";
import { ActivationError, machineIdentityFromFingerprint, nowISO } from "./activation";

type CatalogModel = typeof catalogModels.$inferSelect;
type CatalogGrant = typeof catalogGrants.$inferSelect;

/** Minimal structural view of the R2 binding — keeps services and tests decoupled from workers-types. */
export interface CatalogObjectStore {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

export type CatalogStatus = { enabled: boolean; remaining: number; max: number };

export type CatalogClaimResponse = {
  grant_id: string;
  model: {
    id: string;
    name: string;
    tags: string[];
    thumb_url: string;
    size_bytes: number;
    /** Locale the name/tags were resolved to ("en" is the fallback). */
    content_locale: string;
  };
  download: { url: string; expires_in: number; sha256: string };
};

export type CatalogReportResult = "imported" | "download_failed" | "import_failed";

// ─── Pure helpers (unit-tested directly) ──────────────────────────────────

/** Region gate. `country` comes from `request.cf.country`; absent geo data (tests/local dev) allows through — the claim is still trial-gated. */
export function isCountryEligible(
  config: Pick<AppConfig, "catalogExcludedCountries">,
  country: string | null | undefined
): boolean {
  if (!country) return true;
  return !config.catalogExcludedCountries.includes(country.toUpperCase());
}

/** A model serves the requested locale directly or falls back to "en". */
export function modelServesLocale(locales: string[], locale: string): boolean {
  return locales.includes(locale) || locales.includes("en");
}

export function parseLocales(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function pickRandomModel<T>(models: T[]): T | null {
  if (models.length === 0) return null;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return models[buf[0] % models.length] ?? null;
}

/**
 * Resolve the manifest's locale-mapped copy for the requested locale.
 * Fallback chain: requested locale → "en" → first entry. Returns null when
 * the manifest carries no usable name.
 */
export function resolveManifestContent(
  manifest: unknown,
  locale: string
): { name: string; tags: string[]; locale: string } | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const raw = manifest as Record<string, unknown>;
  if (typeof raw.name !== "object" || raw.name === null) return null;
  const nameMap = raw.name as Record<string, unknown>;
  const tagsMap =
    typeof raw.tags === "object" && raw.tags !== null
      ? (raw.tags as Record<string, unknown>)
      : {};
  const pickValue = (map: Record<string, unknown>): unknown =>
    map[locale] ?? map["en"] ?? Object.values(map)[0];
  const name = pickValue(nameMap);
  if (typeof name !== "string" || !name.trim()) return null;
  const rawTags = pickValue(tagsMap);
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === "string")
    : [];
  const resolvedLocale =
    typeof nameMap[locale] === "string"
      ? locale
      : typeof nameMap["en"] === "string"
        ? "en"
        : locale;
  return { name, tags, locale: resolvedLocale };
}

/**
 * R2 presigned GET (aws4fetch, query signing). Credentials come from the
 * read-only R2 API token; endpoint is `https://{account}.r2.cloudflarestorage.com/{bucket}`.
 */
export async function presignedGetUrl(params: {
  endpoint: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
}): Promise<string> {
  const client = new AwsClient({
    accessKeyId: params.accessKeyId,
    secretAccessKey: params.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = new URL(params.endpoint.endsWith("/") ? params.endpoint : `${params.endpoint}/`);
  url.pathname += params.key.split("/").map(encodeURIComponent).join("/");
  url.searchParams.set("X-Amz-Expires", String(Math.max(60, params.expiresInSeconds)));
  const signed = await client.sign(new Request(url, { method: "GET" }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

function randomGrantId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `cg_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ─── Fingerprint → quota key (mirrors services/trial.ts formulas) ─────────

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function primaryFingerprintHash(
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<string> {
  const identity = await machineIdentityFromFingerprint(fingerprint);
  const stable = identity ? `${identity.kind}:${identity.value}` : fingerprint;
  return sha256Hex(`${config.trialFingerprintSalt}:${productId}:${stable}`);
}

/** Both hash shapes a machine's rows may sit under (identity-normalised and raw). */
export async function catalogFingerprintHashCandidates(
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<string[]> {
  return Array.from(new Set([
    await primaryFingerprintHash(config, productId, fingerprint),
    await sha256Hex(`${config.trialFingerprintSalt}:${productId}:${fingerprint}`),
  ]));
}

function parseDbDate(value: string): Date {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(normalized);
}

// ─── Admin master flag (dashboard one-click show/hide) ────────────────────

export const CARD_ENABLED_SETTING_KEY = "card_enabled";

/**
 * The dashboard master flag for the workshop card. **Default OFF** — until an
 * admin enables it, the bootstrap flag reports disabled and the card stays
 * hidden even with models uploaded. AND-ed with the deploy-level
 * `CATALOG_ENABLED` env and the rest of the eligibility gates.
 */
export async function readCatalogCardEnabled(db: Database): Promise<boolean> {
  const row = await db
    .select()
    .from(catalogSettings)
    .where(eq(catalogSettings.key, CARD_ENABLED_SETTING_KEY))
    .get();
  return row?.value === "true";
}

export async function writeCatalogCardEnabled(db: Database, enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  await db
    .insert(catalogSettings)
    .values({ key: CARD_ENABLED_SETTING_KEY, value, updatedAt: nowISO() })
    .onConflictDoUpdate({
      target: catalogSettings.key,
      set: { value, updatedAt: nowISO() },
    });
}

// ─── DB-backed operations ─────────────────────────────────────────────────

async function usedGrantCount(db: Database, hashes: string[]): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(catalogGrants)
    .where(
      and(inArray(catalogGrants.fingerprintHash, hashes), ne(catalogGrants.status, "refunded"))
    )
    .all();
  return Number(rows[0]?.count ?? 0);
}

async function hasActiveTrial(
  db: Database,
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<boolean> {
  const hashes = await catalogFingerprintHashCandidates(config, productId, fingerprint);
  const rows = await db
    .select({ validUntil: trialGrants.validUntil })
    .from(trialGrants)
    .where(and(inArray(trialGrants.fingerprintHash, hashes), eq(trialGrants.status, "active")))
    .all();
  const now = Date.now();
  return rows.some((row) => parseDbDate(row.validUntil).getTime() > now);
}

async function loadEnabledModel(
  db: Database,
  modelId: string
): Promise<CatalogModel | null> {
  const model = await db.select().from(catalogModels).where(eq(catalogModels.id, modelId)).get();
  return model && model.enabled ? model : null;
}

async function presignCatalogUrl(
  config: AppConfig,
  key: string
): Promise<string> {
  if (!config.catalogR2Endpoint || !config.r2AccessKeyId || !config.r2SecretAccessKey) {
    throw new ActivationError("CATALOG_NOT_CONFIGURED", "模型存储未配置", 500);
  }
  return presignedGetUrl({
    endpoint: config.catalogR2Endpoint,
    key,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    expiresInSeconds: config.catalogDownloadUrlTtlSeconds,
  });
}

async function readManifestObject(
  bucket: CatalogObjectStore,
  key: string
): Promise<unknown> {
  const obj = await bucket.get(key);
  if (!obj) throw new ActivationError("CATALOG_MANIFEST_MISSING", "模型元信息缺失", 500);
  return obj.json();
}

/**
 * Eligibility flag for the trial bootstrap response. Only called on the
 * startTrial success path (trial is active by construction); a disabled or
 * geo-excluded catalog yields enabled=false so the client hides the card.
 * An EMPTY catalog (zero enabled models) also yields enabled=false — showing
 * the card would only produce CATALOG_EMPTY failures on click.
 */
export async function catalogStatusFor(
  db: Database,
  config: AppConfig,
  params: { productId: string; fingerprint: string; country: string | null }
): Promise<CatalogStatus> {
  const max = Math.max(0, config.catalogMaxGrantsPerMachine);
  if (!config.catalogEnabled || !isCountryEligible(config, params.country)) {
    return { enabled: false, remaining: 0, max };
  }
  // Admin master flag: default OFF until enabled from the dashboard.
  if (!(await readCatalogCardEnabled(db))) {
    return { enabled: false, remaining: 0, max };
  }
  const enabledRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(catalogModels)
    .where(eq(catalogModels.enabled, true))
    .all();
  if (Number(enabledRows[0]?.count ?? 0) === 0) {
    return { enabled: false, remaining: 0, max };
  }
  const hashes = await catalogFingerprintHashCandidates(
    config,
    params.productId,
    params.fingerprint
  );
  const used = await usedGrantCount(db, hashes);
  return { enabled: true, remaining: Math.max(0, max - used), max };
}

export async function claimCatalogModel(
  db: Database,
  config: AppConfig,
  bucket: CatalogObjectStore | null,
  params: {
    productId: string;
    fingerprint: string;
    locale: string;
    appVersion: string | null;
    platform: string | null;
    country: string | null;
    grantId: string | null;
  }
): Promise<CatalogClaimResponse> {
  if (!config.catalogEnabled) {
    throw new ActivationError("CATALOG_DISABLED", "模型获取暂未开放", 403);
  }
  // Defense in depth: the bootstrap flag already hides the card, but a direct
  // claim still must not bypass the dashboard master flag.
  if (!(await readCatalogCardEnabled(db))) {
    throw new ActivationError("CATALOG_CARD_DISABLED", "模型获取暂未开放", 403);
  }
  if (!isCountryEligible(config, params.country)) {
    throw new ActivationError("REGION_NOT_ELIGIBLE", "当前地区暂未开放此功能", 403);
  }

  // Retry branch: same grant → same model, fresh URLs, no extra quota.
  if (params.grantId) {
    const grant = await db
      .select()
      .from(catalogGrants)
      .where(eq(catalogGrants.grantId, params.grantId))
      .get();
    const hashes = await catalogFingerprintHashCandidates(
      config,
      params.productId,
      params.fingerprint
    );
    if (!grant || !hashes.includes(grant.fingerprintHash)) {
      throw new ActivationError("GRANT_NOT_FOUND", "领取记录不存在", 404);
    }
    const model = await loadEnabledModel(db, grant.modelId);
    if (!model) {
      throw new ActivationError("CATALOG_EMPTY", "模型暂不可用，请稍后再试", 503);
    }
    return buildClaimResponse(config, bucket, model, grant.grantId, grant.locale);
  }

  const locale = (params.locale || "en").trim();
  const fingerprint = params.fingerprint.trim();
  if (!fingerprint) {
    throw new ActivationError("INVALID_REQUEST", "fingerprint 不能为空", 400);
  }
  if (!(await hasActiveTrial(db, config, params.productId, fingerprint))) {
    throw new ActivationError("TRIAL_REQUIRED", "模型获取仅在试用期内可用", 403);
  }

  const hashes = await catalogFingerprintHashCandidates(config, params.productId, fingerprint);
  const used = await usedGrantCount(db, hashes);
  if (used >= config.catalogMaxGrantsPerMachine) {
    throw new ActivationError("QUOTA_EXHAUSTED", "获取次数已用完", 403);
  }

  const enabled = await db
    .select()
    .from(catalogModels)
    .where(eq(catalogModels.enabled, true))
    .all();
  const candidates = enabled.filter((model) =>
    modelServesLocale(parseLocales(model.locales), locale)
  );
  const model = pickRandomModel(candidates);
  if (!model) {
    throw new ActivationError("CATALOG_EMPTY", "模型暂不可用，请稍后再试", 503);
  }

  const grantId = randomGrantId();
  await db.insert(catalogGrants).values({
    grantId,
    fingerprintHash: hashes[0] ?? fingerprint,
    modelId: model.id,
    locale,
    country: params.country ?? null,
    status: "claimed",
    appVersion: params.appVersion,
    platform: params.platform,
  });

  return buildClaimResponse(config, bucket, model, grantId, locale);
}

async function buildClaimResponse(
  config: AppConfig,
  bucket: CatalogObjectStore | null,
  model: CatalogModel,
  grantId: string,
  locale: string
): Promise<CatalogClaimResponse> {
  if (!bucket) {
    throw new ActivationError("CATALOG_NOT_CONFIGURED", "模型存储未配置", 500);
  }
  const manifest = await readManifestObject(bucket, model.manifestKey);
  const content = resolveManifestContent(manifest, locale);
  if (!content) {
    throw new ActivationError("CATALOG_MANIFEST_INVALID", "模型元信息无效", 500);
  }
  const [downloadUrl, thumbUrl] = await Promise.all([
    presignCatalogUrl(config, model.r2KeyVrm),
    presignCatalogUrl(config, model.r2KeyThumb),
  ]);
  return {
    grant_id: grantId,
    model: {
      id: model.id,
      name: content.name,
      tags: content.tags,
      thumb_url: thumbUrl,
      size_bytes: model.sizeBytes,
      content_locale: content.locale,
    },
    download: {
      url: downloadUrl,
      expires_in: config.catalogDownloadUrlTtlSeconds,
      sha256: model.sha256,
    },
  };
}

export async function reportCatalogResult(
  db: Database,
  config: AppConfig,
  params: {
    productId: string;
    fingerprint: string;
    grantId: string;
    result: string;
    appVersion: string | null;
  }
): Promise<void> {
  if (
    params.result !== "imported" &&
    params.result !== "download_failed" &&
    params.result !== "import_failed"
  ) {
    throw new ActivationError("INVALID_REQUEST", "result 取值无效", 400);
  }
  const result = params.result as CatalogReportResult;
  const grant = await db
    .select()
    .from(catalogGrants)
    .where(eq(catalogGrants.grantId, params.grantId))
    .get();
  const hashes = await catalogFingerprintHashCandidates(
    config,
    params.productId,
    params.fingerprint
  );
  if (!grant || !hashes.includes(grant.fingerprintHash)) {
    throw new ActivationError("GRANT_NOT_FOUND", "领取记录不存在", 404);
  }
  await db
    .update(catalogGrants)
    .set({
      status: result,
      importedAt: result === "imported" ? nowISO() : grant.importedAt,
      appVersion: params.appVersion ?? grant.appVersion,
    })
    .where(eq(catalogGrants.grantId, params.grantId));
}

export type { CatalogGrant, CatalogModel };
