/**
 * Admin session authentication middleware for Hono.
 * Uses cookie-based sessions (simple implementation).
 */

import type { Context, Next } from "hono";
import type { AppConfig } from "../config";

const SESSION_COOKIE = "animate_admin_session";
const SESSION_MAX_AGE = 86400; // 24 hours

// In-memory session store (per isolate). Use KV for production.
const sessions = new Map<string, { username: string; expiresAt: number }>();

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createSession(username: string): string {
  const token = generateToken();
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
  });
  return token;
}

export function validateSession(token: string | undefined): boolean {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function authMiddleware(config: AppConfig) {
  return async (c: Context, next: Next) => {
    const path = c.req.path;

    // Allow login page and login POST without auth
    if (path === "/admin/login" || path === "/admin") {
      return next();
    }

    // All other routes need a valid session
    const cookie = c.req.header("cookie") || "";
    const sessionToken = extractCookie(cookie, SESSION_COOKIE);
    if (!validateSession(sessionToken)) {
      // For API endpoints, return JSON error
      if (path.startsWith("/admin/api/")) {
        return c.json({ error: "UNAUTHORIZED", message: "请先登录" }, 401);
      }
      // For UI pages, redirect to login
      return c.redirect("/admin/login");
    }

    return next();
  };
}

function extractCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

export { SESSION_COOKIE, SESSION_MAX_AGE };
