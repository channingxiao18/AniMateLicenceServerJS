/**
 * Client-facing API routes: /v1/activate, /v1/deactivate, /v1/refresh
 */

import { Hono } from "hono";
import type { Database } from "../db/index";
import type { AppConfig } from "../config";
import {
  activateOrder,
  deactivateOrder,
  ActivationError,
} from "../services/activation";
import type { ActivateRateLimiter } from "../services/rate_limit";
import { createRateLimiter } from "../middleware/rate_limit";

export function createV1Router(db: Database, config: AppConfig): Hono {
  const router = new Hono();
  const rateLimiter = createRateLimiter({
    ipMax: config.activateRateLimitIpMax,
    ipWindowSeconds: config.activateRateLimitIpWindowSeconds,
    ipFailMax: config.activateRateLimitIpFailMax,
    ipFailWindowSeconds: config.activateRateLimitIpFailWindowSeconds,
    orderFailMax: config.activateRateLimitOrderFailMax,
    orderFailWindowSeconds: config.activateRateLimitOrderFailWindowSeconds,
  });

  // Apply rate limiting middleware
  router.use("/activate", rateLimiter);
  router.use("/deactivate", rateLimiter);

  // POST /v1/activate
  router.post("/activate", async (c) => {
    const limiter = c.get("rateLimiter") as ActivateRateLimiter;
    const ip = c.get("clientIp") as string;

    let body: {
      order_id?: string;
      fingerprint?: string;
      app_version?: string;
      platform?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: "INVALID_REQUEST", message: "请求体格式无效" },
        400
      );
    }

    const orderId = body.order_id || "";
    const fingerprint = body.fingerprint || "";
    const appVersion = body.app_version || null;
    const platform = body.platform || null;

    // Check failure limits before attempting
    if (!limiter.failuresAllowed(ip, orderId || null)) {
      return c.json(
        { error: "RATE_LIMITED", message: "失败次数过多，请稍后再试" },
        429
      );
    }

    try {
      const result = await activateOrder(db, config, {
        orderId,
        fingerprint,
        appVersion,
        platform,
        ipAddress: ip,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof ActivationError) {
        limiter.recordFailure(ip, orderId || null);
        return c.json(
          { error: err.error, message: err.message },
          err.statusCode as 400 | 403 | 404 | 409
        );
      }
      console.error("Activate error:", err);
      limiter.recordFailure(ip, orderId || null);
      return c.json(
        { error: "SERVER_ERROR", message: "服务器内部错误" },
        500
      );
    }
  });

  // POST /v1/deactivate
  router.post("/deactivate", async (c) => {
    const ip = c.get("clientIp") as string;

    let body: { order_id?: string; fingerprint?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: "INVALID_REQUEST", message: "请求体格式无效" },
        400
      );
    }

    try {
      await deactivateOrder(db, config, {
        orderId: body.order_id || "",
        fingerprint: body.fingerprint || "",
        ipAddress: ip,
      });
      return c.json({ status: "ok" });
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json(
          { error: err.error, message: err.message },
          err.statusCode as 400 | 403 | 404
        );
      }
      console.error("Deactivate error:", err);
      return c.json(
        { error: "SERVER_ERROR", message: "服务器内部错误" },
        500
      );
    }
  });

  // POST /v1/refresh — stub (subscription refresh not implemented)
  router.post("/refresh", async (c) => {
    return c.json(
      { error: "NOT_SUPPORTED", message: "刷新功能尚未实现" },
      501
    );
  });

  return router;
}
