/**
 * AniMate Licence Server entry point.
 */

import { Hono } from "hono";
import { loadConfig } from "./config";
import { createDb } from "./db/index";
import { seedDefaultProduct } from "./db/seed";
import { classifyRequestSurface, pathAllowedForSurface } from "./host_routing";
import { authMiddleware, readSessionCookie, validateSession } from "./middleware/auth";
import { createAdminApiRouter } from "./routes/admin_api";
import { createAdminUiRouter, renderAdminDashboard } from "./routes/admin_ui";
import { createV1Router } from "./routes/v1";
import { createWebhookRouter } from "./routes/webhook";
import { createCreemAdapter } from "./services/creem";
import { createProviderRegistry } from "./services/provider";

export interface Env {
  DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  RSA_PRIVATE_KEY_PKCS8_HEX?: string;
  DEFAULT_APP_VERSION?: string;
  DEFAULT_PRODUCT_ID?: string;
  CORS_ORIGINS?: string;
  API_HOSTNAMES?: string;
  ADMIN_HOSTNAMES?: string;
  ACTIVATE_RATE_LIMIT_IP_MAX?: string;
  ACTIVATE_RATE_LIMIT_IP_WINDOW_SECONDS?: string;
  ACTIVATE_RATE_LIMIT_IP_FAIL_MAX?: string;
  ACTIVATE_RATE_LIMIT_IP_FAIL_WINDOW_SECONDS?: string;
  ACTIVATE_RATE_LIMIT_ORDER_FAIL_MAX?: string;
  ACTIVATE_RATE_LIMIT_ORDER_FAIL_WINDOW_SECONDS?: string;
  TELEMETRY_TOKENS?: string;
  CREEM_API_KEY?: string;
  CREEM_TEST_MODE?: string;
  CREEM_DEFAULT_PRODUCT_ID?: string;
  CREEM_DEFAULT_PLAN_ID?: string;
}

async function initApp(env: Env): Promise<Hono> {
  const db = createDb(env.DB);
  await seedDefaultProduct(db);

  const config = loadConfig(env as unknown as Record<string, string | undefined>);

  // Build provider registry.
  const registry = createProviderRegistry();
  if (config.creemApiKey) {
    registry.register(
      createCreemAdapter({ apiKey: config.creemApiKey, testMode: config.creemTestMode })
    );
  }

  const app = new Hono();

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const surface = classifyRequestSurface(c.req.url, config);

    if (surface === "unknown" || !pathAllowedForSurface(url.pathname, surface)) {
      return c.json({ error: "NOT_FOUND", message: "端点不存在" }, 404);
    }

    if (surface === "api" && url.pathname === "/") {
      return c.json({
        status: "ok",
        service: "animate-licence-server",
        surface: "api",
      });
    }

    if (surface === "admin" && url.pathname === "/") {
      return c.redirect("/admin/");
    }

    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok", service: "animate-licence-server" }));
  app.get("/", (c) => c.redirect("/admin/"));
  app.route("/v1", createV1Router(db, config, registry));
  app.route("/webhooks", createWebhookRouter(db, config, registry));

  app.get("/admin", (c) => c.redirect("/admin/"));
  app.get("/admin/", async (c) => {
    const token = readSessionCookie(c.req.header("cookie") || "");
    if (!(await validateSession(token, config.sessionSecret))) {
      return c.redirect("/admin/login");
    }
    return c.html(await renderAdminDashboard(db, c.req.query("success") || ""));
  });

  app.use("/admin/api/*", authMiddleware(config));
  app.route("/admin/api", createAdminApiRouter(db, config, registry));
  app.route("/admin", createAdminUiRouter(db, config));

  app.notFound((c) => c.json({ error: "NOT_FOUND", message: "端点不存在" }, 404));
  app.onError((err, c) => {
    console.error("Unhandled:", err);
    return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
  });

  return app;
}

let appPromise: Promise<Hono> | null = null;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AniMate-Telemetry-Token",
  "Access-Control-Max-Age": "86400",
};

function addCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (!appPromise) appPromise = initApp(env);
      const app = await appPromise;
      return addCors(await app.fetch(request));
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      return new Response(message, {
        status: 500,
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    }
  },
};
