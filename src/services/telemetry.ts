import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  telemetryDailyMetrics,
  telemetryDailyUniques,
  telemetryEvents,
  telemetrySessionState,
} from "../db/schema";

const SCHEMA_VERSION = 1;
const MAX_DURATION_SECS = 7 * 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_RE = /^[a-z0-9_-]{1,64}$/;
const MACHINE_HASH_RE = /^[0-9a-f]{64}$/i;

const EVENT_NAMES = new Set([
  "install_seen",
  "session_start",
  "session_heartbeat",
  "session_end",
  "download_click",
]);

const LICENSE_STATES = new Set([
  "free",
  "active",
  "expired",
  "invalid",
  "machine_mismatch",
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
  if (schemaVersion !== SCHEMA_VERSION) {
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
  if (event === "session_heartbeat") {
    requirePayloadInteger(params.payload, "seq");
    requirePayloadInteger(params.payload, "process_duration_secs");
    requirePayloadInteger(params.payload, "overlay_visible_secs");
  }
  if (event === "session_end") {
    requirePayloadInteger(params.payload, "process_duration_secs");
    requirePayloadInteger(params.payload, "overlay_visible_secs");
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

  if (["session_start", "session_heartbeat", "session_end"].includes(envelope.event)) {
    if (envelope.machineHash) {
      await insertDailyUnique(db, dims, "machine_active", envelope.machineHash, receivedAt);
    }
    if (envelope.sessionId) {
      await insertDailyUnique(db, dims, "session_seen", envelope.sessionId, receivedAt);
    }
  }

  if (envelope.event === "session_heartbeat" || envelope.event === "session_end") {
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
  const overlayDuration = safePayloadDuration(envelope.payload, "overlay_visible_secs");
  const current = await db
    .select()
    .from(telemetrySessionState)
    .where(eq(telemetrySessionState.sessionId, envelope.sessionId))
    .get();
  const activeSecs = current ? boundedDelta(processDuration, current.lastProcessDurationSecs) : 0;
  const overlayVisibleSecs = current
    ? boundedDelta(overlayDuration, current.lastOverlayVisibleSecs)
    : 0;

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
