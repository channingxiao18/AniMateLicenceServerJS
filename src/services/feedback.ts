import type { Database } from "../db/index";
import { feedbackSubmissions } from "../db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

const MAX_MESSAGE_CHARS = 500;
const MAX_CONTACT_CHARS = 120;
const MAX_APP_VERSION_CHARS = 64;
const MAX_LOCALE_CHARS = 32;
const MAX_SOURCE_CHARS = 32;
const MAX_PLATFORM_CHARS = 32;
const MAX_CHANNEL_CHARS = 32;
const MACHINE_HASH_RE = /^[0-9a-f]{64}$/i;

const SOURCES = new Set(["store_review"]);
const PLATFORMS = new Set(["windows"]);
const CHANNELS = new Set(["microsoft_store", "unpackaged"]);

export class FeedbackError extends Error {
  error: string;
  statusCode: 400 | 413 | 500;

  constructor(error: string, message: string, statusCode: 400 | 413 | 500 = 400) {
    super(message);
    this.name = "FeedbackError";
    this.error = error;
    this.statusCode = statusCode;
  }
}

type FeedbackBody = {
  source?: unknown;
  message?: unknown;
  contact?: unknown;
  app_version?: unknown;
  locale?: unknown;
  platform?: unknown;
  channel?: unknown;
  client_time_ms?: unknown;
  machine_hash?: unknown;
};

export type FeedbackRequest = {
  source: string;
  message: string;
  contact: string | null;
  appVersion: string | null;
  locale: string | null;
  platform: string;
  channel: string;
  clientTimeMs: number | null;
  machineHash: string;
  ipAddress: string | null;
  userAgent: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, field: string, maxChars: number, required = false): string | null {
  if (value == null) {
    if (required) throw new FeedbackError("INVALID_REQUEST", `${field} 不能为空`);
    return null;
  }
  if (typeof value !== "string") {
    throw new FeedbackError("INVALID_REQUEST", `${field} 必须是字符串`);
  }
  const cleaned = value.trim();
  if (required && !cleaned) throw new FeedbackError("INVALID_REQUEST", `${field} 不能为空`);
  if (cleaned.length > maxChars) {
    throw new FeedbackError("INVALID_REQUEST", `${field} 不能超过 ${maxChars} 个字符`);
  }
  return cleaned || null;
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FeedbackError("INVALID_REQUEST", `${field} 必须是非负整数`);
  }
  return value;
}

export function validateFeedbackBody(body: unknown): Omit<FeedbackRequest, "ipAddress" | "userAgent"> {
  if (!isObject(body)) throw new FeedbackError("INVALID_JSON", "请求体格式无效");
  const raw = body as FeedbackBody;
  const source = cleanString(raw.source, "source", MAX_SOURCE_CHARS, true)!;
  if (!SOURCES.has(source)) throw new FeedbackError("INVALID_SOURCE", "source 不受支持");
  const message = cleanString(raw.message, "message", MAX_MESSAGE_CHARS, true)!;
  const contact = cleanString(raw.contact, "contact", MAX_CONTACT_CHARS);
  const appVersion = cleanString(raw.app_version, "app_version", MAX_APP_VERSION_CHARS);
  const locale = cleanString(raw.locale, "locale", MAX_LOCALE_CHARS);
  const platform = cleanString(raw.platform, "platform", MAX_PLATFORM_CHARS, true)!;
  if (!PLATFORMS.has(platform)) throw new FeedbackError("INVALID_PLATFORM", "platform 不受支持");
  const channel = cleanString(raw.channel, "channel", MAX_CHANNEL_CHARS, true)!;
  if (!CHANNELS.has(channel)) throw new FeedbackError("INVALID_CHANNEL", "channel 不受支持");
  const clientTimeMs = optionalInteger(raw.client_time_ms, "client_time_ms");
  const machineHash = cleanString(raw.machine_hash, "machine_hash", 64, true)!.toLowerCase();
  if (!MACHINE_HASH_RE.test(machineHash)) {
    throw new FeedbackError("INVALID_MACHINE_HASH", "machine_hash 无效");
  }
  return { source, message, contact, appVersion, locale, platform, channel, clientTimeMs, machineHash };
}

export async function recordFeedback(
  db: Database,
  body: unknown,
  context: { ipAddress?: string | null; userAgent?: string | null }
): Promise<{ status: "submitted" }> {
  const request = validateFeedbackBody(body);
  await db.insert(feedbackSubmissions).values({
    source: request.source,
    message: request.message,
    contact: request.contact,
    appVersion: request.appVersion,
    locale: request.locale,
    platform: request.platform,
    channel: request.channel,
    clientTimeMs: request.clientTimeMs,
    machineHash: request.machineHash,
    ipAddress: context.ipAddress || null,
    userAgent: context.userAgent || null,
  }).run();
  return { status: "submitted" };
}

export async function feedbackCountForMachine(db: Database, machineHash: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(feedbackSubmissions)
    .where(
      and(
        eq(feedbackSubmissions.machineHash, machineHash),
        gte(feedbackSubmissions.createdAt, sql`datetime('now', '-1 day')`)
      )
    )
    .get();
  return Number(row?.count || 0);
}

export const feedbackLimits = {
  maxMessageChars: MAX_MESSAGE_CHARS,
  maxContactChars: MAX_CONTACT_CHARS,
};
