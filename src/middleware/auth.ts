/**
 * Admin session authentication middleware.
 *
 * Sessions are stateless signed cookies so local Worker isolate refreshes do not
 * invalidate an already-issued admin session.
 */

import type { Context, Next } from "hono";
import type { AppConfig } from "../config";

const SESSION_COOKIE = "animate_admin_session";
const SESSION_MAX_AGE = 86400; // 24 hours

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function randomHex(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToHex(buffer);
}

async function hmacHex(payloadHex: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadHex)
  );
  return bytesToHex(new Uint8Array(signature));
}

function payloadToHex(payload: Record<string, unknown>): string {
  return bytesToHex(new TextEncoder().encode(JSON.stringify(payload)));
}

function payloadFromHex(payloadHex: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(hexToBytes(payloadHex))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function extractCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function createSession(
  username: string,
  sessionSecret: string
): Promise<string> {
  const payloadHex = payloadToHex({
    username,
    nonce: randomHex(),
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
  });
  return `${payloadHex}.${await hmacHex(payloadHex, sessionSecret)}`;
}

export async function validateSession(
  token: string | undefined,
  sessionSecret: string
): Promise<boolean> {
  if (!token) return false;
  const [payloadHex, signatureHex] = token.split(".");
  if (!payloadHex || !signatureHex) return false;

  const expected = await hmacHex(payloadHex, sessionSecret);
  if (expected.length !== signatureHex.length || expected !== signatureHex) {
    return false;
  }

  const payload = payloadFromHex(payloadHex);
  const expiresAt = Number(payload?.expiresAt || 0);
  return !!payload?.username && expiresAt > Date.now();
}

export function destroySession(_token: string): void {
  // Stateless sessions are invalidated client-side by expiring the cookie.
}

export function readSessionCookie(cookieHeader: string): string | undefined {
  return extractCookie(cookieHeader, SESSION_COOKIE);
}

export function authMiddleware(config: AppConfig) {
  return async (c: Context, next: Next) => {
    const path = c.req.path;

    if (path === "/admin/login" || path === "/admin") {
      return next();
    }

    const sessionToken = readSessionCookie(c.req.header("cookie") || "");
    if (!(await validateSession(sessionToken, config.sessionSecret))) {
      if (path.startsWith("/admin/api/")) {
        return c.json({ error: "UNAUTHORIZED", message: "请先登录" }, 401);
      }
      return c.redirect("/admin/login");
    }

    return next();
  };
}

export { SESSION_COOKIE, SESSION_MAX_AGE };
