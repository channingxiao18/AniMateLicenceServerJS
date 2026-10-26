/**
 * Pricing-offer campaign service (docs/plans/pricing-offer-discount-experiment-plan.md v3).
 *
 * Responsibilities:
 * - campaign / arm / code-pool management;
 * - deterministic per-machine arm assignment (recorded before claim, so the
 *   per-arm denominator is a randomized cohort);
 * - eligibility (campaign status, activation, install age, active days);
 * - idempotent claim: one unique Creem discount per machine;
 * - redemption sync (`redeem_count`) and the per-arm report.
 *
 * Deliberately no interactive transactions: D1 has none. Every state change is
 * a single conditional statement guarded by a unique index; races fall back to
 * "read the winner's row".
 */

import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  activations,
  pricingOfferArms,
  pricingOfferAssignments,
  pricingOfferCampaigns,
  pricingOfferClaims,
  pricingOfferCodes,
  telemetryEvents,
  telemetryInstallProfile,
} from "../db/schema";
import { ActivationError } from "./activation";
import {
  createDiscount,
  deleteDiscount,
  searchDiscounts,
  type CreemConfig,
  type CreemDiscount,
} from "./creem";

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

const MAX_POOL_PER_REQUEST = 20;
const MAX_SYNC_PAGES = 20;
const MAX_CODE_ATTEMPTS = 5;
const MACHINE_HASH_RE = /^[0-9a-f]{64}$/i;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,63}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const TOUCHPOINTS = new Set([
  "review_window",
  "feature_recall",
  "paywall_winback",
  "settings",
]);
const STAGES = new Set(["first", "second", "winback"]);

export type PricingOfferCampaign = typeof pricingOfferCampaigns.$inferSelect;
export type PricingOfferArm = typeof pricingOfferArms.$inferSelect;
export type PricingOfferCode = typeof pricingOfferCodes.$inferSelect;
export type PricingOfferClaim = typeof pricingOfferClaims.$inferSelect;

export interface CreateCampaignInput {
  campaignId?: string;
  name: string;
  productId?: string;
  creemProductId?: string;
  appliesToProducts?: string[];
  minInstallHours?: number;
  minActiveDays?: number;
  codeExpiryDays?: number;
  priceCents?: number;
  currency?: string;
  maxImpressions?: number;
  impressionCooldownDays?: number;
  purchaseBaseUrl?: string;
  arms: Array<{ label: string; discountPercent: number; weight?: number }>;
  actor?: string;
  ipAddress?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  campaign_id: string | null;
  reason: string;
  intent_tier: number | null;
  min_install_hours: number | null;
  already_claimed: boolean;
  license_state: "active" | "none" | "unknown";
  install_age_hours: number | null;
  active_days: number | null;
  max_impressions: number | null;
  impression_cooldown_days: number | null;
}

export interface ClaimResult {
  status: "issued" | "already_issued" | "not_eligible" | "pool_empty";
  reason?: string;
  claim_id?: string;
  code?: string;
  arm?: string;
  discount_percent?: number;
  expires_at?: string | null;
  purchase_url?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(error: string, message: string, statusCode = 400, details?: Record<string, unknown>): never {
  throw new ActivationError(error, message, statusCode, details);
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function normalizeMachineHash(raw: unknown): string {
  if (typeof raw !== "string") fail("INVALID_MACHINE_HASH", "machine_hash 必须是字符串");
  const value = raw.trim().toLowerCase();
  if (!MACHINE_HASH_RE.test(value)) fail("INVALID_MACHINE_HASH", "machine_hash 必须是 64 位十六进制");
  return value;
}

function optionalString(value: unknown, field: string, maxLen: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail("INVALID_REQUEST", `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) fail("INVALID_REQUEST", `${field} 不能超过 ${maxLen} 个字符`);
  return trimmed;
}

function optionalInt(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail("INVALID_REQUEST", `${field} 必须是非负整数`);
  return n;
}

function isoDaysFromNow(days: number): string {
  const ms = Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function creemConfig(config: AppConfig): CreemConfig {
  const apiKey = (config.creemDiscountsApiKey || "").trim();
  if (!apiKey) {
    fail(
      "PRICING_OFFER_CREEM_KEY_MISSING",
      "未配置 CREEM_DISCOUNTS_API_KEY（需要 discounts 读写权限的 Creem key）",
      503
    );
  }
  return { apiKey, testMode: config.creemTestMode };
}

function randomCode(prefix: string, discountPercent: number): string {
  const armTag = String(discountPercent).replace(/[^0-9A-Z]/gi, "").slice(0, 2) || "X";
  let suffix = "";
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) suffix += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${prefix}-${armTag}-${suffix}`;
}

async function bucketFor(campaignId: string, machineHash: string): Promise<number> {
  const data = new TextEncoder().encode(`${campaignId}:${machineHash}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return ((bytes[0] << 8) | bytes[1]) % 100;
}

function pickArm(arms: PricingOfferArm[], bucket: number): PricingOfferArm {
  const total = arms.reduce((sum, arm) => sum + Math.max(0, arm.weight), 0) || arms.length;
  let cumulative = 0;
  for (const arm of arms) {
    cumulative += Math.max(0, arm.weight) || 1;
    if (bucket < (cumulative * 100) / total) return arm;
  }
  return arms[arms.length - 1];
}

function parseProductIds(campaign: PricingOfferCampaign): string[] {
  try {
    const parsed = JSON.parse(campaign.appliesToProductsJson);
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    // fall through
  }
  return [campaign.creemProductId].filter(Boolean);
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function purchaseUrl(
  config: AppConfig,
  campaign: PricingOfferCampaign,
  claim: { claimId: string; code: string; armId: string }
): string {
  const base = (campaign.purchaseBaseUrl || config.pricingOfferPurchaseBaseUrl || "https://getanimate.app/buy").trim();
  try {
    const url = new URL(base);
    url.searchParams.set("code", claim.code);
    url.searchParams.set("claim", claim.claimId);
    url.searchParams.set("arm", claim.armId);
    return url.toString();
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------------------
// Campaign / arm reads
// ---------------------------------------------------------------------------

export async function listCampaigns(db: Database): Promise<Array<
  PricingOfferCampaign & { arms: PricingOfferArm[] }
>> {
  const campaigns = await db
    .select()
    .from(pricingOfferCampaigns)
    .orderBy(desc(pricingOfferCampaigns.createdAt))
    .all();
  if (campaigns.length === 0) return [];
  const arms = await db
    .select()
    .from(pricingOfferArms)
    .where(inArray(pricingOfferArms.campaignId, campaigns.map((c) => c.campaignId)))
    .all();
  return campaigns.map((campaign) => ({
    ...campaign,
    arms: arms.filter((arm) => arm.campaignId === campaign.campaignId),
  }));
}

export async function getCampaign(
  db: Database,
  campaignId: string
): Promise<{ campaign: PricingOfferCampaign; arms: PricingOfferArm[] } | null> {
  const campaign = await db
    .select()
    .from(pricingOfferCampaigns)
    .where(eq(pricingOfferCampaigns.campaignId, campaignId))
    .limit(1)
    .get();
  if (!campaign) return null;
  const arms = await db
    .select()
    .from(pricingOfferArms)
    .where(eq(pricingOfferArms.campaignId, campaignId))
    .all();
  return { campaign, arms };
}

/**
 * Resolve the requested campaign, or the one configured as current, or the
 * newest active one. This is what lets the client omit campaign_id.
 */
export async function resolveCampaign(
  db: Database,
  config: AppConfig,
  campaignId?: string | null
): Promise<PricingOfferCampaign | null> {
  const explicit = campaignId || config.pricingOfferCampaignId || "";
  if (explicit) {
    const row = await db
      .select()
      .from(pricingOfferCampaigns)
      .where(eq(pricingOfferCampaigns.campaignId, explicit))
      .limit(1)
      .get();
    return row ?? null;
  }
  const row = await db
    .select()
    .from(pricingOfferCampaigns)
    .where(eq(pricingOfferCampaigns.status, "active"))
    .orderBy(desc(pricingOfferCampaigns.createdAt))
    .limit(1)
    .get();
  return row ?? null;
}

export async function createCampaign(
  db: Database,
  config: AppConfig,
  input: CreateCampaignInput
): Promise<{ campaign_id: string; arms: string[] }> {
  const name = (input.name || "").trim();
  if (!name) fail("INVALID_REQUEST", "name 不能为空");
  const arms = Array.isArray(input.arms) ? input.arms : [];
  if (arms.length < 2) fail("INVALID_REQUEST", "至少需要 2 个档位");
  if (arms.length > 6) fail("INVALID_REQUEST", "档位最多 6 个");
  for (const arm of arms) {
    if (!arm.label || !String(arm.label).trim()) fail("INVALID_REQUEST", "档位 label 不能为空");
    const pct = Number(arm.discountPercent);
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
      fail("INVALID_REQUEST", "discountPercent 必须是 1~99 的整数");
    }
  }

  const campaignId =
    (input.campaignId || "").trim() ||
    `cmp_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  const existing = await db
    .select({ id: pricingOfferCampaigns.campaignId })
    .from(pricingOfferCampaigns)
    .where(eq(pricingOfferCampaigns.campaignId, campaignId))
    .limit(1)
    .get();
  if (existing) fail("DUPLICATE_CAMPAIGN", "campaign_id 已存在", 409);

  const productId = input.productId || config.defaultProductId;
  const creemProductId = input.creemProductId || config.pricingOfferProductIds[0] || "";
  if (!creemProductId) fail("INVALID_REQUEST", "creemProductId 不能为空");
  const appliesToProducts =
    input.appliesToProducts && input.appliesToProducts.length
      ? input.appliesToProducts
      : config.pricingOfferProductIds.length
        ? config.pricingOfferProductIds
        : [creemProductId];

  await db
    .insert(pricingOfferCampaigns)
    .values({
      campaignId,
      name,
      status: "draft",
      productId,
      creemProductId,
      appliesToProductsJson: JSON.stringify(appliesToProducts),
      minInstallHours: input.minInstallHours ?? 48,
      minActiveDays: input.minActiveDays ?? 2,
      codeExpiryDays: input.codeExpiryDays ?? 7,
      priceCents: input.priceCents ?? 990,
      currency: input.currency || "USD",
      maxImpressions: input.maxImpressions ?? 2,
      impressionCooldownDays: input.impressionCooldownDays ?? 7,
      purchaseBaseUrl: input.purchaseBaseUrl || config.pricingOfferPurchaseBaseUrl,
      metadataJson: null,
    })
    .run();

  const armIds: string[] = [];
  const suffixes = ["a", "b", "c", "d", "e", "f"];
  for (let i = 0; i < arms.length; i += 1) {
    const armId = `${campaignId}:${suffixes[i]}`;
    armIds.push(armId);
    await db
      .insert(pricingOfferArms)
      .values({
        armId,
        campaignId,
        label: String(arms[i].label).trim().slice(0, 32),
        discountPercent: Number(arms[i].discountPercent),
        weight: Math.max(1, Math.min(100, Number(arms[i].weight ?? 25))),
        poolTarget: 0,
      })
      .run();
  }

  return { campaign_id: campaignId, arms: armIds };
}

export async function setCampaignStatus(
  db: Database,
  campaignId: string,
  status: "draft" | "active" | "paused" | "ended"
): Promise<void> {
  if (!["draft", "active", "paused", "ended"].includes(status)) {
    fail("INVALID_REQUEST", "status 不受支持");
  }
  const now = nowIso();
  await db
    .update(pricingOfferCampaigns)
    .set({
      status,
      updatedAt: now,
      ...(status === "active" ? { startedAt: sql`coalesce(${pricingOfferCampaigns.startedAt}, ${now})` } : {}),
      ...(status === "ended" ? { endedAt: now } : {}),
    })
    .where(eq(pricingOfferCampaigns.campaignId, campaignId))
    .run();
}

// ---------------------------------------------------------------------------
// Assignment / eligibility
// ---------------------------------------------------------------------------

async function isLicensed(db: Database, machineHash: string): Promise<boolean> {
  const row = await db
    .select({ id: activations.id })
    .from(activations)
    .where(and(eq(activations.telemetryMachineHash, machineHash), eq(activations.status, "active")))
    .limit(1)
    .get();
  return Boolean(row);
}

interface InstallStats {
  installAgeHours: number;
  activeDays: number;
}

async function installStats(db: Database, machineHash: string): Promise<InstallStats | null> {
  const profile = await db
    .select({
      installAt: telemetryInstallProfile.installAt,
      activeDays: telemetryInstallProfile.activeDays,
    })
    .from(telemetryInstallProfile)
    .where(eq(telemetryInstallProfile.machineHash, machineHash))
    .orderBy(desc(telemetryInstallProfile.installAt))
    .limit(1)
    .get();

  if (profile?.installAt) {
    const started = Date.parse(profile.installAt.replace(" ", "T") + "Z");
    if (Number.isFinite(started)) {
      return {
        installAgeHours: Math.max(0, (Date.now() - started) / 3_600_000),
        activeDays: Number(profile.activeDays ?? 0),
      };
    }
  }

  // Fallback for machines whose profile has not been backfilled yet: use the
  // first telemetry event and count distinct active days directly.
  const first = await db
    .select({ receivedAt: telemetryEvents.receivedAt })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.machineHash, machineHash))
    .orderBy(telemetryEvents.receivedAt)
    .limit(1)
    .get();
  if (!first?.receivedAt) return null;
  const started = Date.parse(first.receivedAt.replace(" ", "T") + "Z");
  const daysRow = await db
    .select({ days: sql<number>`count(distinct date(${telemetryEvents.receivedAt}))` })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.machineHash, machineHash))
    .get();
  return {
    installAgeHours: Number.isFinite(started) ? Math.max(0, (Date.now() - started) / 3_600_000) : 0,
    activeDays: Number(daysRow?.days ?? 0),
  };
}

async function ensureAssignment(
  db: Database,
  campaign: PricingOfferCampaign,
  arms: PricingOfferArm[],
  machineHash: string
): Promise<PricingOfferArm> {
  const existing = await db
    .select({ armId: pricingOfferAssignments.armId })
    .from(pricingOfferAssignments)
    .where(
      and(
        eq(pricingOfferAssignments.campaignId, campaign.campaignId),
        eq(pricingOfferAssignments.machineHash, machineHash)
      )
    )
    .limit(1)
    .get();
  if (existing) {
    const arm = arms.find((candidate) => candidate.armId === existing.armId);
    if (arm) return arm;
  }

  const bucket = await bucketFor(campaign.campaignId, machineHash);
  const arm = pickArm(arms, bucket);
  await db
    .insert(pricingOfferAssignments)
    .values({
      campaignId: campaign.campaignId,
      machineHash,
      armId: arm.armId,
      assignedAt: nowIso(),
    })
    .onConflictDoNothing()
    .run();

  const row = await db
    .select({ armId: pricingOfferAssignments.armId })
    .from(pricingOfferAssignments)
    .where(
      and(
        eq(pricingOfferAssignments.campaignId, campaign.campaignId),
        eq(pricingOfferAssignments.machineHash, machineHash)
      )
    )
    .limit(1)
    .get();
  const resolved = arms.find((candidate) => candidate.armId === row?.armId);
  return resolved ?? arm;
}

async function computeIntentTier(db: Database, machineHash: string): Promise<number> {
  const rows = await db
    .select({ event: telemetryEvents.event })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.machineHash, machineHash))
    .orderBy(desc(telemetryEvents.receivedAt))
    .limit(200)
    .all();
  const events = new Set(rows.map((row) => row.event));
  if (events.has("purchase_clicked") || events.has("checkout_opened") || events.has("purchase_failed")) {
    return 4;
  }
  if (
    events.has("model_import_completed") ||
    events.has("catalog_model_imported") ||
    events.has("dance_started") ||
    events.has("chat_reply_received") ||
    events.has("voice_session_started")
  ) {
    return 3;
  }
  if (events.has("license_reminder_shown") || events.has("chat_setup_card_shown")) return 2;
  return 1;
}

export interface EligibilityRequest {
  machineHash: string;
  campaignId: string | null;
}

export function validateEligibilityBody(body: unknown): EligibilityRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("INVALID_JSON", "请求体格式无效");
  }
  const raw = body as Record<string, unknown>;
  const machineHash = normalizeMachineHash(raw.machine_hash);
  const campaignId = optionalString(raw.campaign_id, "campaign_id", 128);
  return { machineHash, campaignId };
}

export async function getEligibility(
  db: Database,
  config: AppConfig,
  request: EligibilityRequest
): Promise<EligibilityResult> {
  const campaign = await resolveCampaign(db, config, request.campaignId);
  if (!campaign) {
    return {
      eligible: false,
      campaign_id: null,
      reason: "campaign_not_found",
      intent_tier: null,
      min_install_hours: null,
      already_claimed: false,
      license_state: "unknown",
      install_age_hours: null,
      active_days: null,
      max_impressions: null,
      impression_cooldown_days: null,
    };
  }

  const base = {
    campaign_id: campaign.campaignId,
    intent_tier: null as number | null,
    min_install_hours: campaign.minInstallHours,
    already_claimed: false,
    license_state: "none" as "active" | "none" | "unknown",
    install_age_hours: null as number | null,
    active_days: null as number | null,
    max_impressions: campaign.maxImpressions,
    impression_cooldown_days: campaign.impressionCooldownDays,
  };

  if (campaign.status !== "active") {
    return { ...base, eligible: false, reason: "campaign_paused" };
  }

  if (await isLicensed(db, request.machineHash)) {
    return { ...base, eligible: false, reason: "licensed", license_state: "active" };
  }

  const existingClaim = await db
    .select({ claimId: pricingOfferClaims.claimId })
    .from(pricingOfferClaims)
    .where(
      and(
        eq(pricingOfferClaims.campaignId, campaign.campaignId),
        eq(pricingOfferClaims.machineHash, request.machineHash)
      )
    )
    .limit(1)
    .get();
  if (existingClaim) {
    return { ...base, eligible: false, reason: "already_claimed", already_claimed: true };
  }

  const stats = await installStats(db, request.machineHash);
  if (!stats) {
    return { ...base, eligible: false, reason: "unknown_machine", license_state: "unknown" };
  }

  const installAgeHours = Math.floor(stats.installAgeHours);
  const activeDays = Math.floor(stats.activeDays);
  const withStats = { ...base, install_age_hours: installAgeHours, active_days: activeDays };

  if (stats.installAgeHours < campaign.minInstallHours) {
    return { ...withStats, eligible: false, reason: "install_too_new" };
  }
  if (stats.activeDays < campaign.minActiveDays) {
    return { ...withStats, eligible: false, reason: "not_active_enough" };
  }

  const { arms } = (await getCampaign(db, campaign.campaignId)) ?? { arms: [] };
  if (arms.length === 0) {
    return { ...withStats, eligible: false, reason: "no_arms" };
  }

  // Assign here, before the user claims: the per-arm denominator becomes the
  // randomized cohort, not the self-selected claimants.
  await ensureAssignment(db, campaign, arms, request.machineHash);
  const intentTier = await computeIntentTier(db, request.machineHash);
  return { ...withStats, eligible: true, reason: "ok", intent_tier: intentTier };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimRequest {
  campaignId: string | null;
  machineHash: string;
  touchpoint: string;
  stage: string;
  appVersion: string | null;
  channel: string | null;
  locale: string | null;
  intentTier: number | null;
  installAgeHours: number | null;
  activeDays: number | null;
}

export function validateClaimBody(body: unknown): ClaimRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("INVALID_JSON", "请求体格式无效");
  }
  const raw = body as Record<string, unknown>;
  const machineHash = normalizeMachineHash(raw.machine_hash);
  const touchpoint = optionalString(raw.touchpoint, "touchpoint", 32) || "feature_recall";
  if (!TOUCHPOINTS.has(touchpoint)) fail("INVALID_TOUCHPOINT", "touchpoint 不受支持");
  const stage = optionalString(raw.stage, "stage", 16) || "first";
  if (!STAGES.has(stage)) fail("INVALID_STAGE", "stage 不受支持");
  return {
    campaignId: optionalString(raw.campaign_id, "campaign_id", 128),
    machineHash,
    touchpoint,
    stage,
    appVersion: optionalString(raw.app_version, "app_version", 64),
    channel: optionalString(raw.channel, "channel", 32),
    locale: optionalString(raw.locale, "locale", 32),
    intentTier: optionalInt(raw.intent_tier, "intent_tier"),
    installAgeHours: optionalInt(raw.install_age_hours, "install_age_hours"),
    activeDays: optionalInt(raw.active_days, "active_days"),
  };
}

function claimResponse(
  config: AppConfig,
  campaign: PricingOfferCampaign,
  arm: PricingOfferArm,
  claim: PricingOfferClaim,
  status: "issued" | "already_issued",
  expiresAt: string | null
): ClaimResult {
  return {
    status,
    claim_id: claim.claimId,
    code: claim.code,
    arm: arm.armId,
    discount_percent: arm.discountPercent,
    expires_at: expiresAt,
    purchase_url: purchaseUrl(config, campaign, {
      claimId: claim.claimId,
      code: claim.code,
      armId: arm.armId,
    }),
  };
}

async function codeExpiry(
  db: Database,
  code: string
): Promise<string | null> {
  const row = await db
    .select({ expiresAt: pricingOfferCodes.expiresAt })
    .from(pricingOfferCodes)
    .where(eq(pricingOfferCodes.code, code))
    .limit(1)
    .get();
  return row?.expiresAt ?? null;
}

async function existingClaim(
  db: Database,
  campaignId: string,
  machineHash: string
): Promise<PricingOfferClaim | null> {
  return (
    (await db
      .select()
      .from(pricingOfferClaims)
      .where(
        and(
          eq(pricingOfferClaims.campaignId, campaignId),
          eq(pricingOfferClaims.machineHash, machineHash)
        )
      )
      .limit(1)
      .get()) ?? null
  );
}

async function nextAvailableCode(
  db: Database,
  campaignId: string,
  armId: string
): Promise<PricingOfferCode | null> {
  return (
    (await db
      .select()
      .from(pricingOfferCodes)
      .where(
        and(
          eq(pricingOfferCodes.campaignId, campaignId),
          eq(pricingOfferCodes.armId, armId),
          eq(pricingOfferCodes.status, "available"),
          // A code that sat in the pool past its Creem expiry must never be
          // issued; it would fail at checkout and look like a broken offer.
          gt(pricingOfferCodes.expiresAt, nowIso())
        )
      )
      .orderBy(pricingOfferCodes.createdAt)
      .limit(1)
      .get()) ?? null
  );
}

async function createCode(
  db: Database,
  config: AppConfig,
  campaign: PricingOfferCampaign,
  arm: PricingOfferArm,
  expiryDays: number
): Promise<PricingOfferCode> {
  const creem = creemConfig(config);
  const products = parseProductIds(campaign);
  const prefix = (parseMetadata(campaign.metadataJson).code_prefix as string) || "ANIM";
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = randomCode(prefix, arm.discountPercent);
    const taken = await db
      .select({ code: pricingOfferCodes.code })
      .from(pricingOfferCodes)
      .where(eq(pricingOfferCodes.code, code))
      .limit(1)
      .get();
    if (taken) continue;

    try {
      const discount = await createDiscount(creem, {
        name: `AniMate ${arm.label} - ${campaign.campaignId}`,
        code,
        percentage: arm.discountPercent,
        appliesToProducts: products,
        expiryDate: isoDaysFromNow(expiryDays),
        maxRedemptions: 1,
      });
      const row: typeof pricingOfferCodes.$inferInsert = {
        code,
        campaignId: campaign.campaignId,
        armId: arm.armId,
        creemDiscountId: discount.id,
        status: "available",
        expiresAt: discount.expiry_date ?? isoDaysFromNow(expiryDays),
        redeemCount: 0,
        createdAt: nowIso(),
      };
      await db.insert(pricingOfferCodes).values(row).run();
      const inserted = await db
        .select()
        .from(pricingOfferCodes)
        .where(eq(pricingOfferCodes.code, code))
        .limit(1)
        .get();
      if (!inserted) throw new Error("inserted code disappeared");
      return inserted;
    } catch (err) {
      lastError = err;
      // Code collision is retried; network/permission errors bubble up after
      // the loop so the admin sees a concrete reason.
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) continue;
      break;
    }
  }

  if (lastError instanceof ActivationError) throw lastError;
  if (lastError instanceof Error) fail("PRICING_OFFER_CODE_CREATE_FAILED", lastError.message, 502);
  fail("PRICING_OFFER_CODE_CREATE_FAILED", "无法创建折扣码", 502);
}

async function allocateCode(
  db: Database,
  config: AppConfig,
  campaign: PricingOfferCampaign,
  arm: PricingOfferArm,
  expiryDays: number
): Promise<PricingOfferCode | null> {
  // A pooled code's expiry starts when it was created, not when the user claims
  // it. For short windows ("24h") that difference breaks the promise, so prefer
  // a fresh on-demand code and use the pool only when creation is unavailable.
  if (config.pricingOfferAutoCreateCodes) {
    try {
      return await createCode(db, config, campaign, arm, expiryDays);
    } catch (error) {
      console.warn("[pricing-offer] on-demand code creation failed; using pool", error);
    }
  }
  return nextAvailableCode(db, campaign.campaignId, arm.armId);
}

async function hashAuditIp(ipAddress: string | null): Promise<string | null> {  const raw = (ipAddress || "").trim();
  if (!raw || raw === "unknown") return null;
  const data = new TextEncoder().encode(`pricing-offer-ip-v1:${raw.toLowerCase()}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function claimPricingOffer(
  db: Database,
  config: AppConfig,
  request: ClaimRequest,
  ipAddress: string | null
): Promise<ClaimResult> {
  const campaign = await resolveCampaign(db, config, request.campaignId);
  if (!campaign) return { status: "not_eligible", reason: "campaign_not_found" };
  if (campaign.status !== "active") return { status: "not_eligible", reason: "campaign_paused" };
  if (await isLicensed(db, request.machineHash)) {
    return { status: "not_eligible", reason: "licensed" };
  }

  const prior = await existingClaim(db, campaign.campaignId, request.machineHash);
  const arms = await db
    .select()
    .from(pricingOfferArms)
    .where(eq(pricingOfferArms.campaignId, campaign.campaignId))
    .all();
  if (arms.length === 0) return { status: "not_eligible", reason: "no_arms" };

  if (prior) {
    const arm = arms.find((candidate) => candidate.armId === prior.armId) ?? arms[0];
    return claimResponse(
      config,
      campaign,
      arm,
      prior,
      "already_issued",
      await codeExpiry(db, prior.code)
    );
  }

  const stats = await installStats(db, request.machineHash);
  if (!stats) return { status: "not_eligible", reason: "unknown_machine" };
  if (stats.installAgeHours < campaign.minInstallHours) {
    return { status: "not_eligible", reason: "install_too_new" };
  }
  if (stats.activeDays < campaign.minActiveDays) {
    return { status: "not_eligible", reason: "not_active_enough" };
  }

  const arm = await ensureAssignment(db, campaign, arms, request.machineHash);
  // T3 is a high-intent win-back: a 24h code creates urgency. T1/T2 get the
  // campaign's broader window (recommended 7 days).
  const expiryDays =
    request.touchpoint === "paywall_winback" ? 1 : campaign.codeExpiryDays;
  let code = await allocateCode(db, config, campaign, arm, expiryDays);
  if (!code) return { status: "pool_empty", reason: "pool_empty" };

  const issuedAt = nowIso();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await db
      .update(pricingOfferCodes)
      .set({
        status: "issued",
        issuedToMachineHash: request.machineHash,
        issuedAt,
      })
      .where(and(eq(pricingOfferCodes.code, code.code), eq(pricingOfferCodes.status, "available")))
      .returning()
      .get();
    if (updated) {
      code = updated;
      break;
    }
    // Someone else took this code between the read and the update; pick the
    // next available one (or create one) and retry.
    code = await allocateCode(db, config, campaign, arm, expiryDays);
    if (!code) return { status: "pool_empty", reason: "pool_empty" };
  }

  const claimId = globalThis.crypto.randomUUID();
  const ipHash = await hashAuditIp(ipAddress);
  const claim: typeof pricingOfferClaims.$inferInsert = {
    claimId,
    campaignId: campaign.campaignId,
    armId: arm.armId,
    machineHash: request.machineHash,
    code: code.code,
    touchpoint: request.touchpoint,
    stage: request.stage,
    intentTier: request.intentTier ?? null,
    appVersion: request.appVersion,
    channel: request.channel,
    locale: request.locale,
    installAgeHours: Math.floor(stats.installAgeHours),
    activeDays: Math.floor(stats.activeDays),
    ipHash,
    createdAt: issuedAt,
  };

  try {
    await db.insert(pricingOfferClaims).values(claim).run();
  } catch (err) {
    // Lost the unique(machine) race: return the winner's claim and release the
    // code we just consumed if it differs.
    const winner = await existingClaim(db, campaign.campaignId, request.machineHash);
    if (winner) {
      if (winner.code !== code.code) {
        await db
          .update(pricingOfferCodes)
          .set({ status: "available", issuedToMachineHash: null, issuedAt: null })
          .where(and(eq(pricingOfferCodes.code, code.code), eq(pricingOfferCodes.status, "issued")))
          .run();
      }
      const winnerArm = arms.find((candidate) => candidate.armId === winner.armId) ?? arm;
      return claimResponse(
        config,
        campaign,
        winnerArm,
        winner,
        "already_issued",
        await codeExpiry(db, winner.code)
      );
    }
    throw err;
  }

  const stored: PricingOfferClaim = {
    claimId,
    campaignId: campaign.campaignId,
    armId: arm.armId,
    machineHash: request.machineHash,
    code: code.code,
    touchpoint: request.touchpoint,
    stage: request.stage,
    intentTier: request.intentTier ?? null,
    appVersion: request.appVersion,
    channel: request.channel,
    locale: request.locale,
    installAgeHours: Math.floor(stats.installAgeHours),
    activeDays: Math.floor(stats.activeDays),
    ipHash,
    createdAt: issuedAt,
  };
  return claimResponse(config, campaign, arm, stored, "issued", code.expiresAt ?? null);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getOfferStatus(
  db: Database,
  config: AppConfig,
  machineHash: string,
  campaignId?: string | null
): Promise<Record<string, unknown>> {
  const campaign = await resolveCampaign(db, config, campaignId);
  if (!campaign) return { status: "none", reason: "campaign_not_found" };
  const claim = await existingClaim(db, campaign.campaignId, machineHash);
  if (!claim) return { status: "none", campaign_id: campaign.campaignId };
  const arm = await db
    .select()
    .from(pricingOfferArms)
    .where(eq(pricingOfferArms.armId, claim.armId))
    .limit(1)
    .get();
  const code = await db
    .select()
    .from(pricingOfferCodes)
    .where(eq(pricingOfferCodes.code, claim.code))
    .limit(1)
    .get();
  return {
    status: code?.redeemCount && code.redeemCount > 0 ? "redeemed" : "issued",
    campaign_id: campaign.campaignId,
    claim_id: claim.claimId,
    code: claim.code,
    arm: claim.armId,
    discount_percent: arm?.discountPercent ?? null,
    expires_at: code?.expiresAt ?? null,
    redeemed: Boolean(code?.redeemCount && code.redeemCount > 0),
    purchase_url: purchaseUrl(config, campaign, {
      claimId: claim.claimId,
      code: claim.code,
      armId: claim.armId,
    }),
  };
}

// ---------------------------------------------------------------------------
// Pool management / imports
// ---------------------------------------------------------------------------

export async function generatePool(
  db: Database,
  config: AppConfig,
  campaignId: string,
  armId: string,
  count: number
): Promise<{ created: string[]; failed: Array<{ code: string; error: string }> }> {
  const detail = await getCampaign(db, campaignId);
  if (!detail) fail("CAMPAIGN_NOT_FOUND", "活动不存在", 404);
  const arm = detail.arms.find((candidate) => candidate.armId === armId);
  if (!arm) fail("ARM_NOT_FOUND", "档位不存在", 404);
  const safeCount = Math.max(1, Math.min(MAX_POOL_PER_REQUEST, Math.floor(count) || 1));

  const created: string[] = [];
  const failed: Array<{ code: string; error: string }> = [];
  for (let i = 0; i < safeCount; i += 1) {
    try {
      const row = await createCode(
    db,
    config,
    detail.campaign,
    arm,
    detail.campaign.codeExpiryDays
  );
      created.push(row.code);
    } catch (err) {
      failed.push({
        code: "",
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }
  return { created, failed };
}

export async function importCodes(
  db: Database,
  campaignId: string,
  armId: string,
  rawCodes: string
): Promise<{ imported: number; skipped: number }> {
  const detail = await getCampaign(db, campaignId);
  if (!detail) fail("CAMPAIGN_NOT_FOUND", "活动不存在", 404);
  const arm = detail.arms.find((candidate) => candidate.armId === armId);
  if (!arm) fail("ARM_NOT_FOUND", "档位不存在", 404);

  const codes = rawCodes
    .split(/[\s,;]+/)
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  let imported = 0;
  let skipped = 0;
  for (const code of codes) {
    if (!CODE_RE.test(code)) {
      skipped += 1;
      continue;
    }
    try {
      await db
        .insert(pricingOfferCodes)
        .values({
          code,
          campaignId,
          armId,
          creemDiscountId: `manual:${code}`,
          status: "available",
          expiresAt: isoDaysFromNow(detail.campaign.codeExpiryDays),
          redeemCount: 0,
          createdAt: nowIso(),
        })
        .onConflictDoNothing()
        .run();
      imported += 1;
    } catch {
      skipped += 1;
    }
  }
  return { imported, skipped };
}

export async function listCodes(
  db: Database,
  campaignId: string,
  limit = 200
): Promise<PricingOfferCode[]> {
  return db
    .select()
    .from(pricingOfferCodes)
    .where(eq(pricingOfferCodes.campaignId, campaignId))
    .orderBy(desc(pricingOfferCodes.createdAt))
    .limit(Math.max(1, Math.min(500, limit)))
    .all();
}

export async function voidCode(
  db: Database,
  config: AppConfig,
  code: string
): Promise<{ status: "void" }> {  const row = await db
    .select()
    .from(pricingOfferCodes)
    .where(eq(pricingOfferCodes.code, code))
    .limit(1)
    .get();
  if (!row) fail("CODE_NOT_FOUND", "折扣码不存在", 404);
  if (!row.creemDiscountId.startsWith("manual:")) {
    try {
      await deleteDiscount(creemConfig(config), row.creemDiscountId);
    } catch (err) {
      // A code that Creem already expired/deleted can still be voided locally.
      console.error("Creem delete discount failed:", err);
    }
  }
  await db
    .update(pricingOfferCodes)
    .set({ status: "void" })
    .where(eq(pricingOfferCodes.code, code))
    .run();
  return { status: "void" };
}

// ---------------------------------------------------------------------------
// Redemption sync
// ---------------------------------------------------------------------------

function normalizeCreatedAfter(value: string | null): string {
  if (!value) return new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const parsed = Date.parse(value.replace(" ", "T") + (value.includes("T") ? "" : "Z"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export async function syncRedemptions(
  db: Database,
  config: AppConfig
): Promise<{ campaigns: number; updated: number; failed: number }> {
  const campaigns = await db
    .select()
    .from(pricingOfferCampaigns)
    .where(inArray(pricingOfferCampaigns.status, ["active", "paused", "ended"]))
    .all();
  if (campaigns.length === 0) return { campaigns: 0, updated: 0, failed: 0 };

  let updated = 0;
  let failed = 0;
  for (const campaign of campaigns) {
    const rows = await db
      .select()
      .from(pricingOfferCodes)
      .where(
        and(
          eq(pricingOfferCodes.campaignId, campaign.campaignId),
          inArray(pricingOfferCodes.status, ["issued", "redeemed"])
        )
      )
      .all();
    if (rows.length === 0) continue;

    const wanted = new Set(
      rows
        .filter((row) => !row.creemDiscountId.startsWith("manual:"))
        .map((row) => row.code)
    );
    if (wanted.size === 0) continue;

    try {
      const creem = creemConfig(config);
      const byCode = new Map<string, CreemDiscount>();
      let page = 1;
      for (let i = 0; i < MAX_SYNC_PAGES; i += 1) {
        const result = await searchDiscounts(creem, {
          pageNumber: page,
          pageSize: 100,
          createdAfter: normalizeCreatedAfter(campaign.createdAt),
        });
        for (const item of result.items) {
          if (wanted.has(item.code)) byCode.set(item.code, item);
        }
        const next = result.pagination?.next_page;
        if (!next || next <= page) break;
        page = next;
      }

      const checkedAt = nowIso();
      for (const row of rows) {
        const item = byCode.get(row.code);
        if (!item) continue;
        const redeemCount = Number(item.redeem_count ?? 0);
        await db
          .update(pricingOfferCodes)
          .set({
            redeemCount,
            redeemCheckedAt: checkedAt,
            status: redeemCount > 0 ? "redeemed" : row.status,
          })
          .where(eq(pricingOfferCodes.code, row.code))
          .run();
        updated += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`[pricing-offer] sync ${campaign.campaignId} failed:`, err);
    }
  }
  return { campaigns: campaigns.length, updated, failed };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ArmReport {
  arm_id: string;
  label: string;
  discount_percent: number;
  eligible: number;
  claimed: number;
  codes_total: number;
  issued: number;
  redeemed: number;
  claim_rate: number | null;
  redeem_rate: number | null;
  revenue_cents: number;
  revenue_per_eligible_cents: number | null;
}

export async function getReport(
  db: Database,
  campaignId: string
): Promise<Record<string, unknown>> {
  const detail = await getCampaign(db, campaignId);
  if (!detail) fail("CAMPAIGN_NOT_FOUND", "活动不存在", 404);
  const { campaign, arms } = detail;

  const reports: ArmReport[] = [];
  for (const arm of arms) {
    const eligibleRow = await db
      .select({ n: sql<number>`count(*)` })
      .from(pricingOfferAssignments)
      .where(
        and(
          eq(pricingOfferAssignments.campaignId, campaignId),
          eq(pricingOfferAssignments.armId, arm.armId)
        )
      )
      .get();
    const claimedRow = await db
      .select({ n: sql<number>`count(*)` })
      .from(pricingOfferClaims)
      .where(
        and(
          eq(pricingOfferClaims.campaignId, campaignId),
          eq(pricingOfferClaims.armId, arm.armId)
        )
      )
      .get();
    const codesRow = await db
      .select({
        total: sql<number>`count(*)`,
        issued: sql<number>`sum(case when status in ('issued','redeemed') then 1 else 0 end)`,
        redeemed: sql<number>`sum(case when redeem_count > 0 then 1 else 0 end)`,
      })
      .from(pricingOfferCodes)
      .where(
        and(
          eq(pricingOfferCodes.campaignId, campaignId),
          eq(pricingOfferCodes.armId, arm.armId)
        )
      )
      .get();

    const eligible = Number(eligibleRow?.n ?? 0);
    const claimed = Number(claimedRow?.n ?? 0);
    const redeemed = Number(codesRow?.redeemed ?? 0);
    const unitCents = Math.round((campaign.priceCents * (100 - arm.discountPercent)) / 100);
    reports.push({
      arm_id: arm.armId,
      label: arm.label,
      discount_percent: arm.discountPercent,
      eligible,
      claimed,
      codes_total: Number(codesRow?.total ?? 0),
      issued: Number(codesRow?.issued ?? 0),
      redeemed,
      claim_rate: eligible > 0 ? claimed / eligible : null,
      redeem_rate: claimed > 0 ? redeemed / claimed : null,
      revenue_cents: redeemed * unitCents,
      revenue_per_eligible_cents: eligible > 0 ? (redeemed * unitCents) / eligible : null,
    });
  }

  const touchpoints = await db
    .select({
      touchpoint: pricingOfferClaims.touchpoint,
      n: sql<number>`count(*)`,
    })
    .from(pricingOfferClaims)
    .where(eq(pricingOfferClaims.campaignId, campaignId))
    .groupBy(pricingOfferClaims.touchpoint)
    .all();

  // Per-arm × touchpoint claims: the global `touchpoints` map cannot answer
  // "which arm converts best in T1 vs T2 vs T3".
  const touchpointArms = await db
    .select({
      armId: pricingOfferClaims.armId,
      touchpoint: pricingOfferClaims.touchpoint,
      n: sql<number>`count(*)`,
    })
    .from(pricingOfferClaims)
    .where(eq(pricingOfferClaims.campaignId, campaignId))
    .groupBy(pricingOfferClaims.armId, pricingOfferClaims.touchpoint)
    .all();

  const shownRow = await db
    .select({ n: sql<number>`count(distinct ${telemetryEvents.machineHash})` })
    .from(telemetryEvents)
    .where(
      and(
        eq(telemetryEvents.event, "pricing_offer_shown"),
        gte(telemetryEvents.receivedAt, campaign.startedAt || campaign.createdAt),
        sql`json_extract(${telemetryEvents.payloadJson}, '$.campaign_id') = ${campaignId}`
      )
    )
    .get();

  const shownTouchpoints = await db
    .select({
      touchpoint: sql<string>`json_extract(${telemetryEvents.payloadJson}, '$.touchpoint')`,
      n: sql<number>`count(distinct ${telemetryEvents.machineHash})`,
    })
    .from(telemetryEvents)
    .where(
      and(
        eq(telemetryEvents.event, "pricing_offer_shown"),
        gte(telemetryEvents.receivedAt, campaign.startedAt || campaign.createdAt),
        sql`json_extract(${telemetryEvents.payloadJson}, '$.campaign_id') = ${campaignId}`
      )
    )
    .groupBy(sql`json_extract(${telemetryEvents.payloadJson}, '$.touchpoint')`)
    .all();

  return {
    campaign: {
      id: campaign.campaignId,
      name: campaign.name,
      status: campaign.status,
      started_at: campaign.startedAt,
      ended_at: campaign.endedAt,
      min_install_hours: campaign.minInstallHours,
      min_active_days: campaign.minActiveDays,
      price_cents: campaign.priceCents,
      currency: campaign.currency,
    },
    arms: reports,
    touchpoints: Object.fromEntries(touchpoints.map((row) => [row.touchpoint, Number(row.n)])),
    touchpoint_arms: touchpointArms.map((row) => ({
      arm_id: row.armId,
      touchpoint: row.touchpoint,
      claimed: Number(row.n),
    })),
    shown_machines: Number(shownRow?.n ?? 0),
    shown_machines_by_touchpoint: Object.fromEntries(
      shownTouchpoints.map((row) => [row.touchpoint ?? "unknown", Number(row.n)])
    ),
  };
}
