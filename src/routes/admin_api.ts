/**
 * Admin REST API routes: /admin/api/orders/*
 */

import { Hono } from "hono";
import type { Database } from "../db/index";
import type { AppConfig } from "../config";
import {
  batchCreateOrders,
  adminUnbindOrder,
  adminDeactivateOrder,
  adminRevokeOrder,
  adminReactivateOrder,
  ActivationError,
} from "../services/activation";

export function createAdminApiRouter(db: Database, _config: AppConfig): Hono {
  const router = new Hono();

  // POST /admin/api/orders/batch
  router.post("/orders/batch", async (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

    let body: {
      count?: number;
      product_id?: string;
      notes?: string;
      batch_id?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_REQUEST", message: "请求体格式无效" }, 400);
    }

    try {
      const created = await batchCreateOrders(db, {
        count: body.count || 1,
        productId: body.product_id || "animate-companion-lifetime-basic-v1",
        notes: body.notes || null,
        batchId: body.batch_id || null,
      });
      return c.json({ created, count: created.length });
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json(
          { error: err.error, message: err.message },
          err.statusCode as 400 | 403 | 404
        );
      }
      console.error("Batch create error:", err);
      return c.json(
        { error: "SERVER_ERROR", message: "服务器内部错误" },
        500
      );
    }
  });

  // POST /admin/api/orders/:id/unbind
  router.post("/orders/:id/unbind", async (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const orderId = c.req.param("id");

    try {
      await adminUnbindOrder(db, orderId, ip);
      return c.json({ status: "ok" });
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json(
          { error: err.error, message: err.message },
          err.statusCode as 400 | 403 | 404
        );
      }
      console.error("Unbind error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  // POST /admin/api/orders/:id/deactivate
  router.post("/orders/:id/deactivate", async (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const orderId = c.req.param("id");

    try {
      await adminDeactivateOrder(db, orderId, ip);
      return c.json({ status: "ok" });
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json(
          { error: err.error, message: err.message },
          err.statusCode as 400 | 403 | 404
        );
      }
      console.error("Deactivate error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  // POST /admin/api/orders/:id/revoke
  router.post("/orders/:id/revoke", async (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const orderId = c.req.param("id");

    try {
      await adminRevokeOrder(db, orderId, ip);
      return c.json({ status: "ok" });
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json(
          { error: err.error, message: err.message },
          err.statusCode as 400 | 403 | 404
        );
      }
      console.error("Revoke error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  // POST /admin/api/orders/:id/reactivate
  router.post("/orders/:id/reactivate", async (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const orderId = c.req.param("id");

    try {
      await adminReactivateOrder(db, orderId, ip);
      return c.json({ status: "ok" });
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json(
          { error: err.error, message: err.message },
          err.statusCode as 400 | 403 | 404
        );
      }
      console.error("Reactivate error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  return router;
}
