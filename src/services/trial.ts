/**
 * One-time trial licence grants.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import { activationLogs, activations, plans, products, telemetryEvents, trialGrants } from "../db/schema";
import { telemetryMachineHashFromFingerprint } from "./activation";
import { createAuthInfo } from "../licence/auth_info";
import { issueLicence } from "../licence/codec";
import { ActivationError, machineIdentityFromFingerprint, nowISO } from "./activation";
import { parsePlanFeatures } from "./plan_features";

const DEFAULT_TRIAL_GRANT_FEATURE = "trial";
const LEGACY_TRIAL_GRANT_FEATURE = "import_vrm";

type TrialGrant = typeof trialGrants.$inferSelect;
type Product = typeof products.$inferSelect;
type Plan = typeof plans.$inferSelect;

export type TrialResponse = {
  licence: string;
  trial: TrialPayload & {
    status: "active";
    code: "TRIAL_STARTED" | "TRIAL_ACTIVE";
  };
};

type TrialPayload = {
  trial_id: string;
  product_id: string;
  plan_id: string | null;
  plan_name: string | null;
  feature: string;
  features: string[];
  started_at: string;
  valid_until: string;
  duration_seconds: number;
};

function dateToISOSeconds(date: Date): string {
  return date.toISOString().replace("T", " ").substring(0, 19);
}

function wireTimestamp(value: string): string {
  return value.includes("T") ? value : value.replace(" ", "T") + "Z";
}

function parseDbDate(value: string): Date {
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return new Date(normalized);
}

function unixSeconds(value: string): number {
  return Math.floor(parseDbDate(value).getTime() / 1000);
}

function isExpired(grant: TrialGrant, now = new Date()): boolean {
  return parseDbDate(grant.validUntil).getTime() <= now.getTime();
}

function randomTrialId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `trial_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fingerprintHash(
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<string> {
  const machineIdentity = await machineIdentityFromFingerprint(fingerprint);
  const stableFingerprint = machineIdentity
    ? `${machineIdentity.kind}:${machineIdentity.value}`
    : fingerprint;
  return sha256Hex(`${config.trialFingerprintSalt}:${productId}:${stableFingerprint}`);
}

async function rawFingerprintHash(
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<string> {
  return sha256Hex(`${config.trialFingerprintSalt}:${productId}:${fingerprint}`);
}

async function legacyFingerprintHash(
  config: AppConfig,
  productId: string,
  feature: string,
  fingerprint: string
): Promise<string> {
  return sha256Hex(`${config.trialFingerprintSalt}:${productId}:${feature}:${fingerprint}`);
}

/**
 * Every fingerprint-hash formula the trial system has ever used to key grants.
 * A machine's grant may have been written under any of them, so lookups that
 * start from a machine identity (or a raw fingerprint) must match them all.
 */
async function trialFingerprintHashCandidates(
  config: AppConfig,
  productId: string,
  fingerprint: string
): Promise<string[]> {
  const values = [
    await fingerprintHash(config, productId, fingerprint),
    await rawFingerprintHash(config, productId, fingerprint),
    await legacyFingerprintHash(config, productId, DEFAULT_TRIAL_GRANT_FEATURE, fingerprint),
    await legacyFingerprintHash(config, productId, LEGACY_TRIAL_GRANT_FEATURE, fingerprint),
  ];
  return Array.from(new Set(values));
}

async function ipHash(config: AppConfig, ipAddress: string): Promise<string> {
  return sha256Hex(`${config.trialFingerprintSalt}:ip:${ipAddress}`);
}

async function writeTrialLog(
  db: Database,
  params: {
    trialId: string | null;
    fingerprintHash: string | null;
    action: string;
    ipAddress: string;
    responseCode: number;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  await db.insert(activationLogs).values({
    licenseKey: null,
    entitlementId: null,
    fingerprint: params.fingerprintHash,
    action: params.action,
    ipAddress: params.ipAddress,
    responseCode: params.responseCode,
    detail: JSON.stringify({
      trial_id: params.trialId,
      ...(params.detail || {}),
    }),
  });
}

async function loadProduct(
  db: Database,
  productId: string
): Promise<Product> {
  const product = await db.select().from(products).where(eq(products.productId, productId)).get();
  if (!product) {
    throw new ActivationError("TRIAL_PRODUCT_MISMATCH", "试用产品不存在", 400);
  }
  if (product.status !== "active") {
    throw new ActivationError("PRODUCT_INACTIVE", "产品已停用", 403);
  }
  return product;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function planFeatures(plan: Plan): string[] {
  return parsePlanFeatures(plan.featuresJson);
}

function planDurationSeconds(plan: Plan, fallbackSeconds: number): number {
  const metadata = parseJsonObject(plan.metadataJson);
  const metadataSeconds = Number(metadata.duration_seconds);
  if (Number.isFinite(metadataSeconds) && metadataSeconds > 0) {
    return Math.floor(metadataSeconds);
  }
  if (plan.durationDays && plan.durationDays > 0) {
    return plan.durationDays * 86400;
  }
  return fallbackSeconds;
}

async function loadTrialPlan(
  db: Database,
  productId: string
): Promise<Plan> {
  const candidates = await db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.productId, productId),
        eq(plans.billingModel, "trial"),
        eq(plans.isActive, true)
      )
    )
    .all();

  if (candidates.length !== 1) {
    throw new ActivationError(
      "TRIAL_UNAVAILABLE",
      candidates.length === 0
        ? "当前产品未配置可用的试用套餐"
        : "当前产品配置了多个可用试用套餐",
      200
    );
  }

  return candidates[0];
}

async function issueTrialLicence(
  config: AppConfig,
  plan: Plan,
  grant: TrialGrant,
  fingerprint: string
): Promise<string> {
  const auth = createAuthInfo({
    productId: plan.productId,
    edition: plan.edition,
    tier: plan.tier,
    features: planFeatures(plan),
    maxAppMajor: plan.maxAppMajor,
    validDay: 0,
    validUntil: unixSeconds(grant.validUntil),
    licenceKind: "trial",
  });

  return issueLicence(fingerprint, auth, config.rsaPrivateKeyPkcs8Hex);
}

async function updateLicenceTokenHash(
  db: Database,
  grantId: string,
  licence: string
): Promise<void> {
  await db
    .update(trialGrants)
    .set({ licenceTokenHash: await sha256Hex(licence), updatedAt: nowISO() })
    .where(eq(trialGrants.id, grantId));
}

function responseFromGrant(licence: string, grant: TrialGrant, plan: Plan, code: "TRIAL_STARTED" | "TRIAL_ACTIVE"): TrialResponse {
  return {
    licence,
    trial: {
      ...trialPayload(grant, plan),
      status: "active",
      code,
    },
  };
}

function trialPayload(grant: TrialGrant, plan: Plan): TrialPayload {
  return {
    trial_id: grant.id,
    product_id: grant.productId,
    plan_id: grant.planId || plan.planId,
    plan_name: plan.name,
    feature: grant.feature,
    features: planFeatures(plan),
    started_at: wireTimestamp(grant.startedAt),
    valid_until: wireTimestamp(grant.validUntil),
    duration_seconds: grant.durationSeconds,
  };
}

export async function startTrial(
  db: Database,
  config: AppConfig,
  params: {
    productId?: string | null;
    fingerprint: string;
    appVersion: string | null;
    platform: string | null;
    ipAddress: string;
  }
): Promise<TrialResponse> {
  if (!config.trialEnabled) {
    throw new ActivationError("TRIAL_UNAVAILABLE", "试用暂不可用", 200);
  }

  const productId = (params.productId || config.defaultProductId).trim();
  const fingerprint = params.fingerprint.trim();

  if (!productId) {
    throw new ActivationError("INVALID_REQUEST", "product_id 不能为空", 400);
  }
  if (!fingerprint) {
    throw new ActivationError("INVALID_REQUEST", "fingerprint 不能为空", 400);
  }

  await loadProduct(db, productId);
  const trialPlan = await loadTrialPlan(db, productId);
  const grantFeature = DEFAULT_TRIAL_GRANT_FEATURE;

  const durationSeconds = Math.max(
    60,
    planDurationSeconds(trialPlan, config.trialFullFeatureDurationSeconds || 86400)
  );
  const fpHash = await fingerprintHash(config, productId, fingerprint);
  const candidateHashes = await trialFingerprintHashCandidates(config, productId, fingerprint);
  const legacyFpHashes = new Set(candidateHashes.filter((hash) => hash !== fpHash));
  const now = new Date();

  const grants = await db
    .select()
    .from(trialGrants)
    .where(
      and(
        eq(trialGrants.productId, productId),
        inArray(trialGrants.fingerprintHash, candidateHashes)
      )
    )
    .all();
  let grant = grants.find((row) =>
    row.fingerprintHash === fpHash || legacyFpHashes.has(row.fingerprintHash)
  );

  if (grant) {
    const matchedHash = grant.fingerprintHash;
    if (isExpired(grant, now)) {
      if (grant.status !== "expired") {
        await db
          .update(trialGrants)
          .set({ status: "expired", updatedAt: nowISO() })
          .where(eq(trialGrants.id, grant.id));
      }
      await writeTrialLog(db, {
        trialId: grant.id,
        fingerprintHash: matchedHash,
        action: "trial_already_used",
        ipAddress: params.ipAddress,
        responseCode: 409,
        detail: {
          product_id: productId,
          plan_id: grant.planId || trialPlan.planId,
          feature: grant.feature,
          started_at: wireTimestamp(grant.startedAt),
          valid_until: wireTimestamp(grant.validUntil),
        },
      });
      throw new ActivationError(
        "TRIAL_ALREADY_USED",
        "此设备的免费试用已结束",
        409,
        {
          trial: {
            ...trialPayload(grant, trialPlan),
            status: "expired",
            code: "TRIAL_ALREADY_USED",
          },
        }
      );
    }

    const licence = await issueTrialLicence(config, trialPlan, grant, fingerprint);
    await updateLicenceTokenHash(db, grant.id, licence);
    await writeTrialLog(db, {
      trialId: grant.id,
      fingerprintHash: matchedHash,
      action: "trial_active",
      ipAddress: params.ipAddress,
      responseCode: 200,
      detail: {
        product_id: productId,
        plan_id: grant.planId || trialPlan.planId,
        feature: grant.feature,
        app_version: params.appVersion,
        platform: params.platform,
      },
    });
    return responseFromGrant(licence, grant, trialPlan, "TRIAL_ACTIVE");
  }

  const startedAt = dateToISOSeconds(now);
  const validUntil = dateToISOSeconds(new Date(now.getTime() + durationSeconds * 1000));
  const trialId = randomTrialId();

  await db.insert(trialGrants).values({
    id: trialId,
    productId,
    planId: trialPlan.planId,
    feature: grantFeature,
    fingerprintHash: fpHash,
    startedAt,
    validUntil,
    durationSeconds,
    status: "active",
    appVersion: params.appVersion,
    platform: params.platform,
    ipHash: await ipHash(config, params.ipAddress),
    telemetryMachineHash: await telemetryMachineHashFromFingerprint(fingerprint),
  });

  grant = await db.select().from(trialGrants).where(eq(trialGrants.id, trialId)).get();
  if (!grant) {
    throw new ActivationError("SERVER_ERROR", "读取试用记录失败", 500);
  }

  const licence = await issueTrialLicence(config, trialPlan, grant, fingerprint);
  await updateLicenceTokenHash(db, trialId, licence);
  await writeTrialLog(db, {
    trialId,
    fingerprintHash: fpHash,
    action: "trial_start_success",
    ipAddress: params.ipAddress,
    responseCode: 200,
    detail: {
      product_id: productId,
      plan_id: trialPlan.planId,
      feature: grantFeature,
      app_version: params.appVersion,
      platform: params.platform,
    },
  });

  return responseFromGrant(licence, grant, trialPlan, "TRIAL_STARTED");
}

export async function listTrialGrants(
  db: Database,
  config: AppConfig,
  params: { page?: number; pageSize?: number; status?: string; search?: string; productId?: string }
): Promise<{ items: Array<TrialGrant & { product: Product | null; plan: Plan | null }>; total: number }> {
  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const all = await db.select().from(trialGrants).orderBy(desc(trialGrants.createdAt)).all();

  // Products/plans are small dimension tables. Enrich from two full-table reads
  // instead of per-grant lookups: the N+1 pattern issues 2 D1 queries per grant,
  // which crosses the Workers subrequest limit (~500 grants) and 500s the page.
  const [productRows, planRows] = await Promise.all([
    db.select().from(products).all(),
    db.select().from(plans).all(),
  ]);
  const productById = new Map(productRows.map((p) => [p.productId, p]));
  const planById = new Map(planRows.map((p) => [p.planId, p]));

  const enriched = all.map((grant) => ({
    ...grant,
    product: productById.get(grant.productId) || null,
    plan: grant.planId ? planById.get(grant.planId) || null : null,
  }));

  let filtered = enriched;
  if (params.status) filtered = filtered.filter((x) => x.status === params.status);
  if (params.productId) filtered = filtered.filter((x) => x.productId === params.productId);
  if (params.search) {
    const term = params.search.trim();
    const s = term.toUpperCase();

    // Install ids only exist on telemetry rows. Resolve a pasted install id to
    // the machine hashes reported by that install, then match grants through
    // telemetry_machine_hash (the same value the client sends as machine_hash).
    const installMachineHashes = new Set(
      (
        await db
          .selectDistinct({ machineHash: telemetryEvents.machineHash })
          .from(telemetryEvents)
          .where(sql`lower(${telemetryEvents.installId}) = ${term.toLowerCase()}`)
          .all()
      )
        .map((row) => row.machineHash)
        .filter((hash): hash is string => !!hash)
    );

    // Grants created before telemetry_machine_hash existed (migration 0009)
    // store NULL there, so a machine hash alone cannot match them. Machines
    // that later activated a paid licence have an activations row holding the
    // raw fingerprint blob — recompute every historical fingerprint-hash
    // formula from it and match old grants by fingerprint_hash.
    const machineHashes = new Set(installMachineHashes);
    if (/^[0-9a-f]{64}$/.test(term)) machineHashes.add(term.toLowerCase());
    const fingerprintHashCandidates = new Set<string>();
    if (machineHashes.size > 0) {
      const grantProductIds = Array.from(new Set(enriched.map((x) => x.productId)));
      const activationRows = await db
        .selectDistinct({ fingerprint: activations.fingerprint })
        .from(activations)
        .where(inArray(activations.telemetryMachineHash, Array.from(machineHashes)))
        .all();
      for (const activation of activationRows) {
        for (const productId of grantProductIds) {
          for (const hash of await trialFingerprintHashCandidates(
            config,
            productId,
            activation.fingerprint
          )) {
            fingerprintHashCandidates.add(hash);
          }
        }
      }
    }

    filtered = filtered.filter(
      (x) =>
        x.id.toUpperCase().includes(s) ||
        x.feature.toUpperCase().includes(s) ||
        (x.product?.name || "").toUpperCase().includes(s) ||
        (x.plan?.name || "").toUpperCase().includes(s) ||
        (x.planId || "").toUpperCase().includes(s) ||
        x.fingerprintHash.toUpperCase().includes(s) ||
        (x.telemetryMachineHash || "").toUpperCase().includes(s) ||
        (!!x.telemetryMachineHash && installMachineHashes.has(x.telemetryMachineHash)) ||
        fingerprintHashCandidates.has(x.fingerprintHash) ||
        (x.appVersion || "").toUpperCase().includes(s) ||
        (x.platform || "").toUpperCase().includes(s)
    );
  }

  const total = filtered.length;
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total };
}

export async function deleteTrialGrant(db: Database, trialId: string): Promise<void> {
  const grant = await db.select().from(trialGrants).where(eq(trialGrants.id, trialId)).get();
  if (!grant) {
    throw new ActivationError("TRIAL_NOT_FOUND", "试用记录不存在", 404);
  }

  await db.delete(trialGrants).where(eq(trialGrants.id, trialId));
}
