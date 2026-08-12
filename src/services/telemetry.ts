import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
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

const EVENT_NAMES = new Set([
  "install_seen",
  "session_start",
  "session_heartbeat",
  "session_checkpoint",
  "session_end",
  "session_unclean_end",
  "download_click",
  "native_started",
  "webview_created",
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
  "purchase_clicked",
  "checkout_opened",
  "purchase_failed",
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

const PRODUCT_EVENT_NAMES = [
  "model_import_clicked",
  "model_import_picker_opened",
  "model_import_completed",
  "model_import_failed",
  "model_import_cancelled",
  "free_model_guide_clicked",
  "purchase_clicked",
  "checkout_opened",
  "purchase_failed",
] as const;

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
  const existing = await db
    .select({ eventId: telemetryEvents.eventId })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.eventId, envelope.eventId))
    .get();
  if (existing) return { ok: true, duplicate: true };

  await db.insert(telemetryEvents).values({
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
  });

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
    if (event === "session_heartbeat") {
      requirePayloadInteger(params.payload, "overlay_visible_secs");
    } else {
      requirePayloadInteger(params.payload, "companion_visible_secs");
    }
  }
  if (event === "session_end" || event === "session_unclean_end") {
    requirePayloadInteger(params.payload, "process_duration_secs");
    if (event === "session_end") {
      requirePayloadInteger(params.payload, "overlay_visible_secs");
    } else {
      requirePayloadInteger(params.payload, "companion_visible_secs");
    }
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

  if (["session_start", "session_heartbeat", "session_checkpoint", "session_end", "session_unclean_end"].includes(envelope.event)) {
    if (envelope.machineHash) {
      await insertDailyUnique(db, dims, "machine_active", envelope.machineHash, receivedAt);
    }
    if (envelope.sessionId) {
      await insertDailyUnique(db, dims, "session_seen", envelope.sessionId, receivedAt);
    }
  }

  if (["session_heartbeat", "session_checkpoint", "session_end", "session_unclean_end"].includes(envelope.event)) {
    const delta = await updateSessionState(db, envelope, sourceId, receivedAtUnix, receivedAt);
    activeSecs = delta.activeSecs;
    overlayVisibleSecs = delta.overlayVisibleSecs;
  } else if (envelope.event === "session_start" && envelope.sessionId) {
    await upsertSessionState(db, envelope, sourceId, receivedAtUnix, receivedAt, 0, 0);
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
  const existing = await db
    .select({ uniqueValue: telemetryDailyUniques.uniqueValue })
    .from(telemetryDailyUniques)
    .where(
      and(
        eq(telemetryDailyUniques.day, dims.day),
        eq(telemetryDailyUniques.productId, dims.productId),
        eq(telemetryDailyUniques.uniqueType, uniqueType),
        eq(telemetryDailyUniques.uniqueValue, uniqueValue)
      )
    )
    .get();
  if (existing) return false;
  await db.insert(telemetryDailyUniques).values({
    ...dims,
    uniqueType,
    uniqueValue,
    firstSeenAt,
  });
  return true;
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
  const overlayDuration = safePayloadDuration(
    envelope.payload,
    envelope.event === "session_checkpoint" || envelope.event === "session_unclean_end"
      ? "companion_visible_secs"
      : "overlay_visible_secs"
  );
  const current = await db
    .select()
    .from(telemetrySessionState)
    .where(eq(telemetrySessionState.sessionId, envelope.sessionId))
    .get();
  const activeSecs = current ? boundedDelta(processDuration, current.lastProcessDurationSecs) : processDuration;
  const overlayVisibleSecs = current
    ? boundedDelta(overlayDuration, current.lastOverlayVisibleSecs)
    : overlayDuration;

  await upsertSessionState(
    db,
    envelope,
    sourceId,
    receivedAtUnix,
    receivedAt,
    processDuration,
    overlayDuration
  );
  return { activeSecs, overlayVisibleSecs };
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
  const current = await db
    .select()
    .from(telemetrySessionState)
    .where(eq(telemetrySessionState.sessionId, envelope.sessionId))
    .get();
  const values = {
    productId: envelope.productId,
    machineHash: envelope.machineHash,
    installId: envelope.installId,
    appVersion: envelope.appVersion,
    platform: envelope.platform,
    channel: envelope.channel,
    licenseState: envelope.licenseState,
    sourceId,
    startedAt: numberFromPayload(envelope.payload.started_at) ?? envelope.sentAt ?? receivedAtUnix,
    lastEventAt: receivedAtUnix,
    lastProcessDurationSecs: processDuration,
    lastOverlayVisibleSecs: overlayDuration,
    updatedAt: receivedAt,
  };
  if (current) {
    await db
      .update(telemetrySessionState)
      .set(values)
      .where(eq(telemetrySessionState.sessionId, envelope.sessionId));
  } else {
    await db.insert(telemetrySessionState).values({ sessionId: envelope.sessionId, ...values });
  }
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
  const existing = await db
    .select()
    .from(telemetryDailyMetrics)
    .where(dimsWhere(dims))
    .get();
  if (!existing) {
    await db.insert(telemetryDailyMetrics).values({ ...dims, ...inc });
    return;
  }
  await db
    .update(telemetryDailyMetrics)
    .set({
      downloads: existing.downloads + inc.downloads,
      installs: existing.installs + inc.installs,
      launches: existing.launches + inc.launches,
      activeSecs: existing.activeSecs + inc.activeSecs,
      overlayVisibleSecs: existing.overlayVisibleSecs + inc.overlayVisibleSecs,
      events: existing.events + inc.events,
      updatedAt: toSqlDateTime(new Date()),
    })
    .where(dimsWhere(dims));
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

export async function listTelemetryEvents(
  db: Database,
  params: {
    event?: string;
    productId?: string;
    machineHash?: string;
    installId?: string;
    sessionId?: string;
    page?: number;
    pageSize?: number;
  } = {}
): Promise<{ items: TelemetryEventRow[]; total: number }> {
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize || 80));
  const all = await db.select().from(telemetryEvents).orderBy(desc(telemetryEvents.receivedAt)).all();
  const filtered = all.filter((item) => {
    if (params.event && item.event !== params.event) return false;
    if (params.productId && item.productId !== params.productId) return false;
    if (params.machineHash && !(item.machineHash || "").includes(params.machineHash)) return false;
    if (params.installId && !(item.installId || "").includes(params.installId)) return false;
    if (params.sessionId && !(item.sessionId || "").includes(params.sessionId)) return false;
    return true;
  });
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
  };
}

export async function getTelemetryReport(
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
      .select()
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
    .filter((row) => row.machineHash && ["session_start", "session_heartbeat", "session_end"].includes(row.event))
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
      const overlay = safePayloadDuration(payload, "overlay_visible_secs");
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

export async function getInstallationDays(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  const days = reportDays(params.days);
  const productId = params.productId || "animate";
  const start = daysAgo(days - 1);
  const installations = await loadInstallations(db, productId);
  const byDay = new Map<string, number>();
  for (const row of installations) {
    if (row.firstInstalledDay >= start) byDay.set(row.firstInstalledDay, (byDay.get(row.firstInstalledDay) || 0) + 1);
  }
  return {
    filters: { days, productId },
    total: Array.from(byDay.values()).reduce((total, value) => total + value, 0),
    days: Array.from({ length: days }, (_, index) => {
      const day = daysAgo(index);
      return { day, installs: byDay.get(day) || 0 };
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
  const all = (await loadInstallations(db, productId))
    .filter((row) => row.firstInstalledDay === params.day)
    .sort((a, b) => b.firstInstalledAt.localeCompare(a.firstInstalledAt));
  return {
    items: all.slice((page - 1) * pageSize, page * pageSize),
    total: all.length,
    page,
    pageSize,
  };
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

async function loadInstallations(db: Database, productId: string): Promise<InstallationReportRow[]> {
  const events = await db.select().from(telemetryEvents).where(and(
    eq(telemetryEvents.productId, productId),
    eq(telemetryEvents.event, "install_seen")
  )).orderBy(telemetryEvents.receivedAt).all();
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
  const start = daysAgo(days - 1);
  const activity = await loadDailyDeviceActivity(db, productId, start, daysAgo(0));
  const byDay = new Map<string, { devices: number; activeSecs: number; launches: number }>();
  for (const row of activity) {
    const summary = byDay.get(row.day) || { devices: 0, activeSecs: 0, launches: 0 };
    summary.devices += 1;
    summary.activeSecs += row.activeSecs;
    summary.launches += row.launches;
    byDay.set(row.day, summary);
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
  const all = (await loadDailyDeviceActivity(db, productId, params.day, params.day))
    .sort((a, b) => b.activeSecs - a.activeSecs || b.lastActiveAt.localeCompare(a.lastActiveAt));
  return {
    items: all.slice((page - 1) * pageSize, page * pageSize),
    total: all.length,
    page,
    pageSize,
  };
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

async function loadDailyDeviceActivity(
  db: Database,
  productId: string,
  start: string,
  end: string
): Promise<DailyDeviceActivity[]> {
  const sessionEvents = ["session_start", "session_heartbeat", "session_checkpoint", "session_end", "session_unclean_end"];
  const events = await db.select().from(telemetryEvents).where(and(
    eq(telemetryEvents.productId, productId),
    inArray(telemetryEvents.event, sessionEvents),
    gte(telemetryEvents.receivedAt, `${start} 00:00:00`),
    lte(telemetryEvents.receivedAt, `${end} 23:59:59`)
  )).orderBy(telemetryEvents.receivedAt).all();
  const rows = new Map<string, DailyDeviceActivity>();
  const sessionDurations = new Map<string, { process: number; visible: number }>();
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
    if (event.sessionId && event.event !== "session_start") {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(event.payloadJson); } catch { /* Ignore malformed history. */ }
      const process = safePayloadDuration(payload, "process_duration_secs");
      const visibleKey = event.event === "session_checkpoint" || event.event === "session_unclean_end"
        ? "companion_visible_secs"
        : "overlay_visible_secs";
      const visible = safePayloadDuration(payload, visibleKey);
      const previous = sessionDurations.get(event.sessionId) || { process: 0, visible: 0 };
      row.activeSecs += boundedDelta(process, previous.process);
      row.overlayVisibleSecs += boundedDelta(visible, previous.visible);
      sessionDurations.set(event.sessionId, { process, visible });
    }
    rows.set(key, row);
  }
  return Array.from(rows.values());
}

export async function getRetentionReport(
  db: Database,
  params: { days?: number; productId?: string } = {}
) {
  const allowedDays = [7, 14, 30];
  const requested = Math.floor(params.days || 30);
  const days = allowedDays.includes(requested) ? requested : 30;
  const productId = params.productId || "animate";
  const start = daysAgo(days - 1);
  const today = daysAgo(0);
  const [installationRows, activity] = await Promise.all([
    loadInstallations(db, productId),
    loadDailyDeviceActivity(db, productId, start, today),
  ]);
  const installations = installationRows
    .filter((row) => row.firstInstalledDay >= start && row.firstInstalledDay <= today)
    .map((row) => ({ installId: row.installId, cohortDay: row.firstInstalledDay }));
  const activityKeys = new Set(activity.map((row) => `${row.installId}\u0000${row.day}`));
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

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function productIdentity(row: TelemetryEventRow): string | null {
  if (row.installId) return `install:${row.installId}`;
  return null;
}

function parseProductEvent(row: TelemetryEventRow): ProductEvent | null {
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

export async function getProductAnalyticsReport(
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
    .select()
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
    funnels: { import: importFunnel, freeModel: freeModelFunnel, purchase: purchaseFunnel },
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

function numberFromPayload(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function boundedDelta(current: number, previous: number): number {
  if (current <= previous) return 0;
  const delta = current - previous;
  return delta > MAX_DURATION_SECS ? 0 : delta;
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
