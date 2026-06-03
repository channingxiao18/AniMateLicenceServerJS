/**
 * Webhook receiver route for payment providers.
 *
 * POST /webhooks/:provider  —  receives raw webhook events from Creem, Stripe, etc.
 */

import { Hono } from "hono";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import type { ProviderRegistry } from "../services/provider";
import { processWebhook } from "../services/webhook";

export function createWebhookRouter(
  db: Database,
  config: AppConfig,
  registry: ProviderRegistry
): Hono {
  const router = new Hono();

  router.post("/:provider", async (c) => {
    const provider = c.req.param("provider");
    const rawBody = await c.req.raw.clone().text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    try {
      const result = await processWebhook(db, config, registry, provider, rawBody, headers);
      if (result.status === "duplicate") {
        return c.json({ status: "duplicate", message: result.message }, 200);
      }
      if (result.status === "error") {
        return c.json({ error: "WEBHOOK_ERROR", message: result.message }, 400);
      }
      return c.json({ status: "ok" });
    } catch (err) {
      console.error("Webhook error:", err);
      return c.json(
        { error: "WEBHOOK_PROCESSING_ERROR", message: "Webhook 处理失败" },
        500
      );
    }
  });

  return router;
}
