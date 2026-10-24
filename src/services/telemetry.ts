import { and, count, desc, eq, gte, inArray, isNotNull, like, lte, sql, sum } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  telemetryDailyMetrics,
  telemetryDailyUniques,
  telemetryEvents,
  telemetrySessionState,
} from "../db/schema";

const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);
const MAX_DURATION_SECS = 7 * 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_RE = /^[a-z0-9_-]{1,64}$/;
const MACHINE_HASH_RE = /^[0-9a-f]{64}$/i;

// Exported so `tests/telemetry_event_names.test.ts` can check it against the client snapshot
// (`tests/fixtures/telemetry-client-event-names.json`) without re-parsing this file.
export const EVENT_NAMES = new Set([
  "install_seen",
  "session_start",
  "session_heartbeat",
  "session_checkpoint",
  "session_end",
  "session_unclean_end",
  "session_unclean_detected",
  "download_click",
  "native_started",
  "webview_created",
  "frontend_bootstrap_started",
  "frontend_mounted",
  "renderer_created",
  "model_load_started",
  "model_loaded",
  "first_frame_rendered",
  "startup_failed",
  "renderer_unresponsive",
  "webview_process_failed",
  "model_import_clicked",
  "model_import_picker_opened",
  "model_import_completed",
  "model_import_failed",
  "model_import_cancelled",
  "free_model_guide_clicked",
  "free_llm_credits_clicked",
  "free_asr_credits_clicked",
  "free_tts_credits_clicked",
  "purchase_clicked",
  "checkout_opened",
  "purchase_failed",
  "license_reminder_shown",
  "surface_event",
  "avatar_interaction",
  "dance_started",
  "chat_opened",
  "relaunch_focused",
  "main_window_navigated",
  "onboarding_started",
  "onboarding_step",
  "onboarding_completed",
  // --- telemetry v2 additions (docs/product/telemetry-plan.md, AniMate repo) ---
  "license_activated",
  "trial_granted",
  "trial_expired",
  "language_picked",
  "device_profile",
  "guide_returned",
  "chat_message_sent",
  "chat_reply_received",
  "chat_error",
  "chat_session_ended",
  "voice_session_started",
  "voice_session_ended",
  "music_sync_toggled",
  "review_prompt_shown",
  "review_rating_clicked",
  "review_feedback_clicked",
  "review_rate_completed",
  "review_declined",
  "onboarding_ai_first_turn",
  "onboarding_guide_link_opened",
  "onboarding_narration_heard",
  "onboarding_narration_skipped",
  "onboarding_narration_replayed",
  "webview2_runtime_version",
  // --- AI service config funnel (docs/plans/ai-service-setup-dialog-design.md, AniMate repo) ---
  // Identity is capability + kind + provider_preset_id only; provider name,
  // model, base URL and credentials are never sent by the client.
  "chat_setup_card_shown",
  "chat_setup_card_action",
  "ai_provider_configured",
  "ai_provider_validated",
  "ai_provider_removed",
  "ai_provider_default_changed",
  // --- Catalog card funnel (lever 1: one-click sample model, AniMate repo) ---
  // These five were missing from the ingest gate, so every step of the card
  // funnel answered INVALID_EVENT while the card itself was still switched off
  // server-side. Found before the card was enabled (2026-10-06 telemetry report
  // P0-2); the client has emitted all five since 0.12.0 (CatalogModelCard.tsx).
  "catalog_card_shown",
  "catalog_claim_clicked",
  "catalog_claim_result",
  "catalog_download_result",
  "catalog_model_imported",
  // --- Storage honesty + language picker (AniMate repo) ---
  // docs/plans/语言选择卡事件风暴与状态失忆问题分析-2026-10-07.md, shipped in 0.12.5.
  // Missing here each one answers 400 INVALID_EVENT, and the client only drops HTTP_413
  // as unprocessable — every other 4xx is deferred and replayed, so the event would sit
  // in the local queue (telemetry.json) forever while the same 400 repeats on each flush.
  // `storage_write_failed` fires on a transient file lock, i.e. it can happen to any install.
  // `storage_write_recovered`: the client retried a failed save in the background and it
  // succeeded. Paired with `storage_write_failed` it separates "no failures" from "failures
  // masked by retries". Added 2026-10-24 (client 0.13.2).
  "storage_read_failed",
  "storage_write_failed",
  "storage_write_recovered",
  "language_picker_shown",
  // Feature recall card (AniMate docs/plans/功能召回通用框架-实现计划-2026-10-08.md).
  // One name carries the whole funnel; `stage` (shown/accept/dismiss) splits it.
  "feature_recall",
  // Official community entry (QQ / Discord, AniMate docs/plans/社群入口设计-QQ与Discord-2026-10-08.md).
  // `community_entry_shown` splits exposure by surface; `community_link_clicked` carries
  // channel + action (copy counts as a click — it is the converting action for QQ).
  "community_entry_shown",
  // `community_entry_clicked` is the middle funnel step: the right-click menu item opens the
  // Settings modal at 系统与关于, and its click was previously invisible because the settings
  // block's exposure is deduped per process. Added 2026-10-10.
  "community_entry_clicked",
  "community_link_clicked",
  // --- Trial LLM key (AniMate docs/plans/trial-llm-key-plan.md §5) ---
  // Issued → used per turn → stopped → replaced by the user's own service. Under
  // the pool model the third-party gateway owns the real quota, so these are the
  // only place "did the trial actually get used" can be answered at all.
  // Privacy: the client never receives the key, and no payload field carries it,
  // a prefix or a hash — quota is always one of three buckets.
  "trial_llm_profile_issued",
  "trial_llm_turn_used",
  "trial_llm_exhausted",
  "trial_llm_profile_discarded",
]);

const LICENSE_STATES = new Set([
  "free",
  "trial",
  "active",
  "expired",
  "invalid",
  "machine_mismatch",
  "trial",
  "unknown",
]);

export class TelemetryError extends Error {
  error: string;
  statusCode: number;

  constructor(error: string, message: string, statusCode = 400) {
    super(message);
    this.error = error;
    this.statusCode = statusCode;
    this.name = "TelemetryError";
  }
}

type TelemetryEnvelope = {
  schemaVersion: number;
  eventId: string;
  event: string;
  sentAt: number | null;
  productId: string;
  appVersion: string | null;
  platform: string;
  channel: string;
  machineHash: string | null;
  installId: string | null;
  sessionId: string | null;
  licenseState: string;
  activationId: string | null;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
};

type MetricDimensions = {
  day: string;
  productId: string;
  sourceId: string;
  platform: string;
  channel: string;
  appVersion: string;
  licenseState: string;
};

export type TelemetryEventRow = typeof telemetryEvents.$inferSelect;

// Exported for the same reason as EVENT_NAMES above: the client snapshot test imports it.
export const PRODUCT_EVENT_NAMES = [
  "model_import_clicked",
  "model_import_picker_opened",
  "model_import_completed",
  "model_import_failed",
  "model_import_cancelled",
  "free_model_guide_clicked",
  "free_llm_credits_clicked",
  "free_asr_credits_clicked",
  "free_tts_credits_clicked",
  "purchase_clicked",
  "checkout_opened",
  "purchase_failed",
  "license_reminder_shown",
  "avatar_interaction",
  "dance_started",
  "chat_opened",
  // --- telemetry v2 additions (funnel-relevant product events) ---
  "license_activated",
  // Trial lifecycle anchors (docs/plans/license-trial-telemetry-events-plan.md,
  // AniMate repo): grant happens in the Rust bootstrap, expiry is the
  // first-expiry detection per grant. Both always follow a same-day
  // session_start, so listing them adds no machine_active marks or (day,
  // install) rows — they are here so the trial funnel's raw event load sees
  // them at all.
  "trial_granted",
  "trial_expired",
  "language_picked",
  "device_profile",
  "guide_returned",
  "chat_message_sent",
  "chat_reply_received",
  "chat_error",
  "chat_session_ended",
  "voice_session_started",
  "voice_session_ended",
  "music_sync_toggled",
  "review_prompt_shown",
  "review_rating_clicked",
  "review_feedback_clicked",
  "review_rate_completed",
  "review_declined",
  // --- Onboarding funnel events ---
  // Ingested (they are in EVENT_NAMES) but previously absent here. Adding them
  // changes no current number — every one of these implies a `session_start`
  // that day, so they cannot add a `machine_active` mark or a new
  // (day, install) row in loadDailyDeviceActivity, and the funnel report defines
  // no onboarding funnel. They are listed so that a future onboarding funnel
  // added to that report does not silently report zero.
  "onboarding_started",
  "onboarding_step",
  "onboarding_completed",
  "onboarding_ai_first_turn",
  "onboarding_narration_heard",
  "onboarding_narration_skipped",
  "onboarding_narration_replayed",
  "onboarding_guide_link_opened",
  // --- AI service config funnel (docs/plans/ai-service-setup-dialog-design.md, AniMate repo) ---
  // Must be listed here as well as in EVENT_NAMES. This array is the candidate
  // set for three readers: the `machine_active` daily-unique mark
  // (updateAggregates), the per-(day, install) device view
  // (loadDailyDeviceActivity), and the funnel report's raw event load. An event
  // missing from it is stored but invisible to all three.
  "chat_setup_card_shown",
  "chat_setup_card_action",
  "ai_provider_configured",
  "ai_provider_validated",
  "ai_provider_removed",
  "ai_provider_default_changed",
  // --- Catalog card funnel (lever 1: one-click sample model, AniMate repo) ---
  // Must be listed here as well as in EVENT_NAMES, for the same three readers
  // documented above: the `machine_active` daily-unique mark, the per-(day,
  // install) device view, and the product report's raw event load. Being only
  // in EVENT_NAMES would store the funnel and still report zero.
  "catalog_card_shown",
  "catalog_claim_clicked",
  "catalog_claim_result",
  "catalog_download_result",
  "catalog_model_imported",
  // --- Storage honesty + language picker (AniMate repo) ---
  // Must be listed here as well as in EVENT_NAMES, for the same three readers
  // documented above: the `machine_active` daily-unique mark, the per-(day,
  // install) device view, and the product report's raw event load. Being only in
  // EVENT_NAMES would accept the events and still report zero for them.
  "storage_read_failed",
  "storage_write_failed",
  "storage_write_recovered",
  "language_picker_shown",
  // --- Feature recall (AniMate repo) ---
  // Listed here as well as in EVENT_NAMES: being only in EVENT_NAMES would accept
  // the events and still report zero for them (same three readers as above).
  "feature_recall",
  // --- Official community entry (AniMate repo) ---
  // Listed here as well as in EVENT_NAMES, for the same three readers documented
  // above: the `machine_active` daily-unique mark, the per-(day, install) device
  // view, and the product report's raw event load. Being only in EVENT_NAMES would
  // accept the funnel and still report zero for it.
  "community_entry_shown",
  "community_entry_clicked",
  "community_link_clicked",
  // --- Trial LLM key (AniMate docs/plans/trial-llm-key-plan.md §5) ---
  // Listed here as well as in EVENT_NAMES, for the same three readers documented
  // above (machine_active mark, per-(day, install) device view, raw event load).
  // Being only in EVENT_NAMES would ingest the trial funnel and still report zero
  // for it — and the whole point of the batch is that ratio.
  "trial_llm_profile_issued",
  "trial_llm_turn_used",
  "trial_llm_exhausted",
  "trial_llm_profile_discarded",
] as const;

/**
 * 「某台设备当天算活跃」的候选事件集合。入库侧与报表侧必须共用这一份清单：
 *   1) 入库聚合：machine_active / install_active 日唯一标记（updateAggregates）
 *   2) 报表：活跃设备页、留存分析页（都读 install_active）
 * 任何一边漏掉事件，都会让「活跃设备数」在两个页面上对不上。
 * PRODUCT_EVENT_NAMES 里的事件即使当天没有会话事件，也会让该设备当天成为「活跃设备」，
 * 所以这里不能收窄成只留 session_*（实测会让 30 天里 8 天的设备数变少）。
 *
 * 也导出给 `scripts/backfill_install_active.ts` 用，保证回填与入库用的是同一份清单。
 */
export const DEVICE_ACTIVITY_EVENTS = [
  "session_start",
  "session_heartbeat",
  "session_checkpoint",
  "session_end",
  "session_unclean_end",
  "session_unclean_detected",
  "surface_event",
  ...PRODUCT_EVENT_NAMES,
];

/**
 * 「时长的增量只由这些事件决定」——这是**唯一**口径，入库聚合与所有报表必须共用同一份：
 *   - 入库：telemetry_daily_metrics.active_secs / overlay_visible_secs、telemetry_session_state
 *   - 报表：活跃设备（列表 / 某日）、留存、安装详情、用户总览、设备总览的机器用量
 * 判定标准是"客户端是否真的在这些事件里带 process_duration_secs / *_visible_secs"。
 * 生产实测（2026-10-16 线上全库）：带时长字段的事件恰好只有这 4 种。
 * session_unclean_detected 自 2026-08-18 加入白名单起零上报，且它的 session_id 归属与
 * payload 是否带时长都没有客户端契约可查，因此**刻意不算时长事件**：它只出现在
 * DEVICE_ACTIVITY_EVENTS 里（管"当天是否活跃"）。将来客户端真的开始发它时，会先命中
 * updateAggregates 里的 warn 探针；那时再决定是否并入这里（入库与报表同时改 + 更新
 * tests/telemetry.test.ts 的口径合同用例）。
 */
export const SESSION_DURATION_EVENTS = [
  "session_heartbeat",
  "session_checkpoint",
  "session_end",
  "session_unclean_end",
];

/** 见 updateAggregates 里的探针：每个 isolate 只告警一次。 */
let warnedUncleanDetectedWithDuration = false;

/**
 * install_active 日聚合的覆盖起点。早于这一天的窗口（历史回填没覆盖到的部分）
 * 会回退到原始事件算法，保证上线顺序（先发代码还是先回填）不会让报表变空。
 */
const INSTALL_ACTIVE_COVERAGE_FROM = "2026-06-17";

/**
 * install_active 的覆盖上界。回填没覆盖到窗口末尾时（例如先发代码、后跑回填），
 * 报表必须回退到原始事件算法，而不是把页面变成 0。MAX(day) 走主键索引
 * (day, product_id, unique_type, unique_value) 反向扫描，实际只读几个索引项。
 */
async function installActiveCoverageEnd(db: Database, productId: string): Promise<string | null> {
  const row = await db
    .select({ day: sql<string | null>`MAX(${telemetryDailyUniques.day})` })
    .from(telemetryDailyUniques)
    .where(and(
      eq(telemetryDailyUniques.productId, productId),
      eq(telemetryDailyUniques.uniqueType, "install_active")
    ))
    .get();
  return row?.day ?? null;
}

/**
 * 窗口末端是否已被 install_active 覆盖。容差一天：每天 UTC 00:00 之后第一台设备
 * 上报之前，最新覆盖日只到昨天，此时不应该把整页打回昂贵的原始事件重放。
 */
async function installActiveCoversWindow(
  db: Database,
  productId: string,
  start: string,
  end: string
): Promise<boolean> {
  if (start < INSTALL_ACTIVE_COVERAGE_FROM) return false;
  const covered = await installActiveCoverageEnd(db, productId);
  return !!covered && covered >= addUtcDays(end, -1);
}

type ProductEvent = {
  event: string;
  identity: string;
  occurredAt: number;
  surface: string;
  appVersion: string;
  channel: string;
  licenseState: string;
};

type FunnelStageSpec = { key: string; label: string; event: string };

export type ProductFunnel = {
  key: string;
  label: string;
  stages: Array<{
    key: string;
    label: string;
    event: string;
    devices: number;
    events: number;
    fromPreviousPct: number;
    fromFirstPct: number;
  }>;
};

export function parseTelemetryTokens(config: AppConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of config.telemetryTokens.split(",")) {
    const [token, source] = entry.split(":").map((x) => x.trim());
    if (token && source) map.set(token, source);
  }
  return map;
}

export async function recordTelemetryEvent(
  db: Database,
  config: AppConfig,
  token: string | null,
  body: unknown,
  now = new Date()
): Promise<{ ok: true; duplicate?: true }> {
  const sourceId = validateToken(config, token);
  const envelope = validateEnvelope(body);
  const receivedAtUnix = Math.floor(now.getTime() / 1000);
  const receivedAt = toSqlDateTime(now);
  // 去重与写入合成一条语句：原来的「先 SELECT 再 INSERT」每条事件多一次行读和一次
  // 往返，而且两步之间不原子 —— 同一 event_id 并发重放时两个请求都会通过 SELECT，
  // 后到的 INSERT 撞主键抛错，上报端收到 500。
  const inserted = await db.insert(telemetryEvents).values({
    eventId: envelope.eventId,
    schemaVersion: envelope.schemaVersion,
    event: envelope.event,
    sourceId,
    receivedAt,
    receivedAtUnix,
    sentAt: envelope.sentAt,
    productId: envelope.productId,
    appVersion: envelope.appVersion,
    platform: envelope.platform,
    channel: envelope.channel,
    machineHash: envelope.machineHash,
    installId: envelope.installId,
    sessionId: envelope.sessionId,
    licenseState: envelope.licenseState,
    activationId: envelope.activationId,
    payloadJson: JSON.stringify(envelope.payload),
    rawJson: JSON.stringify(envelope.raw),
  }).onConflictDoNothing({ target: telemetryEvents.eventId })
    .returning({ eventId: telemetryEvents.eventId });
  if (!inserted.length) return { ok: true, duplicate: true };

  try {
    await updateAggregates(db, envelope, sourceId, receivedAtUnix, receivedAt);
  } catch (err) {
    console.error("Telemetry aggregate error:", err);
  }

  return { ok: true };
}

function validateToken(config: AppConfig, token: string | null): string {
  if (!token) {
    throw new TelemetryError("INVALID_TELEMETRY_TOKEN", "Telemetry token required", 401);
  }
  const sourceId = parseTelemetryTokens(config).get(token);
  if (!sourceId) {
    throw new TelemetryError("INVALID_TELEMETRY_TOKEN", "Telemetry token invalid", 401);
  }
  return sourceId;
}

function validateEnvelope(body: unknown): TelemetryEnvelope {
  if (!isObject(body)) throw new TelemetryError("INVALID_JSON", "请求体格式无效", 400);
  const raw = body as Record<string, unknown>;
  const schemaVersion = Number(raw.schema_version);
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new TelemetryError("INVALID_SCHEMA_VERSION", "schema_version 不受支持", 400);
  }

  const eventId = requiredString(raw.event_id, "event_id");
  if (!validUuidish(eventId)) throw new TelemetryError("INVALID_EVENT_ID", "event_id 无效", 400);

  const event = requiredString(raw.event, "event");
  if (!EVENT_NAMES.has(event)) throw new TelemetryError("INVALID_EVENT", "event 不受支持", 400);

  const productId = requiredString(raw.product_id, "product_id").toLowerCase();
  if (!PRODUCT_RE.test(productId)) {
    throw new TelemetryError("INVALID_PRODUCT_ID", "product_id 无效", 400);
  }

  const sentAt = optionalInteger(raw.sent_at, "sent_at");
  const appVersion = optionalCleanString(raw.app_version, 64) || null;
  const platform = normalizePlatform(optionalCleanString(raw.platform, 64) || "unknown");
  const channel = optionalCleanString(raw.channel, 64) || "official";
  const machineHashRaw = optionalCleanString(raw.machine_hash, 128);
  const machineHash = machineHashRaw ? machineHashRaw.toLowerCase() : null;
  if (machineHash && !MACHINE_HASH_RE.test(machineHash)) {
    throw new TelemetryError("INVALID_MACHINE_HASH", "machine_hash 无效", 400);
  }

  const installId = optionalCleanString(raw.install_id, 64) || null;
  const sessionId = optionalCleanString(raw.session_id, 64) || null;
  const licenseState = normalizeLicenseState(optionalCleanString(raw.license_state, 64));
  const activationId = optionalCleanString(raw.activation_id, 128) || null;
  const payload = isObject(raw.payload) ? (raw.payload as Record<string, unknown>) : {};

  validateEventRequirements(event, {
    appVersion,
    platform,
    installId,
    sessionId,
    payload,
  });

  return {
    schemaVersion,
    eventId,
    event,
    sentAt,
    productId,
    appVersion,
    platform,
    channel,
    machineHash,
    installId,
    sessionId,
    licenseState,
    activationId,
    payload,
    raw,
  };
}

function validateEventRequirements(
  event: string,
  params: {
    appVersion: string | null;
    platform: string;
    installId: string | null;
    sessionId: string | null;
    payload: Record<string, unknown>;
  }
) {
  if (event !== "download_click") {
    if (!params.appVersion) throw new TelemetryError("INVALID_APP_VERSION", "app_version 不能为空", 400);
    if (!params.platform) throw new TelemetryError("INVALID_PLATFORM", "platform 不能为空", 400);
    if (!params.installId) throw new TelemetryError("INVALID_INSTALL_ID", "install_id 不能为空", 400);
  }
  if (event.startsWith("session_") && !params.sessionId) {
    throw new TelemetryError("INVALID_SESSION_ID", "session_id 不能为空", 400);
  }
  if (event === "session_heartbeat" || event === "session_checkpoint") {
    requirePayloadInteger(params.payload, "seq");
    requirePayloadInteger(params.payload, "process_duration_secs");
    requireVisibleSecs(params.payload, event);
  }
  if (event === "session_end" || event === "session_unclean_end") {
    requirePayloadInteger(params.payload, "process_duration_secs");
    requireVisibleSecs(params.payload, event);
  }
}

async function updateAggregates(
  db: Database,
  envelope: TelemetryEnvelope,
  sourceId: string,
  receivedAtUnix: number,
  receivedAt: string
) {
  const dims = metricDimensions(envelope, sourceId, receivedAtUnix);
  let downloads = 0;
  let installs = 0;
  let launches = 0;
  let activeSecs = 0;
  let overlayVisibleSecs = 0;

  if (envelope.event === "download_click") downloads = 1;
  if (envelope.event === "session_start") launches = 1;

  if (envelope.event === "install_seen" && envelope.installId) {
    const inserted = await insertDailyUnique(db, dims, "install_seen", envelope.installId, receivedAt);
    if (inserted) installs = 1;
  }

  if ((DEVICE_ACTIVITY_EVENTS as readonly string[]).includes(envelope.event)) {
    // 三类日唯一标记合成一条多值 INSERT：原来每条事件 2~3 次独立语句往返，
    // 现在一次。加 install_active 后语句数反而比改动前更少。
    // 失败重试一次：唯一键冲突即忽略，天然幂等，不会重复计数；聚合写入静默失败
    // 会让报表永久少一台设备（生产快照实测 install_seen 曾丢 1 行）。
    const marks: Array<{ uniqueType: string; uniqueValue: string }> = [];
    if (envelope.machineHash) marks.push({ uniqueType: "machine_active", uniqueValue: envelope.machineHash });
    if (envelope.sessionId) marks.push({ uniqueType: "session_seen", uniqueValue: envelope.sessionId });
    // install_active = 同一份候选清单按 install 去重，活跃设备页/留存页直接读它，
    // 不再重放原始事件（30 天窗口 10 万行 -> 3 千行）。
    if (envelope.installId) marks.push({ uniqueType: "install_active", uniqueValue: envelope.installId });
    if (marks.length) await insertDailyUniquesWithRetry(db, dims, marks, receivedAt);
  }

  if ((SESSION_DURATION_EVENTS as readonly string[]).includes(envelope.event)) {
    const delta = await updateSessionState(db, envelope, sourceId, receivedAtUnix, receivedAt);
    activeSecs = delta.activeSecs;
    overlayVisibleSecs = delta.overlayVisibleSecs;
  } else if (envelope.event === "session_start" && envelope.sessionId) {
    await upsertSessionState(db, envelope, sourceId, receivedAtUnix, receivedAt, 0, 0);
  }

  // 探针：session_unclean_detected 目前被刻意排除在时长口径之外（客户端从未上报过它）。
  // 一旦它带着时长字段出现，说明客户端契约变了，要重新评估是否并入 SESSION_DURATION_EVENTS。
  // 每个 isolate 只告警一次，避免它开始刷上报时把日志打爆。
  if (
    !warnedUncleanDetectedWithDuration &&
    envelope.event === "session_unclean_detected" &&
    (envelope.payload.process_duration_secs !== undefined ||
      envelope.payload.companion_visible_secs !== undefined ||
      envelope.payload.overlay_visible_secs !== undefined)
  ) {
    warnedUncleanDetectedWithDuration = true;
    console.warn(
      "telemetry: session_unclean_detected arrived with duration fields; re-evaluate SESSION_DURATION_EVENTS",
      { eventId: envelope.eventId, payloadKeys: Object.keys(envelope.payload).sort() }
    );
  }

  await incrementDailyMetrics(db, dims, {
    downloads,
    installs,
    launches,
    activeSecs,
    overlayVisibleSecs,
    events: 1,
  });
}

function metricDimensions(
  envelope: TelemetryEnvelope,
  sourceId: string,
  receivedAtUnix: number
): MetricDimensions {
  return {
    day: new Date(receivedAtUnix * 1000).toISOString().slice(0, 10),
    productId: envelope.productId,
    sourceId,
    platform: envelope.platform || "unknown",
    channel: envelope.channel || "official",
    appVersion: envelope.appVersion || "unknown",
    licenseState: envelope.licenseState || "unknown",
  };
}

async function insertDailyUnique(
  db: Database,
  dims: MetricDimensions,
  uniqueType: string,
  uniqueValue: string,
  firstSeenAt: string
): Promise<boolean> {
  // Single atomic statement; RETURNING tells us whether this call actually
  // inserted (false = the unique already existed for this day).
  const inserted = await db.all<{ unique_value: string }>(sql`
    INSERT INTO telemetry_daily_uniques
      (day, product_id, unique_type, unique_value, source_id, platform, channel, app_version, license_state, first_seen_at)
    VALUES (
      ${dims.day}, ${dims.productId}, ${uniqueType}, ${uniqueValue},
      ${dims.sourceId}, ${dims.platform}, ${dims.channel}, ${dims.appVersion}, ${dims.licenseState},
      ${firstSeenAt}
    )
    ON CONFLICT (day, product_id, unique_type, unique_value) DO NOTHING
    RETURNING unique_value
  `);
  return inserted.length > 0;
}

/**
 * 一次多值 INSERT 写入多条日唯一标记。只有 install_seen 需要 RETURNING 的
 * "是否真的插入了"（它驱动 daily_metrics.installs），machine_active /
 * session_seen / install_active 的返回值没有任何人用，所以走这条不带 RETURNING
 * 的批量路径：每条事件少 1~2 次语句往返。
 */
async function insertDailyUniques(
  db: Database,
  dims: MetricDimensions,
  marks: Array<{ uniqueType: string; uniqueValue: string }>,
  firstSeenAt: string
): Promise<void> {
  if (!marks.length) return;
  const values = sql.join(
    marks.map(
      (mark) => sql`(${dims.day}, ${dims.productId}, ${mark.uniqueType}, ${mark.uniqueValue},
        ${dims.sourceId}, ${dims.platform}, ${dims.channel}, ${dims.appVersion}, ${dims.licenseState},
        ${firstSeenAt})`
    ),
    sql`, `
  );
  await db.run(sql`
    INSERT INTO telemetry_daily_uniques
      (day, product_id, unique_type, unique_value, source_id, platform, channel, app_version, license_state, first_seen_at)
    VALUES ${values}
    ON CONFLICT (day, product_id, unique_type, unique_value) DO NOTHING
  `);
}

/**
 * 日唯一标记的重试包装。聚合写入失败会被 recordTelemetryEvent 吞掉日志，报表就会
 * 永久少一台设备（生产快照实测 install_seen 丢过 1 行）。唯一键冲突即忽略让这条语句
 * 天然幂等，重试不会造成重复计数；而 updateSessionState / incrementDailyMetrics 是
 * 增量累计、不幂等，所以只对这一段做重试。
 */
async function insertDailyUniquesWithRetry(
  db: Database,
  dims: MetricDimensions,
  marks: Array<{ uniqueType: string; uniqueValue: string }>,
  firstSeenAt: string
): Promise<void> {
  try {
    await insertDailyUniques(db, dims, marks, firstSeenAt);
  } catch (firstError) {
    try {
      await insertDailyUniques(db, dims, marks, firstSeenAt);
    } catch (retryError) {
      throw firstError instanceof Error ? firstError : retryError;
    }
  }
}

async function updateSessionState(
  db: Database,
  envelope: TelemetryEnvelope,
  sourceId: string,
  receivedAtUnix: number,
  receivedAt: string
): Promise<{ activeSecs: number; overlayVisibleSecs: number }> {
  if (!envelope.sessionId) return { activeSecs: 0, overlayVisibleSecs: 0 };

  const processDuration = safePayloadDuration(envelope.payload, "process_duration_secs");
  const overlayDuration = sessionVisibleSecs(envelope.payload, envelope.event);
  const sessionId = envelope.sessionId;
  const startedAt = numberFromPayload(envelope.payload.started_at) ?? envelope.sentAt ?? receivedAtUnix;

  // Compare-and-swap on the previous duration pair. A plain read-then-write let
  // two concurrent events for one session read the same old value and both
  // write their own delta, silently dropping one from the daily counters
  // (docs/d1-usage-investigation.md §4.3). The CAS keeps delta = new - old exact
  // because the guard proves the row still held the value the delta came from.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await db
      .select({
        process: telemetrySessionState.lastProcessDurationSecs,
        overlay: telemetrySessionState.lastOverlayVisibleSecs,
      })
      .from(telemetrySessionState)
      .where(eq(telemetrySessionState.sessionId, sessionId))
      .get();

    if (!current) {
      const inserted = await db.run(sql`
        INSERT INTO telemetry_session_state
          (session_id, product_id, machine_hash, install_id, app_version, platform, channel,
           license_state, source_id, started_at, last_event_at, last_process_duration_secs,
           last_overlay_visible_secs, updated_at)
        VALUES (
          ${sessionId}, ${envelope.productId}, ${envelope.machineHash}, ${envelope.installId},
          ${envelope.appVersion}, ${envelope.platform}, ${envelope.channel}, ${envelope.licenseState},
          ${sourceId}, ${startedAt}, ${receivedAtUnix}, ${processDuration}, ${overlayDuration}, ${receivedAt}
        )
        ON CONFLICT (session_id) DO NOTHING
      `);
      // First observation of a session (e.g. a checkpoint without session_start
      // after a client restart): the full duration counts as baseline, matching
      // the pre-CAS behaviour. A concurrent insert means we lost the race; loop
      // and let the CAS path account for the delta.
      if (changesOf(inserted) > 0) {
        return { activeSecs: processDuration, overlayVisibleSecs: overlayDuration };
      }
      continue;
    }

    const activeSecs = boundedDelta(processDuration, current.process);
    const overlayVisibleSecs = boundedDelta(overlayDuration, current.overlay);
    const result = await db.run(sql`
      UPDATE telemetry_session_state SET
        product_id = ${envelope.productId},
        machine_hash = ${envelope.machineHash},
        install_id = ${envelope.installId},
        app_version = ${envelope.appVersion},
        platform = ${envelope.platform},
        channel = ${envelope.channel},
        license_state = ${envelope.licenseState},
        source_id = ${sourceId},
        last_event_at = ${receivedAtUnix},
        last_process_duration_secs = ${processDuration},
        last_overlay_visible_secs = ${overlayDuration},
        updated_at = ${receivedAt}
      WHERE session_id = ${sessionId}
        AND last_process_duration_secs = ${current.process}
        AND last_overlay_visible_secs = ${current.overlay}
    `);
    if (changesOf(result) > 0) {
      return { activeSecs, overlayVisibleSecs };
    }
  }
  // Lost the race three times: report no delta. Durations are monotonic, so the
  // next event of the session accounts for the gap (at most one tick wide).
  return { activeSecs: 0, overlayVisibleSecs: 0 };
}

async function upsertSessionState(
  db: Database,
  envelope: TelemetryEnvelope,
  sourceId: string,
  receivedAtUnix: number,
  receivedAt: string,
  processDuration: number,
  overlayDuration: number
) {
  if (!envelope.sessionId) return;
  const startedAt = numberFromPayload(envelope.payload.started_at) ?? envelope.sentAt ?? receivedAtUnix;
  // Atomic upsert (no deltas involved). MAX() guards against out-of-order
  // replays regressing the monotonic duration counters.
  await db.run(sql`
    INSERT INTO telemetry_session_state
      (session_id, product_id, machine_hash, install_id, app_version, platform, channel,
       license_state, source_id, started_at, last_event_at, last_process_duration_secs,
       last_overlay_visible_secs, updated_at)
    VALUES (
      ${envelope.sessionId}, ${envelope.productId}, ${envelope.machineHash}, ${envelope.installId},
      ${envelope.appVersion}, ${envelope.platform}, ${envelope.channel}, ${envelope.licenseState},
      ${sourceId}, ${startedAt}, ${receivedAtUnix}, ${processDuration}, ${overlayDuration}, ${receivedAt}
    )
    ON CONFLICT (session_id) DO UPDATE SET
      machine_hash = excluded.machine_hash,
      install_id = excluded.install_id,
      app_version = excluded.app_version,
      platform = excluded.platform,
      channel = excluded.channel,
      license_state = excluded.license_state,
      source_id = excluded.source_id,
      last_event_at = excluded.last_event_at,
      last_process_duration_secs = MAX(telemetry_session_state.last_process_duration_secs, excluded.last_process_duration_secs),
      last_overlay_visible_secs = MAX(telemetry_session_state.last_overlay_visible_secs, excluded.last_overlay_visible_secs),
      updated_at = excluded.updated_at
  `);
}

async function incrementDailyMetrics(
  db: Database,
  dims: MetricDimensions,
  inc: {
    downloads: number;
    installs: number;
    launches: number;
    activeSecs: number;
    overlayVisibleSecs: number;
    events: number;
  }
) {
  // Atomic additive upsert. The previous SELECT-then-UPDATE read-modify-write
  // lost 5-9% of counts per day under concurrent isolates (see
  // docs/d1-usage-investigation.md §4.3); a single statement cannot race.
  await db.run(sql`
    INSERT INTO telemetry_daily_metrics
      (day, product_id, source_id, platform, channel, app_version, license_state,
       downloads, installs, launches, active_secs, overlay_visible_secs, events, updated_at)
    VALUES (
      ${dims.day}, ${dims.productId}, ${dims.sourceId}, ${dims.platform}, ${dims.channel},
      ${dims.appVersion}, ${dims.licenseState},
      ${inc.downloads}, ${inc.installs}, ${inc.launches}, ${inc.activeSecs},
      ${inc.overlayVisibleSecs}, ${inc.events}, ${toSqlDateTime(new Date())}
    )
    ON CONFLICT (day, product_id, source_id, platform, channel, app_version, license_state)
    DO UPDATE SET
      downloads = downloads + excluded.downloads,
      installs = installs + excluded.installs,
      launches = launches + excluded.launches,
      active_secs = active_secs + excluded.active_secs,
      overlay_visible_secs = overlay_visible_secs + excluded.overlay_visible_secs,
      events = events + excluded.events,
      updated_at = excluded.updated_at
  `);
}

function dimsWhere(dims: MetricDimensions) {
  return and(
    eq(telemetryDailyMetrics.day, dims.day),
    eq(telemetryDailyMetrics.productId, dims.productId),
    eq(telemetryDailyMetrics.sourceId, dims.sourceId),
    eq(telemetryDailyMetrics.platform, dims.platform),
    eq(telemetryDailyMetrics.channel, dims.channel),
    eq(telemetryDailyMetrics.appVersion, dims.appVersion),
    eq(telemetryDailyMetrics.licenseState, dims.licenseState)
  );
}

export type TelemetryEventListItem = Omit<TelemetryEventRow, "rawJson">;

/** Rows columns for the events table view: everything except the big raw_json blob. */
const EVENT_LIST_COLUMNS = {
  eventId: telemetryEvents.eventId,
  schemaVersion: telemetryEvents.schemaVersion,
  event: telemetryEvents.event,
  sourceId: telemetryEvents.sourceId,
  receivedAt: telemetryEvents.receivedAt,
  receivedAtUnix: telemetryEvents.receivedAtUnix,
  sentAt: telemetryEvents.sentAt,
  productId: telemetryEvents.productId,
  appVersion: telemetryEvents.appVersion,
  platform: telemetryEvents.platform,
  channel: telemetryEvents.channel,
  machineHash: telemetryEvents.machineHash,
  installId: telemetryEvents.installId,
  sessionId: telemetryEvents.sessionId,
  licenseState: telemetryEvents.licenseState,
  activationId: telemetryEvents.activationId,
  payloadJson: telemetryEvents.payloadJson,
} as const;

/**
 * 事件浏览页的 id 过滤：完整 id 走索引等值，其余（片段/前缀）仍走两侧通配的 LIKE。
 *
 * 完整 64 位 machine_hash 或 UUID 形式的 install_id / session_id 是「从别处复制过来查这一条」
 * 的典型用法：等值能命中 machine_idx / install_idx，把 7 天窗口里上万行的逐行 LIKE 比较
 * 变成 1~3 次索引探测。片段搜索保留原语义（索引帮不上，靠时间窗兜底）。
 * 大小写：库里是小写，用原词 + 小写 + 大写三个候选保住原来的大小写不敏感。
 */
function idFilter(
  column: AnySQLiteColumn,
  term: string | undefined
) {
  if (!term) return undefined;
  if (!MACHINE_HASH_RE.test(term) && !UUID_RE.test(term)) {
    return like(column, `%${term}%`);
  }
  return inArray(column, Array.from(new Set([term, term.toLowerCase(), term.toUpperCase()])));
}

/**
 * Raw-event browser. Every query is bounded by a mandatory time window
 * (default 7 days, max 90) and pushed into SQL — the old implementation loaded
 * the whole table into memory and filtered in JS, which is what burned the D1
 * free-tier read quota on a couple of page views (see
 * docs/d1-usage-investigation.md §3.2).
 */
export async function listTelemetryEvents(
  db: Database,
  params: {
    event?: string;
    productId?: string;
    machineHash?: string;
    installId?: string;
    sessionId?: string;
    /** Look-back window in days (1-90, default 7). */
    days?: number;
    page?: number;
    pageSize?: number;
  } = {}
): Promise<{ items: TelemetryEventListItem[]; total: number; days: number }> {
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize || 80));
  const days = Math.min(90, Math.max(1, params.days || 7));
  const since = toSqlDateTime(new Date(Date.now() - (days - 1) * 86400000));

  const conditions = [gte(telemetryEvents.receivedAt, since)];
  if (params.event) conditions.push(eq(telemetryEvents.event, params.event));
  if (params.productId) conditions.push(eq(telemetryEvents.productId, params.productId));
  for (const filter of [
    idFilter(telemetryEvents.machineHash, params.machineHash),
    idFilter(telemetryEvents.installId, params.installId),
    idFilter(telemetryEvents.sessionId, params.sessionId),
  ]) {
    if (filter) conditions.push(filter);
  }
  const where = and(...conditions);

  const items = await db
    .select(EVENT_LIST_COLUMNS)
    .from(telemetryEvents)
    .where(where)
    .orderBy(desc(telemetryEvents.receivedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const totalRow = await db
    .select({ value: count() })
    .from(telemetryEvents)
    .where(where)
    .get();
  return { items, total: Number(totalRow?.value ?? 0), days };
}

// ---------------------------------------------------------------------------
// Admin report cache
// ---------------------------------------------------------------------------

/**
 * Tiny per-isolate TTL cache for the admin pages. Refreshing a report page a
 * few times re-uses one scan instead of paying for it again; the window is
 * short enough that the numbers feel live. Best-effort only (isolates are
 * recycled at will) — never a correctness dependency.
 */
const REPORT_CACHE_TTL_MS = 5 * 60_000;
const REPORT_CACHE = new Map<string, { at: number; value: unknown }>();
// Vitest sets process.env.VITEST; caching there would leak results between
// tests that reuse one in-memory database. Workers (nodejs_compat) also expose
// process.env, where the flag is simply absent.
const REPORT_CACHE_ENABLED = typeof process === "undefined" || !process.env?.VITEST;

async function cachedReport<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!REPORT_CACHE_ENABLED) return fn();
  const now = Date.now();
  const hit = REPORT_CACHE.get(key);
  if (hit && now - hit.at < REPORT_CACHE_TTL_MS) return hit.value as T;
  const value = await fn();
  if (REPORT_CACHE.size >= 64) {
    const oldest = REPORT_CACHE.keys().next();
    if (!oldest.done) REPORT_CACHE.delete(oldest.value);
  }
  REPORT_CACHE.set(key, { at: now, value });
  return value;
}

export async function getTelemetryReport(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  return cachedReport(`report:${params.productId || "animate"}:${params.days || 14}`, () =>
    getTelemetryReportUncached(db, params)
  );
}

export async function getRetentionReport(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  return cachedReport(`retention:${params.productId || "animate"}:${params.days || 30}`, () =>
    getRetentionReportUncached(db, params)
  );
}

export async function getStartupDiagnostics(
  db: Database,
  params: { day?: string; productId?: string } = {}
) {
  return cachedReport(`startup:${params.productId || "animate"}:${params.day || new Date().toISOString().slice(0, 10)}`, () =>
    getStartupDiagnosticsUncached(db, params)
  );
}

export async function getProductAnalyticsReport(
  db: Database,
  params: {
    days?: number;
    productId?: string;
    appVersion?: string;
    channel?: string;
    licenseState?: string;
  } = {}
) {
  return cachedReport(
    `analytics:${params.productId || "animate"}:${params.days || 14}:${params.appVersion || ""}:${params.channel || ""}:${params.licenseState || ""}`,
    () => getProductAnalyticsReportUncached(db, params)
  );
}

export async function listTelemetryUsers(
  db: Database,
  params: Parameters<typeof listTelemetryUsersUncached>[1]
) {
  const p = params || {};
  return cachedReport(
    `users:${p.productId || "animate"}:${p.days || 30}:${p.q || ""}:${p.status || ""}:${p.platform || ""}:${p.sort || "last_seen"}:${p.page || 1}:${p.pageSize || 50}`,
    () => listTelemetryUsersUncached(db, p)
  );
}

async function getTelemetryReportUncached(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  const days = Math.min(90, Math.max(1, params.days || 14));
  const productId = params.productId || "animate";
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const metrics = await db
    .select()
    .from(telemetryDailyMetrics)
    .where(and(gte(telemetryDailyMetrics.day, start), eq(telemetryDailyMetrics.productId, productId)))
    .all();
  const uniques = await db
    .select()
    .from(telemetryDailyUniques)
    .where(and(gte(telemetryDailyUniques.day, start), eq(telemetryDailyUniques.productId, productId)))
    .all();

  const daily = new Map<string, {
    day: string;
    downloads: number;
    installs: number;
    activeMachines: number;
    launches: number;
    activeSecs: number;
    overlayVisibleSecs: number;
    events: number;
  }>();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.set(day, {
      day,
      downloads: 0,
      installs: 0,
      activeMachines: 0,
      launches: 0,
      activeSecs: 0,
      overlayVisibleSecs: 0,
      events: 0,
    });
  }

  const versionMap = new Map<string, { appVersion: string; launches: number; activeSecs: number; activeMachines: number }>();
  const stateMap = new Map<string, { licenseState: string; launches: number; activeMachines: number }>();
  const platformMap = new Map<string, { platform: string; downloads: number; installs: number; activeMachines: number }>();

  for (const row of metrics) {
    const d = daily.get(row.day);
    if (d) {
      d.downloads += row.downloads;
      d.installs += row.installs;
      d.launches += row.launches;
      d.activeSecs += row.activeSecs;
      d.overlayVisibleSecs += row.overlayVisibleSecs;
      d.events += row.events;
    }
    const version = versionMap.get(row.appVersion) || {
      appVersion: row.appVersion,
      launches: 0,
      activeSecs: 0,
      activeMachines: 0,
    };
    version.launches += row.launches;
    version.activeSecs += row.activeSecs;
    versionMap.set(row.appVersion, version);

    const state = stateMap.get(row.licenseState) || {
      licenseState: row.licenseState,
      launches: 0,
      activeMachines: 0,
    };
    state.launches += row.launches;
    stateMap.set(row.licenseState, state);

    const platform = platformMap.get(row.platform) || {
      platform: row.platform,
      downloads: 0,
      installs: 0,
      activeMachines: 0,
    };
    platform.downloads += row.downloads;
    platform.installs += row.installs;
    platformMap.set(row.platform, platform);
  }

  for (const row of uniques) {
    const d = daily.get(row.day);
    if (row.uniqueType === "machine_active") {
      if (d) d.activeMachines += 1;
      const version = versionMap.get(row.appVersion) || {
        appVersion: row.appVersion,
        launches: 0,
        activeSecs: 0,
        activeMachines: 0,
      };
      version.activeMachines += 1;
      versionMap.set(row.appVersion, version);
      const state = stateMap.get(row.licenseState) || {
        licenseState: row.licenseState,
        launches: 0,
        activeMachines: 0,
      };
      state.activeMachines += 1;
      stateMap.set(row.licenseState, state);
      const platform = platformMap.get(row.platform) || {
        platform: row.platform,
        downloads: 0,
        installs: 0,
        activeMachines: 0,
      };
      platform.activeMachines += 1;
      platformMap.set(row.platform, platform);
    }
  }

  const dailyRows = Array.from(daily.values());
  const totals = dailyRows.reduce(
    (acc, row) => ({
      downloads: acc.downloads + row.downloads,
      installs: acc.installs + row.installs,
      activeMachines: acc.activeMachines + row.activeMachines,
      launches: acc.launches + row.launches,
      activeSecs: acc.activeSecs + row.activeSecs,
      overlayVisibleSecs: acc.overlayVisibleSecs + row.overlayVisibleSecs,
      events: acc.events + row.events,
    }),
    { downloads: 0, installs: 0, activeMachines: 0, launches: 0, activeSecs: 0, overlayVisibleSecs: 0, events: 0 }
  );

  return {
    totals,
    daily: dailyRows,
    versions: Array.from(versionMap.values()).sort((a, b) => b.activeMachines - a.activeMachines),
    licenseStates: Array.from(stateMap.values()).sort((a, b) => b.activeMachines - a.activeMachines),
    platforms: Array.from(platformMap.values()).sort((a, b) => b.activeMachines - a.activeMachines),
  };
}

export type TelemetryMachineUsage = {
  machineHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  activeDays: number;
  launches: number;
  sessions: number;
  activeSecs: number;
  overlayVisibleSecs: number;
  platform: string;
  appVersion: string;
  licenseStates: string[];
};

/** Aggregate session telemetry by anonymous machine for the selected period. */
export async function getTelemetryMachineUsage(
  db: Database,
  params: { days?: number; productId?: string; limit?: number } = {}
): Promise<TelemetryMachineUsage[]> {
  const days = Math.min(90, Math.max(1, params.days || 14));
  const productId = params.productId || "animate";
  const start = new Date(Date.now() - (days - 1) * 86400000);
  const startSql = toSqlDateTime(start);

  const [events, uniques] = await Promise.all([
    db
      .select(EVENT_LIST_COLUMNS)
      .from(telemetryEvents)
      .where(
        and(
          gte(telemetryEvents.receivedAt, startSql),
          eq(telemetryEvents.productId, productId)
        )
      )
      .all(),
    db
      .select()
      .from(telemetryDailyUniques)
      .where(
        and(
          gte(telemetryDailyUniques.day, start.toISOString().slice(0, 10)),
          eq(telemetryDailyUniques.productId, productId),
          eq(telemetryDailyUniques.uniqueType, "machine_active")
        )
      )
      .all(),
  ]);

  const activeDaysByMachine = new Map<string, Set<string>>();
  for (const row of uniques) {
    if (!row.uniqueValue) continue;
    const daysForMachine = activeDaysByMachine.get(row.uniqueValue) || new Set<string>();
    daysForMachine.add(row.day);
    activeDaysByMachine.set(row.uniqueValue, daysForMachine);
  }

  const byMachine = new Map<string, {
    firstSeenAt: string;
    lastSeenAt: string;
    launches: number;
    sessions: Set<string>;
    activeSecs: number;
    overlayVisibleSecs: number;
    platform: string;
    appVersion: string;
    licenseStates: Set<string>;
  }>();
  const sessionDurations = new Map<string, { process: number; overlay: number }>();

  const sessionEvents = events
    // session_start 只用来计启动数（它没有时长字段，增量恒为 0）；时长口径与其它页面共用
    // SESSION_DURATION_EVENTS —— 旧实现只认 heartbeat/end，漏掉 checkpoint 与 unclean_end，
    // 生产实测（30 天）让这张表的运行时长比其它页面低 4.5%。
    .filter((row) => row.machineHash && (["session_start", ...SESSION_DURATION_EVENTS] as readonly string[]).includes(row.event))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

  for (const row of sessionEvents) {
    const machineHash = row.machineHash!;
    const current = byMachine.get(machineHash) || {
      firstSeenAt: row.receivedAt,
      lastSeenAt: row.receivedAt,
      launches: 0,
      sessions: new Set<string>(),
      activeSecs: 0,
      overlayVisibleSecs: 0,
      platform: row.platform || "unknown",
      appVersion: row.appVersion || "unknown",
      licenseStates: new Set<string>(),
    };
    current.firstSeenAt = current.firstSeenAt < row.receivedAt ? current.firstSeenAt : row.receivedAt;
    current.lastSeenAt = current.lastSeenAt > row.receivedAt ? current.lastSeenAt : row.receivedAt;
    current.platform = row.platform || current.platform;
    current.appVersion = row.appVersion || current.appVersion;
    if (row.licenseState) current.licenseStates.add(row.licenseState);
    if (row.event === "session_start") current.launches += 1;
    if (row.sessionId) current.sessions.add(row.sessionId);

    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payloadJson);
      if (isObject(parsed)) payload = parsed;
    } catch {
      // Ignore malformed historical payloads; the raw event remains available.
    }
    if (row.sessionId) {
      const previous = sessionDurations.get(row.sessionId) || { process: 0, overlay: 0 };
      const process = safePayloadDuration(payload, "process_duration_secs");
      const overlay = sessionVisibleSecs(payload, row.event);
      if (process > previous.process) current.activeSecs += process - previous.process;
      if (overlay > previous.overlay) current.overlayVisibleSecs += overlay - previous.overlay;
      sessionDurations.set(row.sessionId, {
        process: Math.max(previous.process, process),
        overlay: Math.max(previous.overlay, overlay),
      });
    }
    byMachine.set(machineHash, current);
  }

  const limit = Math.min(500, Math.max(1, params.limit || 200));
  return Array.from(byMachine.entries())
    .map(([machineHash, row]) => ({
      machineHash,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      activeDays: activeDaysByMachine.get(machineHash)?.size || 0,
      launches: row.launches,
      sessions: row.sessions.size,
      activeSecs: row.activeSecs,
      overlayVisibleSecs: row.overlayVisibleSecs,
      platform: row.platform,
      appVersion: row.appVersion,
      licenseStates: Array.from(row.licenseStates).sort(),
    }))
    .sort((a, b) => b.activeSecs - a.activeSecs || b.activeDays - a.activeDays)
    .slice(0, limit);
}

export type TelemetryInstallDetail = {
  installId: string;
  productId: string;
  /** 摘要与事件列表的统计窗口："all" 表示全历史，否则是最近 N 天。 */
  days: number | "all";
  machineHash: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  platform: string;
  channel: string;
  appVersion: string;
  licenseStates: string[];
  totalEvents: number;
  launches: number;
  sessions: number;
  activeSecs: number;
  overlayVisibleSecs: number;
  firstFrame: boolean;
  workshopOpens: number;
  settingsOpens: number;
  cleanExits: number;
  uncleanExits: number;
  events: TelemetryEventListItem[];
  totalFilteredEvents: number;
};

function telemetryPayload(row: { payloadJson: string }): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payloadJson);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 安装详情页的时长口径与其它页面共用 SESSION_DURATION_EVENTS（原来是本文件里另抄的一份
 * 4 事件数组，属于口径漂移的来源之一，已删除）。
 */
export async function getTelemetryInstallDetail(
  db: Database,
  params: {
    installId: string;
    productId?: string;
    event?: string;
    surface?: string;
    sessionId?: string;
    /** 时间窗：天数（1-365）或 "all"（全历史）。默认 30 天。 */
    days?: number | "all";
    page?: number;
    pageSize?: number;
  }
): Promise<TelemetryInstallDetail> {
  const productId = params.productId || "animate";
  const page = Math.max(1, Math.floor(params.page || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(params.pageSize || 100)));
  const allHistory = params.days === "all";
  const days = allHistory ? 0 : Math.min(365, Math.max(1, Math.floor(Number(params.days) || 30)));
  // 旧实现把该 install 的全部事件（含 payload）拉进 Worker 再在内存里过滤、排序、切片：
  // 单台高频设备 2.2 万条事件时，一次页面浏览就是 2.3 万行读额度。现在窗口 + SQL 侧
  // 过滤分页都在库内完成，Worker 只拿到当前这一页。
  const windowConditions = [
    eq(telemetryEvents.productId, productId),
    eq(telemetryEvents.installId, params.installId),
  ];
  if (days > 0) {
    windowConditions.push(
      gte(telemetryEvents.receivedAt, toSqlDateTime(new Date(Date.now() - (days - 1) * 86400000)))
    );
  }
  const windowWhere = and(...windowConditions);

  const listConditions = [...windowConditions];
  if (params.event) listConditions.push(eq(telemetryEvents.event, params.event));
  if (params.sessionId) listConditions.push(eq(telemetryEvents.sessionId, params.sessionId));
  if (params.surface) {
    // json_valid 兜底：历史脏 payload 不会让整条查询报 "malformed JSON" 而 500。
    listConditions.push(
      sql`(json_valid(${telemetryEvents.payloadJson}) AND json_extract(${telemetryEvents.payloadJson}, '$.surface') = ${params.surface})`
    );
  }
  const listWhere = and(...listConditions);

  // 事件发生时刻：客户端打点时间优先，缺失时退回服务端接收时间（与旧排序一致）。
  const occurredAt = sql`COALESCE(NULLIF(${telemetryEvents.sentAt}, 0), ${telemetryEvents.receivedAtUnix})`;

  const [facts, firstRow, lastRow, machineRow, detailRows, pageRows, totalRow] = await Promise.all([
    // 一条聚合 SQL 拿全部计数类摘要（不读 payload、不把行搬回 Worker）。
    db
      .select({
        totalEvents: count(),
        launches: sql<number>`COALESCE(SUM(CASE WHEN ${telemetryEvents.event} = 'session_start' THEN 1 ELSE 0 END), 0)`,
        sessions: sql<number>`COUNT(DISTINCT ${telemetryEvents.sessionId})`,
        firstFrame: sql<number>`COALESCE(MAX(CASE WHEN ${telemetryEvents.event} = 'first_frame_rendered' THEN 1 ELSE 0 END), 0)`,
        cleanExits: sql<number>`COALESCE(SUM(CASE WHEN ${telemetryEvents.event} = 'session_end' THEN 1 ELSE 0 END), 0)`,
        uncleanExits: sql<number>`COALESCE(SUM(CASE WHEN ${telemetryEvents.event} IN ('session_unclean_detected','session_unclean_end') THEN 1 ELSE 0 END), 0)`,
        firstSeenAt: sql<string | null>`MIN(${telemetryEvents.receivedAt})`,
        lastSeenAt: sql<string | null>`MAX(${telemetryEvents.receivedAt})`,
        licenseStates: sql<string | null>`GROUP_CONCAT(DISTINCT ${telemetryEvents.licenseState})`,
      })
      .from(telemetryEvents)
      .where(windowWhere)
      .get(),
    db
      .select({
        platform: telemetryEvents.platform,
        channel: telemetryEvents.channel,
        appVersion: telemetryEvents.appVersion,
      })
      .from(telemetryEvents)
      .where(windowWhere)
      .orderBy(occurredAt, telemetryEvents.receivedAt)
      .limit(1)
      .get(),
    db
      .select({ appVersion: telemetryEvents.appVersion })
      .from(telemetryEvents)
      .where(windowWhere)
      .orderBy(desc(occurredAt), desc(telemetryEvents.receivedAt))
      .limit(1)
      .get(),
    db
      .select({ machineHash: telemetryEvents.machineHash })
      .from(telemetryEvents)
      .where(and(...windowConditions, isNotNull(telemetryEvents.machineHash)))
      .orderBy(occurredAt, telemetryEvents.receivedAt)
      .limit(1)
      .get(),
    // 只有时长事件和 surface 事件需要 payload；其余 60 多种事件的 payload 一行都不取。
    db
      .select({
        event: telemetryEvents.event,
        sessionId: telemetryEvents.sessionId,
        receivedAt: telemetryEvents.receivedAt,
        payloadJson: telemetryEvents.payloadJson,
      })
      .from(telemetryEvents)
      .where(and(
        ...windowConditions,
        inArray(telemetryEvents.event, [...SESSION_DURATION_EVENTS, "surface_event"])
      ))
      .orderBy(occurredAt, telemetryEvents.receivedAt)
      .all(),
    db
      .select(EVENT_LIST_COLUMNS)
      .from(telemetryEvents)
      .where(listWhere)
      .orderBy(occurredAt, telemetryEvents.receivedAt)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all(),
    db.select({ value: count() }).from(telemetryEvents).where(listWhere).get(),
  ]);

  const sessionMax = new Map<string, { process: number; overlay: number }>();
  let activeSecs = 0;
  let overlayVisibleSecs = 0;
  let workshopOpens = 0;
  let settingsOpens = 0;
  for (const row of detailRows) {
    const payload = telemetryPayload(row);
    if (row.event === "surface_event") {
      if (payload.surface === "workshop" && payload.action === "open") workshopOpens += 1;
      if (payload.surface === "settings" && payload.action === "open") settingsOpens += 1;
      continue;
    }
    if (!row.sessionId) continue;
    const process = safePayloadDuration(payload, "process_duration_secs");
    const visible = sessionVisibleSecs(payload, row.event);
    const previous = sessionMax.get(row.sessionId) || { process: 0, overlay: 0 };
    activeSecs += boundedDelta(process, previous.process);
    overlayVisibleSecs += boundedDelta(visible, previous.overlay);
    sessionMax.set(row.sessionId, {
      process: Math.max(previous.process, process),
      overlay: Math.max(previous.overlay, visible),
    });
  }

  const licenseStates = (facts?.licenseStates || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();

  return {
    installId: params.installId,
    productId,
    days: allHistory ? "all" : days,
    machineHash: machineRow?.machineHash || null,
    firstSeenAt: facts?.firstSeenAt || null,
    lastSeenAt: facts?.lastSeenAt || null,
    platform: firstRow?.platform || "unknown",
    channel: firstRow?.channel || "official",
    appVersion: lastRow?.appVersion || firstRow?.appVersion || "unknown",
    licenseStates,
    totalEvents: Number(facts?.totalEvents || 0),
    launches: Number(facts?.launches || 0),
    sessions: Number(facts?.sessions || 0),
    activeSecs,
    overlayVisibleSecs,
    firstFrame: Number(facts?.firstFrame || 0) > 0,
    workshopOpens,
    settingsOpens,
    cleanExits: Number(facts?.cleanExits || 0),
    uncleanExits: Number(facts?.uncleanExits || 0),
    events: pageRows,
    totalFilteredEvents: Number(totalRow?.value || 0),
  };
}

export type TelemetryUserSummary = {
  machineHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  firstInstallAt: string | null;
  installs: number;
  launches: number;
  sessions: number;
  events: number;
  activeSecs: number;
  overlayVisibleSecs: number;
  recentSessionSecs: number;
  recentSessionAt: string | null;
  lastEvent: string;
  status: "active" | "recently_offline" | "likely_abandoned" | "likely_uninstalled";
  platform: string;
  appVersion: string;
  channel: string;
  licenseStates: string[];
};

function userStatus(lastSeenAt: string): TelemetryUserSummary["status"] {
  const ageSecs = Math.max(0, (Date.now() - new Date(lastSeenAt.replace(" ", "T") + "Z").getTime()) / 1000);
  if (ageSecs <= 6 * 3600) return "active";
  if (ageSecs <= 24 * 3600) return "recently_offline";
  if (ageSecs <= 7 * 86400) return "likely_abandoned";
  return "likely_uninstalled";
}

async function listTelemetryUsersUncached(
  db: Database,
  params: {
    productId?: string;
    q?: string;
    status?: string;
    platform?: string;
    sort?: "last_seen" | "first_seen" | "active_secs";
    /** Look-back window in days (1-365, default 30) — bounds the scan window. */
    days?: number;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ items: TelemetryUserSummary[]; total: number; page: number; pageSize: number }> {
  const productId = params.productId || "animate";
  const days = Math.min(365, Math.max(1, params.days || 30));
  const since = toSqlDateTime(new Date(Date.now() - (days - 1) * 86400000));
  // Windowed + column-pruned: the unscoped SELECT * was the second-largest
  // read-quota burner after the raw-events page.
  const rows = await db
    .select(EVENT_LIST_COLUMNS)
    .from(telemetryEvents)
    .where(and(eq(telemetryEvents.productId, productId), gte(telemetryEvents.receivedAt, since)))
    .all();
  const byMachine = new Map<string, TelemetryUserSummary & { sessionMax: Map<string, { process: number; overlay: number; startedAt: string; lastAt: string }> }>();
  const sessionState = new Map<string, { machineHash: string; process: number; overlay: number; startedAt: string; lastAt: string }>();
  for (const row of rows.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    if (!row.machineHash) continue;
    const current = byMachine.get(row.machineHash) || {
      machineHash: row.machineHash,
      firstSeenAt: row.receivedAt,
      lastSeenAt: row.receivedAt,
      firstInstallAt: null,
      installs: 0,
      launches: 0,
      sessions: 0,
      events: 0,
      activeSecs: 0,
      overlayVisibleSecs: 0,
      recentSessionSecs: 0,
      recentSessionAt: null,
      lastEvent: row.event,
      status: "active" as const,
      platform: row.platform || "unknown",
      appVersion: row.appVersion || "unknown",
      channel: row.channel || "official",
      licenseStates: [] as string[],
      sessionMax: new Map(),
    };
    current.firstSeenAt = current.firstSeenAt < row.receivedAt ? current.firstSeenAt : row.receivedAt;
    current.lastSeenAt = current.lastSeenAt > row.receivedAt ? current.lastSeenAt : row.receivedAt;
    current.lastEvent = row.event;
    current.events += 1;
    current.platform = row.platform || current.platform;
    current.appVersion = row.appVersion || current.appVersion;
    current.channel = row.channel || current.channel;
    if (row.licenseState && !current.licenseStates.includes(row.licenseState)) current.licenseStates.push(row.licenseState);
    if (row.event === "install_seen") {
      current.installs += 1;
      current.firstInstallAt ||= row.receivedAt;
    }
    if (row.event === "session_start") {
      current.launches += 1;
      if (row.sessionId) {
        current.sessions += 1;
        sessionState.set(row.sessionId, { machineHash: row.machineHash, process: 0, overlay: 0, startedAt: row.receivedAt, lastAt: row.receivedAt });
      }
    }
    if (row.sessionId && (SESSION_DURATION_EVENTS as readonly string[]).includes(row.event)) {
      const payload = telemetryPayload(row);
      const process = safePayloadDuration(payload, "process_duration_secs");
      const visible = sessionVisibleSecs(payload, row.event);
      const previous = sessionState.get(row.sessionId) || { machineHash: row.machineHash, process: 0, overlay: 0, startedAt: row.receivedAt, lastAt: row.receivedAt };
      current.activeSecs += boundedDelta(process, previous.process);
      current.overlayVisibleSecs += boundedDelta(visible, previous.overlay);
      previous.process = Math.max(previous.process, process);
      previous.overlay = Math.max(previous.overlay, visible);
      previous.lastAt = row.receivedAt;
      sessionState.set(row.sessionId, previous);
    }
    byMachine.set(row.machineHash, current);
  }
  for (const current of byMachine.values()) {
    const sessions = Array.from(sessionState.values()).filter((session) => session.machineHash === current.machineHash);
    const recent = sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0];
    current.recentSessionSecs = recent?.process || 0;
    current.recentSessionAt = recent?.lastAt || null;
    current.status = userStatus(current.lastSeenAt);
    current.licenseStates.sort();
  }
  let items = Array.from(byMachine.values()).map(({ sessionMax: _sessionMax, ...row }) => row);
  if (params.q) items = items.filter((row) => row.machineHash.includes(params.q!.toLowerCase()));
  if (params.status) items = items.filter((row) => row.status === params.status);
  if (params.platform) items = items.filter((row) => row.platform === params.platform);
  const sort = params.sort || "last_seen";
  items.sort((a, b) => sort === "first_seen" ? b.firstSeenAt.localeCompare(a.firstSeenAt) : sort === "active_secs" ? b.activeSecs - a.activeSecs : b.lastSeenAt.localeCompare(a.lastSeenAt));
  const page = Math.max(1, Math.floor(params.page || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(params.pageSize || 50)));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}

/**
 * 用户详细行为页。
 *
 * 旧实现把这个 machine_hash 的**全部历史**事件（含 payload）拉进 Worker，排序、过滤、
 * 再切出 100 行 —— 生产最活跃的一台设备一次浏览就是 30,362 行；摘要还额外走一遍
 * listTelemetryUsers 的全窗口聚合（那是另一条全表扫描）。
 *
 * 现在：时间窗（默认 30 天）+ 事件/Session 过滤 + LIMIT/OFFSET 全部下推到 SQL，
 * 摘要拆成 3 条窄查询（计数聚合、窗口内最近一行、只有 4 种时长事件带 payload）。
 */
export async function getTelemetryMachineDetail(
  db: Database,
  params: {
    machineHash: string;
    productId?: string;
    event?: string;
    sessionId?: string;
    /** 时间窗：天数（1-365）或 "all"（全历史）。默认 30 天。 */
    days?: number | "all";
    page?: number;
    pageSize?: number;
  },
): Promise<{
  user: TelemetryUserSummary | null;
  events: TelemetryEventListItem[];
  total: number;
  page: number;
  pageSize: number;
  days: number | "all";
}> {
  const productId = params.productId || "animate";
  const machineHash = params.machineHash;
  const page = Math.max(1, Math.floor(params.page || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(params.pageSize || 100)));
  const allHistory = params.days === "all";
  const days = allHistory ? 0 : Math.min(365, Math.max(1, Math.floor(Number(params.days) || 30)));

  const windowConditions = [
    eq(telemetryEvents.productId, productId),
    eq(telemetryEvents.machineHash, machineHash),
  ];
  if (!allHistory) {
    windowConditions.push(
      gte(telemetryEvents.receivedAt, toSqlDateTime(new Date(Date.now() - (days - 1) * 86400000)))
    );
  }
  const windowWhere = and(...windowConditions);

  const listConditions = [...windowConditions];
  if (params.event) listConditions.push(eq(telemetryEvents.event, params.event));
  if (params.sessionId) listConditions.push(eq(telemetryEvents.sessionId, params.sessionId));
  const listWhere = and(...listConditions);
  // 事件发生时刻：客户端打点时间优先，缺失时退回服务端接收时间（与安装详情页一致）。
  const occurredAt = sql`COALESCE(NULLIF(${telemetryEvents.sentAt}, 0), ${telemetryEvents.receivedAtUnix})`;

  const [facts, latestRow, durationRows, pageRows, totalRow] = await Promise.all([
    db
      .select({
        events: count(),
        launches: sql<number>`COALESCE(SUM(CASE WHEN ${telemetryEvents.event} = 'session_start' THEN 1 ELSE 0 END), 0)`,
        sessions: sql<number>`COUNT(DISTINCT ${telemetryEvents.sessionId})`,
        installs: sql<number>`COALESCE(SUM(CASE WHEN ${telemetryEvents.event} = 'install_seen' THEN 1 ELSE 0 END), 0)`,
        firstSeenAt: sql<string | null>`MIN(${telemetryEvents.receivedAt})`,
        lastSeenAt: sql<string | null>`MAX(${telemetryEvents.receivedAt})`,
        firstInstallAt: sql<string | null>`MIN(CASE WHEN ${telemetryEvents.event} = 'install_seen' THEN ${telemetryEvents.receivedAt} END)`,
        licenseStates: sql<string | null>`GROUP_CONCAT(DISTINCT ${telemetryEvents.licenseState})`,
      })
      .from(telemetryEvents)
      .where(windowWhere)
      .get(),
    db
      .select({
        event: telemetryEvents.event,
        appVersion: telemetryEvents.appVersion,
        platform: telemetryEvents.platform,
        channel: telemetryEvents.channel,
      })
      .from(telemetryEvents)
      .where(windowWhere)
      .orderBy(desc(telemetryEvents.receivedAt), desc(telemetryEvents.receivedAtUnix))
      .limit(1)
      .get(),
    // 累计时长仍走原有「按会话取相对增量」的口径，但只读窗口内的 4 种时长事件，
    // 且 payload 只为它们读取（生产最活跃那台 30 天 2,161 行，而不是 30,362 行）。
    db
      .select({
        event: telemetryEvents.event,
        sessionId: telemetryEvents.sessionId,
        receivedAt: telemetryEvents.receivedAt,
        payloadJson: telemetryEvents.payloadJson,
      })
      .from(telemetryEvents)
      .where(and(...windowConditions, inArray(telemetryEvents.event, [...SESSION_DURATION_EVENTS])))
      .orderBy(telemetryEvents.receivedAt)
      .all(),
    db
      .select(EVENT_LIST_COLUMNS)
      .from(telemetryEvents)
      .where(listWhere)
      .orderBy(occurredAt, telemetryEvents.receivedAt)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all(),
    db.select({ value: count() }).from(telemetryEvents).where(listWhere).get(),
  ]);

  let activeSecs = 0;
  let overlayVisibleSecs = 0;
  const sessionMax = new Map<string, { process: number; overlay: number; lastAt: string }>();
  for (const row of durationRows) {
    if (!row.sessionId) continue;
    const payload = telemetryPayload(row);
    const process = safePayloadDuration(payload, "process_duration_secs");
    const visible = sessionVisibleSecs(payload, row.event);
    const previous = sessionMax.get(row.sessionId) || { process: 0, overlay: 0, lastAt: row.receivedAt };
    activeSecs += boundedDelta(process, previous.process);
    overlayVisibleSecs += boundedDelta(visible, previous.overlay);
    previous.process = Math.max(previous.process, process);
    previous.overlay = Math.max(previous.overlay, visible);
    previous.lastAt = row.receivedAt;
    sessionMax.set(row.sessionId, previous);
  }
  // 「最近一次时长」= 最后活跃的那个会话的累计 process 时长（与原实现一致）。
  const recentSession = Array.from(sessionMax.values())
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0];

  const lastSeenAt = facts?.lastSeenAt ?? null;
  const user: TelemetryUserSummary | null = facts && lastSeenAt && Number(facts.events) > 0
    ? {
        machineHash,
        firstSeenAt: facts.firstSeenAt || lastSeenAt,
        lastSeenAt,
        firstInstallAt: facts.firstInstallAt ?? null,
        installs: Number(facts.installs || 0),
        launches: Number(facts.launches || 0),
        sessions: Number(facts.sessions || 0),
        events: Number(facts.events || 0),
        activeSecs,
        overlayVisibleSecs,
        recentSessionSecs: recentSession?.process || 0,
        recentSessionAt: recentSession?.lastAt || null,
        // 与旧实现一致：取窗口内最近一条事件的名称与维度（平台/版本/渠道理论上可能为空，
        // 客户端每条事件都会带，缺失时退回 unknown）。
        lastEvent: latestRow?.event || "",
        status: userStatus(lastSeenAt),
        platform: latestRow?.platform || "unknown",
        appVersion: latestRow?.appVersion || "unknown",
        channel: latestRow?.channel || "official",
        licenseStates: (facts.licenseStates || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .sort(),
      }
    : null;

  return {
    user,
    events: pageRows,
    total: Number(totalRow?.value || 0),
    page,
    pageSize,
    days: allHistory ? "all" : days,
  };
}

function reportDays(value: number | undefined, fallback = 30): number {
  return Math.min(90, Math.max(1, Number.isFinite(value) ? Math.floor(value!) : fallback));
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return dayString(new Date(Date.now() - days * 86400000));
}

function addUtcDays(day: string, days: number): string {
  return dayString(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86400000));
}

/**
 * 每日新增安装报表。
 *
 * 这两个页面原来完全没有缓存：刷新一次、从明细页返回一次，都会把同样的扫描重跑一遍
 * （`loadInstallations` + `loadNewInstallationActions`）。这里套上与其它报表一致的
 * 5 分钟 per-isolate 缓存，重复浏览不再付费。
 */
export async function getInstallationDays(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  const days = reportDays(params.days);
  const productId = params.productId || "animate";
  return cachedReport(`installs:${productId}:${days}`, () =>
    getInstallationDaysUncached(db, { days, productId })
  );
}

async function getInstallationDaysUncached(
  db: Database,
  params: { days: number; productId: string }
) {
  const { days, productId } = params;
  const start = daysAgo(days - 1);
  const installations = await loadInstallations(db, productId, undefined, { from: start });
  const relevantInstallations = installations.filter((row) => row.firstInstalledDay >= start);
  const actions = await loadNewInstallationActions(db, productId, start, daysAgo(0), relevantInstallations);
  const byDay = new Map<string, { installs: number; freeModelUsers: number; modelUploadUsers: number; purchaseUsers: number }>();
  for (const row of installations) {
    if (row.firstInstalledDay < start) continue;
    const summary = byDay.get(row.firstInstalledDay) || {
      installs: 0,
      freeModelUsers: 0,
      modelUploadUsers: 0,
      purchaseUsers: 0,
    };
    const action = actions.get(row.installId);
    summary.installs += 1;
    if (action?.freeModelClicked) summary.freeModelUsers += 1;
    if (action?.modelUploadSucceeded) summary.modelUploadUsers += 1;
    if (action?.purchaseClicked) summary.purchaseUsers += 1;
    byDay.set(row.firstInstalledDay, summary);
  }
  return {
    filters: { days, productId },
    total: Array.from(byDay.values()).reduce((total, value) => total + value.installs, 0),
    days: Array.from({ length: days }, (_, index) => {
      const day = daysAgo(index);
      return {
        day,
        ...(byDay.get(day) || {
          installs: 0,
          freeModelUsers: 0,
          modelUploadUsers: 0,
          purchaseUsers: 0,
        }),
      };
    }),
  };
}

export async function listInstallationsForDay(
  db: Database,
  params: { day: string; productId?: string; page?: number; pageSize?: number }
) {
  const productId = params.productId || "animate";
  const page = Math.max(1, Math.floor(params.page || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize || 25)));
  // 与列表页共用 5 分钟缓存：翻页/返回不再重扫同一天。
  return cachedReport(`installs-day:${productId}:${params.day}:${page}:${pageSize}`, async () => {
    const all = (await loadInstallations(db, productId, undefined, { from: params.day, to: params.day }))
      .filter((row) => row.firstInstalledDay === params.day)
      .sort((a, b) => b.firstInstalledAt.localeCompare(a.firstInstalledAt));
    const actions = await loadNewInstallationActions(db, productId, params.day, params.day, all);
    return {
      items: all.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
        ...row,
        ...(actions.get(row.installId) || emptyNewInstallationActions()),
      })),
      total: all.length,
      page,
      pageSize,
    };
  });
}

type InstallationReportRow = {
  productId: string;
  installId: string;
  machineHash: string | null;
  sourceId: string;
  platform: string;
  channel: string;
  appVersion: string;
  licenseState: string;
  firstInstalledDay: string;
  firstInstalledAt: string;
};

type NewInstallationActions = {
  freeModelClicked: boolean;
  modelUploadSucceeded: boolean;
  purchaseClicked: boolean;
};

const NEW_INSTALLATION_ACTION_EVENTS = [
  "free_model_guide_clicked",
  "model_import_completed",
  "purchase_clicked",
] as const;

function emptyNewInstallationActions(): NewInstallationActions {
  return {
    freeModelClicked: false,
    modelUploadSucceeded: false,
    purchaseClicked: false,
  };
}

/**
 * 「新装当天发生过哪些行为」的标记。
 *
 * 旧实现取 EVENT_LIST_COLUMNS（17 列，含 payload_json）把窗口内的 3 种行为事件全部搬回
 * Worker，再在 JS 里按「首次安装当天」过滤 —— 30 天窗口实测 2,183 行，生产这条查询占了
 * 12% 的数据库执行时间。而真正被用到的只有 install_id 与 event 两列。
 *
 * 现在：只取 3 列（install_id / event / received_at，payload_json 不再读）；日明细页设备数
 * 很少（30~55 台）时把 install_id 推进 SQL，走 (install_id, received_at) 索引，只读这些
 * 设备的行为事件（实测 46 行）。
 */
async function loadNewInstallationActions(
  db: Database,
  productId: string,
  start: string,
  end: string,
  installations: InstallationReportRow[]
): Promise<Map<string, NewInstallationActions>> {
  const installationDayById = new Map(installations.map((row) => [row.installId, row.firstInstalledDay]));
  if (!installationDayById.size) return new Map();

  // D1 单语句最多 100 个绑定参数；这里固定的开销是 1 个 product + 3 个事件 + 2 个时间边界，
  // 因此 install_id 最多放 90 个（报表页 30 天约 1,000 台，那种情况保持原范围只做列裁剪）。
  const installIdFilter = installationDayById.size <= 90
    ? inArray(telemetryEvents.installId, Array.from(installationDayById.keys()))
    : undefined;

  const events = await db.select({
    installId: telemetryEvents.installId,
    event: telemetryEvents.event,
    receivedAt: telemetryEvents.receivedAt,
  }).from(telemetryEvents).where(and(
    eq(telemetryEvents.productId, productId),
    inArray(telemetryEvents.event, [...NEW_INSTALLATION_ACTION_EVENTS]),
    installIdFilter,
    gte(telemetryEvents.receivedAt, `${start} 00:00:00`),
    lte(telemetryEvents.receivedAt, `${end} 23:59:59`)
  )).all();
  const actionsByInstall = new Map<string, NewInstallationActions>();
  for (const event of events) {
    // 只保留「首次安装当天」的行为：时间窗内其它天的同种行为不计入新装漏斗。
    if (!event.installId || installationDayById.get(event.installId) !== event.receivedAt.slice(0, 10)) continue;
    const actions = actionsByInstall.get(event.installId) || emptyNewInstallationActions();
    if (event.event === "free_model_guide_clicked") actions.freeModelClicked = true;
    if (event.event === "model_import_completed") actions.modelUploadSucceeded = true;
    if (event.event === "purchase_clicked") actions.purchaseClicked = true;
    actionsByInstall.set(event.installId, actions);
  }
  return actionsByInstall;
}

async function loadInstallations(
  db: Database,
  productId: string,
  installIds?: string[],
  window?: { from?: string; to?: string }
): Promise<InstallationReportRow[]> {
  if (installIds && !installIds.length) return [];
  const conditions = [
    eq(telemetryEvents.productId, productId),
    eq(telemetryEvents.event, "install_seen"),
  ];
  // 明细页只要当前这一页设备的首次安装时间：按 install_id 收窄后走
  // (install_id, received_at) 索引，扫的是几十台设备，而不是全历史的 install_seen。
  if (installIds) conditions.push(inArray(telemetryEvents.installId, installIds));
  // 报表页只关心窗口内的新增安装，却原来把全历史 install_seen 读进来再用 JS 过滤：
  // 把窗口推进 SQL 后走 (product_id, event, received_at) 索引，只读窗口内的行
  // （30 天窗口实测 2,066 行 -> 965 行）。
  // 注意：这里刻意保留「不加窗口 = 全历史首见」的旧语义，明细页按 install_id 查首次
  // 安装日期时不能带窗口。
  if (window?.from) conditions.push(gte(telemetryEvents.receivedAt, `${window.from} 00:00:00`));
  if (window?.to) conditions.push(lte(telemetryEvents.receivedAt, `${window.to} 23:59:59`));
  const events = await db.select(EVENT_LIST_COLUMNS).from(telemetryEvents)
    .where(and(...conditions)).orderBy(telemetryEvents.receivedAt).all();
  const firstByInstall = new Map<string, InstallationReportRow>();
  for (const event of events) {
    if (!event.installId || firstByInstall.has(event.installId)) continue;
    firstByInstall.set(event.installId, {
      productId: event.productId,
      installId: event.installId,
      machineHash: event.machineHash,
      sourceId: event.sourceId,
      platform: event.platform || "unknown",
      channel: event.channel || "official",
      appVersion: event.appVersion || "unknown",
      licenseState: event.licenseState || "unknown",
      firstInstalledDay: event.receivedAt.slice(0, 10),
      firstInstalledAt: event.receivedAt,
    });
  }
  return Array.from(firstByInstall.values());
}

export async function getActivityDays(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  const days = reportDays(params.days);
  const productId = params.productId || "animate";
  return cachedReport(`activity:${productId}:${days}`, () =>
    getActivityDaysUncached(db, { days, productId })
  );
}

async function getActivityDaysUncached(
  db: Database,
  params: { days: number; productId: string }
) {
  const { days, productId } = params;
  const start = daysAgo(days - 1);
  const today = daysAgo(0);
  const byDay = new Map<string, { devices: number; activeSecs: number; launches: number }>();

  if (await installActiveCoversWindow(db, productId, start, today)) {
    // 聚合路径（30 天窗口实测 103,181 行 -> 约 3.5 千行）：
    //   设备数 = install_active 日唯一标记的条数（与旧口径逐日一致）
    //   启动数 / 活跃时长 = telemetry_daily_metrics 按天求和（入库时的增量累计值）
    const [deviceRows, metricRows] = await Promise.all([
      db
        .select({ day: telemetryDailyUniques.day, devices: count() })
        .from(telemetryDailyUniques)
        .where(and(
          eq(telemetryDailyUniques.productId, productId),
          eq(telemetryDailyUniques.uniqueType, "install_active"),
          gte(telemetryDailyUniques.day, start),
          lte(telemetryDailyUniques.day, today)
        ))
        .groupBy(telemetryDailyUniques.day)
        .all(),
      db
        .select({
          day: telemetryDailyMetrics.day,
          launches: sum(telemetryDailyMetrics.launches),
          activeSecs: sum(telemetryDailyMetrics.activeSecs),
        })
        .from(telemetryDailyMetrics)
        .where(and(
          eq(telemetryDailyMetrics.productId, productId),
          gte(telemetryDailyMetrics.day, start),
          lte(telemetryDailyMetrics.day, today)
        ))
        .groupBy(telemetryDailyMetrics.day)
        .all(),
    ]);
    for (const row of deviceRows) {
      byDay.set(row.day, { devices: Number(row.devices || 0), activeSecs: 0, launches: 0 });
    }
    for (const row of metricRows) {
      const summary = byDay.get(row.day) || { devices: 0, activeSecs: 0, launches: 0 };
      summary.launches = Number(row.launches || 0);
      summary.activeSecs = Number(row.activeSecs || 0);
      byDay.set(row.day, summary);
    }
  } else {
    // 回退路径：窗口起点早于 install_active 的覆盖范围（历史回填没覆盖到）时，
    // 仍然用原始事件重算，保证页面上线顺序不会让报表变空或变小。
    const activity = await loadDailyDeviceActivity(db, productId, start, today);
    for (const row of activity) {
      const summary = byDay.get(row.day) || { devices: 0, activeSecs: 0, launches: 0 };
      summary.devices += 1;
      summary.activeSecs += row.activeSecs;
      summary.launches += row.launches;
      byDay.set(row.day, summary);
    }
  }

  return {
    filters: { days, productId },
    days: Array.from({ length: days }, (_, index) => {
      const day = daysAgo(index);
      const row = byDay.get(day);
      const devices = Number(row?.devices || 0);
      const activeSecs = Number(row?.activeSecs || 0);
      return {
        day,
        devices,
        activeSecs,
        launches: row?.launches || 0,
        averageActiveSecs: devices ? Math.round(activeSecs / devices) : 0,
      };
    }),
  };
}

export async function listActiveDevicesForDay(
  db: Database,
  params: { day: string; productId?: string; page?: number; pageSize?: number }
) {
  const productId = params.productId || "animate";
  const page = Math.max(1, Math.floor(params.page || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize || 25)));
  // 排序在内存里做（当天最多几百台设备），但「历史累计时长」和「安装日期」两列
  // 只在选好这一页之后按 install_id 去取。旧实现为了渲染 25 行，把全历史的会话
  // 事件（生产库已 11 万行 / 100+ MB）整张拉进 Worker，触发了 128 MB 内存上限，
  // 这才是活跃设备表格稳定报 SERVER_ERROR 的直接原因。
  const all = await cachedDeviceActivityForDay(db, productId, params.day);
  const pageRows = all.slice((page - 1) * pageSize, page * pageSize);
  const installIds = Array.from(new Set(pageRows.map((row) => row.installId)));
  const [lifetime, installations] = await Promise.all([
    loadLifetimeUsageByInstall(db, productId, installIds),
    loadInstallations(db, productId, installIds),
  ]);
  const installationById = new Map(installations.map((row) => [row.installId, row]));
  return {
    items: pageRows.map((row) => ({
      ...row,
      firstInstalledAt: installationById.get(row.installId)?.firstInstalledAt || null,
      lifetimeActiveSecs: lifetime.get(row.installId)?.activeSecs || 0,
      lifetimeOverlayVisibleSecs: lifetime.get(row.installId)?.overlayVisibleSecs || 0,
    })),
    total: all.length,
    page,
    pageSize,
  };
}

/**
 * 单日活跃设备，按当日活跃时长倒序。只依赖当天（外加前一天作为跨天会话基线）的
 * 数据，与页码无关，所以整页结果可以缓存：翻页不再重算一次全量扫描。
 */
async function cachedDeviceActivityForDay(
  db: Database,
  productId: string,
  day: string
): Promise<DailyDeviceActivity[]> {
  return cachedReport(`activity-day:${productId}:${day}`, async () => {
    const daily = await loadDailyDeviceActivity(db, productId, day, day);
    return daily.sort(
      (a, b) => b.activeSecs - a.activeSecs || b.lastActiveAt.localeCompare(a.lastActiveAt)
    );
  });
}

type DailyDeviceActivity = {
  day: string;
  productId: string;
  installId: string;
  machineHash: string | null;
  sourceId: string;
  platform: string;
  channel: string;
  appVersion: string;
  licenseState: string;
  launches: number;
  sessions: number;
  activeSecs: number;
  overlayVisibleSecs: number;
  firstActiveAt: string;
  lastActiveAt: string;
};

// DEVICE_ACTIVITY_EVENTS / SESSION_DURATION_EVENTS 都定义在文件上方：
// 活跃标记集合与时长口径是两件不同的事，入库与报表各自必须共用同一份。

const SESSION_DURATION_EVENT_LIST = sql.join(
  SESSION_DURATION_EVENTS.map((event) => sql`${event}`),
  sql`, `
);

// 只取这两个页面真正会读的 11 列，不再 SELECT *（raw_json 一列就占全库文本的 66%，
// 任何报表都不读它）。payload_json 也只对时长事件取值：其余事件
// （session_start / surface_event / 各种产品事件）只是让设备当天算活跃，payload
// 原本读了就丢。置 NULL 后返回行数不变（D1 按 rows_read 计费，所以读额度不变），
// 省的是 D1 传回 Worker 的字节和 JS 里的字符串内存 —— 而 500 正是内存爆掉导致的。
const DEVICE_ACTIVITY_COLUMNS = {
  event: telemetryEvents.event,
  installId: telemetryEvents.installId,
  sessionId: telemetryEvents.sessionId,
  receivedAt: telemetryEvents.receivedAt,
  productId: telemetryEvents.productId,
  machineHash: telemetryEvents.machineHash,
  sourceId: telemetryEvents.sourceId,
  platform: telemetryEvents.platform,
  channel: telemetryEvents.channel,
  appVersion: telemetryEvents.appVersion,
  licenseState: telemetryEvents.licenseState,
  payloadJson: sql<string | null>`CASE WHEN ${telemetryEvents.event} IN (${SESSION_DURATION_EVENT_LIST}) THEN ${telemetryEvents.payloadJson} ELSE NULL END`,
};

// 每次往 Worker 里拉多少天的事件。行数因此有上界，内存不随查询窗口线性增长。
const DEVICE_ACTIVITY_CHUNK_DAYS = 3;

function deviceActivityPayload(payloadJson: string | null): Record<string, unknown> {
  if (!payloadJson) return {};
  try {
    const parsed = JSON.parse(payloadJson);
    return isObject(parsed) ? parsed : {};
  } catch {
    // 历史脏 payload 不参与计数，原始事件本身仍然留着可查。
    return {};
  }
}

async function loadDailyDeviceActivity(
  db: Database,
  productId: string,
  start: string,
  end: string
): Promise<DailyDeviceActivity[]> {
  const rows = new Map<string, DailyDeviceActivity>();
  const sessionDurations = new Map<string, { process: number; visible: number }>();
  // 窗口前一天的事件只用来给「跨天会话」做时长基线，而这个基线只吃 5 种时长事件。
  // 因此不必把当天全部 70 种候选事件读进来（原来非时长事件读了就丢），
  // 实录 2026-10-06：全量 6,773 行 -> 只读时长事件 3,962 行，结果完全一致。
  await seedSessionDurations(db, productId, addUtcDays(start, -1), sessionDurations);
  // 分块读取：received_at 前缀就是日期，块与块首尾相接且全局有序，跨块又沿用同一个
  // sessionDurations 基线，所以分块结果与「一次拉整个窗口」完全一致。
  let cursor = start;
  while (cursor <= end) {
    const candidate = addUtcDays(cursor, DEVICE_ACTIVITY_CHUNK_DAYS - 1);
    const to = candidate < end ? candidate : end;
    await accumulateDeviceActivity(db, productId, cursor, to, sessionDurations, rows);
    cursor = addUtcDays(to, 1);
  }
  return Array.from(rows.values());
}

/**
 * 把窗口开始日之前那一天的会话时长读成基线。规则与旧实现的前置分支逐字一致：
 * 只认同时带 install_id 与 session_id 的时长事件，且只有「值不减」时才覆盖（取较大值）。
 */
async function seedSessionDurations(
  db: Database,
  productId: string,
  day: string,
  sessionDurations: Map<string, { process: number; visible: number }>
): Promise<void> {
  const events = await db.select({
    event: telemetryEvents.event,
    sessionId: telemetryEvents.sessionId,
    payloadJson: telemetryEvents.payloadJson,
  }).from(telemetryEvents).where(and(
    eq(telemetryEvents.productId, productId),
    inArray(telemetryEvents.event, SESSION_DURATION_EVENTS),
    isNotNull(telemetryEvents.installId),
    gte(telemetryEvents.receivedAt, `${day} 00:00:00`),
    lte(telemetryEvents.receivedAt, `${day} 23:59:59`)
  )).orderBy(telemetryEvents.receivedAt).all();

  for (const event of events) {
    if (!event.sessionId) continue;
    const payload = deviceActivityPayload(event.payloadJson);
    const process = safePayloadDuration(payload, "process_duration_secs");
    const visible = sessionVisibleSecs(payload, event.event);
    const previous = sessionDurations.get(event.sessionId) || { process: 0, visible: 0 };
    if (process >= previous.process || visible >= previous.visible) {
      sessionDurations.set(event.sessionId, {
        process: Math.max(previous.process, process),
        visible: Math.max(previous.visible, visible),
      });
    }
  }
}

async function accumulateDeviceActivity(
  db: Database,
  productId: string,
  from: string,
  to: string,
  sessionDurations: Map<string, { process: number; visible: number }>,
  rows: Map<string, DailyDeviceActivity>
): Promise<void> {
  const events = await db.select(DEVICE_ACTIVITY_COLUMNS).from(telemetryEvents).where(and(
    eq(telemetryEvents.productId, productId),
    inArray(telemetryEvents.event, DEVICE_ACTIVITY_EVENTS),
    gte(telemetryEvents.receivedAt, `${from} 00:00:00`),
    lte(telemetryEvents.receivedAt, `${to} 23:59:59`)
  )).orderBy(telemetryEvents.receivedAt).all();
  for (const event of events) {
    if (!event.installId) continue;
    const day = event.receivedAt.slice(0, 10);
    const key = `${day}\u0000${event.installId}`;
    const row = rows.get(key) || {
      day,
      productId: event.productId,
      installId: event.installId,
      machineHash: event.machineHash,
      sourceId: event.sourceId,
      platform: event.platform || "unknown",
      channel: event.channel || "official",
      appVersion: event.appVersion || "unknown",
      licenseState: event.licenseState || "unknown",
      launches: 0,
      sessions: 0,
      activeSecs: 0,
      overlayVisibleSecs: 0,
      firstActiveAt: event.receivedAt,
      lastActiveAt: event.receivedAt,
    };
    row.machineHash = event.machineHash || row.machineHash;
    row.sourceId = event.sourceId;
    row.platform = event.platform || row.platform;
    row.channel = event.channel || row.channel;
    row.appVersion = event.appVersion || row.appVersion;
    row.licenseState = event.licenseState || row.licenseState;
    row.lastActiveAt = event.receivedAt;
    if (event.event === "session_start") {
      row.launches += 1;
      row.sessions += 1;
    }
    if (event.sessionId && SESSION_DURATION_EVENTS.includes(event.event)) {
      const payload = deviceActivityPayload(event.payloadJson);
      const process = safePayloadDuration(payload, "process_duration_secs");
      const visible = sessionVisibleSecs(payload, event.event);
      const previous = sessionDurations.get(event.sessionId) || { process: 0, visible: 0 };
      row.activeSecs += boundedDelta(process, previous.process);
      row.overlayVisibleSecs += boundedDelta(visible, previous.visible);
      sessionDurations.set(event.sessionId, { process, visible });
    }
    rows.set(key, row);
  }
}

async function getRetentionReportUncached(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  const allowedDays = [7, 14, 30];
  const requested = Math.floor(params.days || 30);
  const days = allowedDays.includes(requested) ? requested : 30;
  const productId = params.productId || "animate";
  const start = daysAgo(days - 1);
  const today = daysAgo(0);
  const aggregateCovered = await installActiveCoversWindow(db, productId, start, today);
  let activityKeys: Set<string>;
  let installationRows: InstallationReportRow[];
  if (aggregateCovered) {
    // 留存只需要「某台设备某天活跃过」这一个集合，不需要时长：
    // install_active 日唯一标记正好就是它（30 天窗口实测 103,181 行 -> 3,424 行）。
    const [installs, actives] = await Promise.all([
      loadInstallations(db, productId, undefined, { from: start, to: today }),
      db
        .select({ day: telemetryDailyUniques.day, installId: telemetryDailyUniques.uniqueValue })
        .from(telemetryDailyUniques)
        .where(and(
          eq(telemetryDailyUniques.productId, productId),
          eq(telemetryDailyUniques.uniqueType, "install_active"),
          gte(telemetryDailyUniques.day, start),
          lte(telemetryDailyUniques.day, today)
        ))
        .all(),
    ]);
    installationRows = installs;
    activityKeys = new Set(actives.map((row) => `${row.installId}\u0000${row.day}`));
  } else {
    const [installs, activity] = await Promise.all([
      loadInstallations(db, productId, undefined, { from: start, to: today }),
      loadDailyDeviceActivity(db, productId, start, today),
    ]);
    installationRows = installs;
    activityKeys = new Set(activity.map((row) => `${row.installId}\u0000${row.day}`));
  }
  const installations = installationRows
    .filter((row) => row.firstInstalledDay >= start && row.firstInstalledDay <= today)
    .map((row) => ({ installId: row.installId, cohortDay: row.firstInstalledDay }));
  const offsets = [1, 3, 7, 14].filter((offset) => offset < days);
  const cohorts = new Map<string, string[]>();
  for (const install of installations) {
    const values = cohorts.get(install.cohortDay) || [];
    values.push(install.installId);
    cohorts.set(install.cohortDay, values);
  }
  const rows = Array.from({ length: days }, (_, index) => {
    const cohortDay = daysAgo(index);
    const ids = cohorts.get(cohortDay) || [];
    return {
      cohortDay,
      installs: ids.length,
      retention: Object.fromEntries(offsets.map((offset) => {
        const targetDay = addUtcDays(cohortDay, offset);
        if (targetDay > today) return [offset, null];
        const retained = ids.filter((id) => activityKeys.has(`${id}\u0000${targetDay}`)).length;
        return [offset, {
          devices: retained,
          ratePct: ids.length ? Math.round((retained / ids.length) * 1000) / 10 : 0,
        }];
      })),
    };
  });
  const summary = Object.fromEntries(offsets.map((offset) => {
    const mature = rows.filter((row) => row.retention[offset] !== null);
    const denominator = mature.reduce((total, row) => total + row.installs, 0);
    const numerator = mature.reduce((total, row) => total + (row.retention[offset]?.devices || 0), 0);
    return [offset, { devices: numerator, cohortDevices: denominator, ratePct: percentage(numerator, denominator) }];
  }));
  return { filters: { days, productId }, offsets, rows, summary };
}

/**
 * 每个 install 的历史累计时长。
 *
 * 旧实现回放该产品全历史的 5 种时长事件（外加 JSON.parse），只为了给当前这一页 25 台设备
 * 填两个格子。生产实测（2026-10-17）：单次浏览读 15.9 万行、P50 3.0 秒，占当天数据库
 * 执行时间的 25%。原因是 `install_id IN (…)` 根本没进索引 —— 规划器选的是
 * `(product_id, event, received_at)` 的两个等值前缀，扫描完才逐行过滤 install_id。
 *
 * 现在改读 `telemetry_session_state`：入库时 updateSessionState 已经把每个会话「相对上一次
 * 报值的增量」累计进 last_process_duration_secs / last_overlay_visible_secs（正常单调递增，
 * 即该会话的最大值），按 install_id 求和就是累计值。配合 migration 0017 的
 * (install_id) 索引，25 台设备 = 25 次索引探测（实测 15.9 万行 → 约 500 行、<10 ms）。
 *
 * 口径：与「入库累计值」同源（和活跃设备列表页的 active_secs 一致）。比原始事件回放低
 * 约 0.6%（入库 CAS 丢更新 + 乱序回写，见 docs/telemetry-pagination-optimization-plan-1017.md §1.1）。
 */
async function loadLifetimeUsageByInstall(
  db: Database,
  productId: string,
  installIds?: string[],
): Promise<Map<string, { activeSecs: number; overlayVisibleSecs: number }>> {
  const result = new Map<string, { activeSecs: number; overlayVisibleSecs: number }>();
  if (installIds && !installIds.length) return result;

  const conditions = [eq(telemetrySessionState.productId, productId)];
  if (installIds) conditions.push(inArray(telemetrySessionState.installId, installIds));
  const rows = await db
    .select({
      installId: telemetrySessionState.installId,
      activeSecs: sum(telemetrySessionState.lastProcessDurationSecs),
      overlayVisibleSecs: sum(telemetrySessionState.lastOverlayVisibleSecs),
    })
    .from(telemetrySessionState)
    .where(and(...conditions))
    .groupBy(telemetrySessionState.installId)
    .all();

  for (const row of rows) {
    if (!row.installId) continue;
    result.set(row.installId, {
      activeSecs: Number(row.activeSecs || 0),
      overlayVisibleSecs: Number(row.overlayVisibleSecs || 0),
    });
  }
  return result;
}

async function getStartupDiagnosticsUncached(
  db: Database,
  params: { day?: string; productId?: string } = {}
) {
  const day = params.day || new Date().toISOString().slice(0, 10);
  const productId = params.productId || "animate";
  const events = await db.select(EVENT_LIST_COLUMNS).from(telemetryEvents).where(and(
    eq(telemetryEvents.productId, productId),
    gte(telemetryEvents.receivedAt, `${day} 00:00:00`),
    lte(telemetryEvents.receivedAt, `${day} 23:59:59`),
  )).orderBy(telemetryEvents.receivedAt).all();
  const sessions = new Map<string, {
    sessionId: string; machineHash: string | null; installId: string | null;
    startedAt: string; lastAt: string; checkpoints: number; firstCheckpoint: boolean; oneMinuteCheckpoint: boolean;
    firstFrame: boolean; frontendMounted: boolean; modelLoaded: boolean; startupFailed: boolean;
    processSecs: number; lastStage: string; hasFollowup: boolean;
  }>();
  for (const event of events) {
    const id = event.sessionId;
    if (!id) continue;
    const row = sessions.get(id) || {
      sessionId: id, machineHash: event.machineHash, installId: event.installId,
      startedAt: event.receivedAt, lastAt: event.receivedAt, checkpoints: 0,
      firstCheckpoint: false, oneMinuteCheckpoint: false, firstFrame: false, frontendMounted: false, modelLoaded: false,
      startupFailed: false, processSecs: 0, lastStage: "session_start", hasFollowup: false,
    };
    row.machineHash ||= event.machineHash;
    row.installId ||= event.installId;
    row.lastAt = event.receivedAt;
    if (event.event !== "session_start") row.hasFollowup = true;
    if (event.event === "session_checkpoint" || event.event === "session_heartbeat") {
      row.checkpoints += 1;
      row.firstCheckpoint ||= row.checkpoints === 1;
      try {
        const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
        const processSecs = safePayloadDuration(payload, "process_duration_secs");
        row.processSecs = Math.max(row.processSecs, processSecs);
        row.oneMinuteCheckpoint ||= processSecs >= 60;
      } catch { /* Keep raw event usable even if payload is malformed. */ }
    }
    if (event.event === "session_end" || event.event === "session_unclean_end") {
      try {
        const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
        row.processSecs = Math.max(row.processSecs, safePayloadDuration(payload, "process_duration_secs"));
      } catch { /* Keep raw event usable even if payload is malformed. */ }
    }
    if (event.event === "frontend_mounted") row.frontendMounted = true;
    if (event.event === "model_loaded") row.modelLoaded = true;
    if (event.event === "first_frame_rendered") row.firstFrame = true;
    if (event.event === "startup_failed") { row.startupFailed = true; row.lastStage = "startup_failed"; }
    sessions.set(id, row);
  }
  const rows = Array.from(sessions.values()).map((row) => ({
    ...row,
    diagnosis: row.startupFailed ? "startup_failed" : !row.hasFollowup ? "no_followup_event" : !row.oneMinuteCheckpoint ? "no_1m_checkpoint" : !row.firstFrame ? "no_first_frame" : row.processSecs <= 120 ? "first_frame_short_exit" : "startup_ok",
  })).sort((a, b) => a.processSecs - b.processSecs || a.lastAt.localeCompare(b.lastAt));
  const count = (diagnosis: string) => rows.filter((row) => row.diagnosis === diagnosis).length;
  return {
    day, productId, total: rows.length,
    summary: {
      sessions: rows.length, noFollowup: count("no_followup_event"), no1mCheckpoint: count("no_1m_checkpoint"),
      noFirstFrame: count("no_first_frame"), startupFailed: count("startup_failed"), shortAfterFrame: count("first_frame_short_exit"),
      startupOk: count("startup_ok"),
    },
    rows,
  };
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function productIdentity(row: TelemetryEventListItem): string | null {
  if (row.installId) return `install:${row.installId}`;
  return null;
}

function parseProductEvent(row: TelemetryEventListItem): ProductEvent | null {
  const identity = productIdentity(row);
  if (!identity) return null;
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payloadJson);
    if (isObject(parsed)) payload = parsed;
  } catch {
    // A malformed historical payload remains countable with an unknown surface.
  }
  const rawSurface = typeof payload.surface === "string" ? payload.surface.trim() : "";
  return {
    event: row.event,
    identity,
    occurredAt: row.sentAt ?? row.receivedAtUnix,
    surface: rawSurface || "unknown",
    appVersion: row.appVersion || "unknown",
    channel: row.channel || "unknown",
    licenseState: row.licenseState || "unknown",
  };
}

function buildProductFunnel(
  key: string,
  label: string,
  events: ProductEvent[],
  stages: FunnelStageSpec[],
): ProductFunnel {
  const byIdentity = new Map<string, ProductEvent[]>();
  for (const event of events) {
    const rows = byIdentity.get(event.identity) || [];
    rows.push(event);
    byIdentity.set(event.identity, rows);
  }
  for (const rows of byIdentity.values()) {
    rows.sort((a, b) => a.occurredAt - b.occurredAt);
  }

  const deviceCounts = stages.map(() => 0);
  for (const rows of byIdentity.values()) {
    let earliest = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < stages.length; index += 1) {
      const match = rows.find(
        (row) => row.event === stages[index].event && row.occurredAt >= earliest,
      );
      if (!match) break;
      deviceCounts[index] += 1;
      earliest = match.occurredAt;
    }
  }

  const first = deviceCounts[0] || 0;
  return {
    key,
    label,
    stages: stages.map((stage, index) => ({
      ...stage,
      devices: deviceCounts[index],
      events: events.filter((event) => event.event === stage.event).length,
      fromPreviousPct: percentage(deviceCounts[index], index === 0 ? first : deviceCounts[index - 1]),
      fromFirstPct: percentage(deviceCounts[index], first),
    })),
  };
}

function eventSummary(events: ProductEvent[], eventName: string) {
  const matching = events.filter((event) => event.event === eventName);
  return {
    event: eventName,
    events: matching.length,
    devices: new Set(matching.map((event) => event.identity)).size,
  };
}

async function getProductAnalyticsReportUncached(
  db: Database,
  params: {
    days?: number;
    productId?: string;
    appVersion?: string;
    channel?: string;
    licenseState?: string;
  } = {},
) {
  const days = Math.min(90, Math.max(1, params.days || 14));
  const productId = params.productId || "animate";
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const conditions = [
    gte(telemetryEvents.receivedAt, `${start} 00:00:00`),
    eq(telemetryEvents.productId, productId),
    inArray(telemetryEvents.event, [...PRODUCT_EVENT_NAMES]),
  ];
  if (params.appVersion) conditions.push(eq(telemetryEvents.appVersion, params.appVersion));
  if (params.channel) conditions.push(eq(telemetryEvents.channel, params.channel));
  if (params.licenseState) conditions.push(eq(telemetryEvents.licenseState, params.licenseState));

  const rows = await db
    .select(EVENT_LIST_COLUMNS)
    .from(telemetryEvents)
    .where(and(...conditions))
    .orderBy(telemetryEvents.receivedAt)
    .all();
  const events = rows.map(parseProductEvent).filter((event): event is ProductEvent => !!event);

  const importStages: FunnelStageSpec[] = [
    { key: "clicked", label: "点击导入", event: "model_import_clicked" },
    { key: "picker", label: "打开文件选择器", event: "model_import_picker_opened" },
    { key: "completed", label: "导入成功", event: "model_import_completed" },
  ];
  const purchaseStages: FunnelStageSpec[] = [
    { key: "clicked", label: "点击购买", event: "purchase_clicked" },
    { key: "checkout", label: "打开购买页面", event: "checkout_opened" },
  ];
  // 目标 E path from docs/product/telemetry-plan.md: grant → reminder → click →
  // checkout → activation. Stage order is chronological, matching
  // buildProductFunnel's per-device earliest-match walk.
  const trialStages: FunnelStageSpec[] = [
    { key: "granted", label: "领取试用", event: "trial_granted" },
    { key: "reminder", label: "到期提醒曝光", event: "license_reminder_shown" },
    { key: "clicked", label: "点击购买", event: "purchase_clicked" },
    { key: "checkout", label: "打开购买页面", event: "checkout_opened" },
    { key: "activated", label: "激活生效", event: "license_activated" },
  ];
  const freeModelStages: FunnelStageSpec[] = [
    { key: "guide", label: "点击获取免费模型", event: "free_model_guide_clicked" },
    { key: "import", label: "后续点击导入", event: "model_import_clicked" },
    { key: "completed", label: "导入成功", event: "model_import_completed" },
  ];

  const freeModelSurfaces = [
    ["workshop_model_card", "模型列表卡片"],
    ["license_prompt", "激活/购买提示"],
    ["import_dialog", "添加萌灵对话框"],
  ] as const;
  const surfaceFunnels = freeModelSurfaces.map(([surface, label]) => {
    const guideIdentities = new Set(
      events
        .filter((event) => event.event === "free_model_guide_clicked" && event.surface === surface)
        .map((event) => event.identity),
    );
    const scoped = events.filter(
      (event) => event.event !== "free_model_guide_clicked" || event.surface === surface,
    ).filter((event) => guideIdentities.has(event.identity));
    return {
      surface,
      label,
      funnel: buildProductFunnel(surface, label, scoped, freeModelStages),
    };
  });

  const importFunnel = buildProductFunnel("model_import", "模型导入", events, importStages);
  const purchaseFunnel = buildProductFunnel("purchase", "购买入口", events, purchaseStages);
  const freeModelFunnel = buildProductFunnel("free_model", "免费模型到导入", events, freeModelStages);
  const trialFunnel = buildProductFunnel("trial", "试用到激活", events, trialStages);
  const importClicked = importFunnel.stages[0]?.devices || 0;
  const purchaseClicked = purchaseFunnel.stages[0]?.devices || 0;
  const failedImports = eventSummary(events, "model_import_failed");
  const cancelledImports = eventSummary(events, "model_import_cancelled");
  const purchaseFailures = eventSummary(events, "purchase_failed");

  const dimensionMap = new Map<string, {
    appVersion: string;
    channel: string;
    licenseState: string;
    identities: Set<string>;
    freeModelDevices: Set<string>;
    events: ProductEvent[];
  }>();
  for (const event of events) {
    const dimensionKey = `${event.appVersion}\u0000${event.channel}\u0000${event.licenseState}`;
    const dimension = dimensionMap.get(dimensionKey) || {
      appVersion: event.appVersion,
      channel: event.channel,
      licenseState: event.licenseState,
      identities: new Set<string>(),
      freeModelDevices: new Set<string>(),
      events: [],
    };
    dimension.events.push(event);
    dimension.identities.add(event.identity);
    if (event.event === "free_model_guide_clicked") dimension.freeModelDevices.add(event.identity);
    dimensionMap.set(dimensionKey, dimension);
  }

  const available = {
    appVersions: Array.from(new Set(rows.map((row) => row.appVersion || "unknown"))).sort(),
    channels: Array.from(new Set(rows.map((row) => row.channel || "unknown"))).sort(),
    licenseStates: Array.from(new Set(rows.map((row) => row.licenseState || "unknown"))).sort(),
  };

  return {
    filters: { days, productId, appVersion: params.appVersion, channel: params.channel, licenseState: params.licenseState },
    totals: {
      events: events.length,
      devices: new Set(events.map((event) => event.identity)).size,
      importFailureRatePct: percentage(failedImports.devices, importClicked),
      importCancelRatePct: percentage(cancelledImports.devices, importClicked),
      checkoutFailureRatePct: percentage(purchaseFailures.devices, purchaseClicked),
    },
    funnels: { import: importFunnel, freeModel: freeModelFunnel, purchase: purchaseFunnel, trial: trialFunnel },
    outcomes: { failedImports, cancelledImports, purchaseFailures },
    freeModelSurfaces: surfaceFunnels,
    dimensions: Array.from(dimensionMap.values())
      .map((dimension) => {
        const dimensionImport = buildProductFunnel("dimension_import", "模型导入", dimension.events, importStages);
        const dimensionPurchase = buildProductFunnel("dimension_purchase", "购买入口", dimension.events, purchaseStages);
        const importDevices = dimensionImport.stages[0]?.devices || 0;
        const importCompletedDevices = dimensionImport.stages.at(-1)?.devices || 0;
        const purchaseDevices = dimensionPurchase.stages[0]?.devices || 0;
        const checkoutDevices = dimensionPurchase.stages.at(-1)?.devices || 0;
        return {
          appVersion: dimension.appVersion,
          channel: dimension.channel,
          licenseState: dimension.licenseState,
          devices: dimension.identities.size,
          freeModelDevices: dimension.freeModelDevices.size,
          importDevices,
          importCompletedDevices,
          importConversionPct: percentage(importCompletedDevices, importDevices),
          purchaseDevices,
          checkoutDevices,
          checkoutOpenPct: percentage(checkoutDevices, purchaseDevices),
        };
      })
      .sort((a, b) => b.devices - a.devices),
    available,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  const text = optionalCleanString(value, 256);
  if (!text) throw new TelemetryError("INVALID_REQUEST", `${field} 不能为空`, 400);
  return text;
}

function optionalCleanString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new TelemetryError("INVALID_REQUEST", `${field} 必须是非负整数`, 400);
  }
  return n;
}

function requirePayloadInteger(payload: Record<string, unknown>, field: string): number {
  const n = Number(payload[field]);
  if (!Number.isInteger(n) || n < 0) {
    throw new TelemetryError("INVALID_PAYLOAD", `${field} 必须是非负整数`, 400);
  }
  return n;
}

function safePayloadDuration(payload: Record<string, unknown>, field: string): number {
  const n = Number(payload[field]);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DURATION_SECS) return 0;
  return n;
}

// 0.12.2（AniMate 3f50400）把全部会话事件的可见时长字段统一为
// `companion_visible_secs`，而 ≤0.12.0 的客户端在 heartbeat/session_end 上
// 仍发旧名 `overlay_visible_secs`（checkpoint/unclean 系事件一直用新名）。
// 校验与读取都必须走这两个助手：新名优先、旧名兜底，一次部署兼容各代客户端。
// 否则会出现 0.12.2 心跳/干净退出被整版本拒收的事故（2026-10-06 遥测分析 P0-1）。
const COMPANION_ONLY_VISIBLE_EVENTS = new Set([
  "session_checkpoint",
  "session_unclean_end",
  "session_unclean_detected",
]);

function requireVisibleSecs(payload: Record<string, unknown>, event: string): number {
  if (COMPANION_ONLY_VISIBLE_EVENTS.has(event)) {
    return requirePayloadInteger(payload, "companion_visible_secs");
  }
  if (payload.companion_visible_secs !== undefined) {
    return requirePayloadInteger(payload, "companion_visible_secs");
  }
  return requirePayloadInteger(payload, "overlay_visible_secs");
}

function sessionVisibleSecs(payload: Record<string, unknown>, event: string): number {
  if (COMPANION_ONLY_VISIBLE_EVENTS.has(event)) {
    return safePayloadDuration(payload, "companion_visible_secs");
  }
  if (payload.companion_visible_secs !== undefined) {
    return safePayloadDuration(payload, "companion_visible_secs");
  }
  return safePayloadDuration(payload, "overlay_visible_secs");
}

function numberFromPayload(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function boundedDelta(current: number, previous: number): number {
  if (current <= previous) return 0;
  const delta = current - previous;
  return delta > MAX_DURATION_SECS ? 0 : delta;
}

/**
 * Rows affected by a raw `db.run(sql\`…\`)`, normalised across drivers: the D1
 * driver reports `meta.changes`, better-sqlite3 (tests) reports `changes`.
 */
function changesOf(result: unknown): number {
  const r = result as { meta?: { changes?: number }; changes?: number } | null;
  return Number(r?.meta?.changes ?? r?.changes ?? 0);
}

function validUuidish(value: string): boolean {
  return UUID_RE.test(value) || /^[a-zA-Z0-9_-]{8,64}$/.test(value);
}

function normalizePlatform(value: string): string {
  const platform = value.toLowerCase();
  if (platform === "win32" || platform === "windows") return "windows";
  if (platform === "darwin" || platform === "mac" || platform === "macos") return "macos";
  if (platform === "linux") return "linux";
  return "unknown";
}

function normalizeLicenseState(value: string | null): string {
  if (!value) return "unknown";
  const state = value.toLowerCase();
  return LICENSE_STATES.has(state) ? state : "unknown";
}

function toSqlDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").substring(0, 19);
}
