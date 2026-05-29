/**
 * AniMate Licence Server — Cloudflare Workers entry point.
 *
 * All routes registered directly on the main app (no nested sub-app routing).
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "./db/index";
import { seedDefaultProduct } from "./db/seed";
import { loadConfig } from "./config";
import { createV1Router } from "./routes/v1";
import { authMiddleware, createSession, destroySession, SESSION_COOKIE, SESSION_MAX_AGE } from "./middleware/auth";
import { createRateLimiter } from "./middleware/rate_limit";
import {
  activateOrder, deactivateOrder,
  batchCreateOrders, adminUnbindOrder, adminDeactivateOrder, adminRevokeOrder, adminReactivateOrder,
  getOrderStats, listOrders, listActivationLogs,
  ActivationError,
} from "./services/activation";
import { products, orders, entitlements } from "./db/schema";

export interface Env {
  DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  RSA_PRIVATE_KEY_PKCS8_HEX?: string;
  DEFAULT_APP_VERSION?: string;
  CORS_ORIGINS?: string;
  ACTIVATE_RATE_LIMIT_IP_MAX?: string;
  ACTIVATE_RATE_LIMIT_IP_WINDOW_SECONDS?: string;
  ACTIVATE_RATE_LIMIT_IP_FAIL_MAX?: string;
  ACTIVATE_RATE_LIMIT_IP_FAIL_WINDOW_SECONDS?: string;
  ACTIVATE_RATE_LIMIT_ORDER_FAIL_MAX?: string;
  ACTIVATE_RATE_LIMIT_ORDER_FAIL_WINDOW_SECONDS?: string;
  CREEM_API_KEY?: string;
  CREEM_TEST_MODE?: string;
  CREEM_DEFAULT_PRODUCT_ID?: string;
}

// ─── HTML helpers (inline, no Jinja2 dependency) ──────────────────────────

function es(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    unused: "badge-unused", used: "badge-used", deactivated: "badge-deactivated",
    revoked: "badge-revoked", pending: "badge-unused", active: "badge-used",
  };
  const labels: Record<string, string> = {
    unused: "未使用", used: "已激活", deactivated: "已停用", revoked: "已作废", pending: "待激活", active: "已激活",
  };
  return `<span class="badge ${map[status] || ""}">${labels[status] || status}</span>`;
}

function layout(title: string, content: string, breadcrumb = ""): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title} — AniMate 授权管理</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;color:#333}
.nav{background:#1a1a2e;color:#fff;padding:0 24px;display:flex;align-items:center;height:56px}
.nav a{color:#a0a0c0;text-decoration:none;margin-right:24px;font-size:14px}.nav a:hover,.nav a.active{color:#fff}
.nav .brand{font-weight:700;font-size:16px;margin-right:32px;color:#fff}.nav .right{margin-left:auto}
.container{max-width:1200px;margin:0 auto;padding:24px}
.breadcrumb{font-size:13px;color:#888;margin-bottom:16px}.breadcrumb a{color:#666;text-decoration:none}
.card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:24px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
.stat{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:20px;text-align:center}
.stat .num{font-size:32px;font-weight:700}.stat .label{font-size:13px;color:#888;margin-top:4px}
.stat.unused .num{color:#1890ff}.stat.used .num{color:#52c41a}.stat.deactivated .num{color:#faad14}.stat.revoked .num{color:#ff4d4f}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px}
th{background:#fafafa;font-weight:600;color:#666}tr:hover td{background:#fafafa}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px}
.badge-unused{background:#e6f7ff;color:#1890ff}.badge-used{background:#f6ffed;color:#52c41a}
.badge-deactivated{background:#fffbe6;color:#faad14}.badge-revoked{background:#fff2f0;color:#ff4d4f}
.btn{display:inline-block;padding:6px 14px;border-radius:4px;border:1px solid #d9d9d9;background:#fff;cursor:pointer;font-size:13px;text-decoration:none;color:#333}
.btn:hover{border-color:#1890ff;color:#1890ff}.btn-primary{background:#1890ff;border-color:#1890ff;color:#fff}
.btn-primary:hover{background:#40a9ff;color:#fff}.btn-danger{color:#ff4d4f;border-color:#ff4d4f}
.btn-danger:hover{background:#ff4d4f;color:#fff}.login-box{max-width:400px;margin:80px auto}
.login-box h1{text-align:center;margin-bottom:24px;font-size:24px}
.form-group{margin-bottom:16px}.form-group label{display:block;margin-bottom:4px;font-size:14px;color:#666}
.form-group input{width:100%;padding:8px 12px;border:1px solid #d9d9d9;border-radius:4px;font-size:14px}
.flash-error{background:#fff2f0;border:1px solid #ffccc7;color:#ff4d4f;padding:8px 12px;border-radius:4px;margin-bottom:16px;font-size:13px}
.flash-success{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a;padding:8px 12px;border-radius:4px;margin-bottom:16px;font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap}.pagination{margin-top:16px;display:flex;gap:8px;align-items:center;font-size:13px}
.detail-grid{display:grid;grid-template-columns:140px 1fr;gap:8px 16px;font-size:13px}.detail-grid dt{color:#888}
code{background:#f5f5f5;padding:1px 4px;border-radius:2px;font-size:12px}
</style></head><body>
<nav class="nav"><span class="brand">AniMate 授权管理</span>
<a href="/admin/">仪表板</a><a href="/admin/orders">订单</a><a href="/admin/logs">日志</a>
<span class="right"><a href="/admin/logout">退出</a></span></nav>
${breadcrumb ? `<div class="container"><div class="breadcrumb">${breadcrumb}</div></div>` : ""}
<div class="container">${content}</div></body></html>`;
}

function extractCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

// ─── Main App ────────────────────────────────────────────────────────────

async function initApp(env: Env) {
  const db = createDb(env.DB);
  await seedDefaultProduct(db);
  const config = loadConfig(env as unknown as Record<string, string | undefined>);
  const app = new Hono();

  // ── Public ──────────────────────────────────────────────────────────────

  app.get("/health", (c) => c.json({ status: "ok", service: "animate-licence-server" }));
  app.get("/", (c) => c.redirect("/admin/"));

  // ── V1 client API (sub-router) ──────────────────────────────────────────

  app.route("/v1", createV1Router(db, config));

  // ── Admin login (no auth needed) ────────────────────────────────────────

  app.get("/admin/login", (c) => {
    const error = c.req.query("error");
    return c.html(layout("登录",
      `<div class="login-box card"><h1>AniMate 授权管理</h1>
      ${error ? `<div class="flash-error">${es(error)}</div>` : ""}
      <form method="post" action="/admin/login">
      <div class="form-group"><label>用户名</label><input type="text" name="username" required autofocus></div>
      <div class="form-group"><label>密码</label><input type="password" name="password" required></div>
      <button type="submit" class="btn btn-primary" style="width:100%">登录</button>
      </form></div>`
    ));
  });

  app.post("/admin/login", async (c) => {
    const body = await c.req.parseBody();
    const username = String(body.username || "");
    const password = String(body.password || "");
    if (username === config.adminUsername && password === config.adminPassword) {
      const token = createSession(username);
      c.header("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`);
      return c.redirect("/admin/");
    }
    return c.redirect("/admin/login?error=" + encodeURIComponent("用户名或密码错误"));
  });

  app.get("/admin/logout", (c) => {
    const cookie = c.req.header("cookie") || "";
    const token = extractCookie(cookie, SESSION_COOKIE);
    if (token) destroySession(token);
    c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return c.redirect("/admin/login");
  });

  // ── Admin UI (requires login) ───────────────────────────────────────────

  app.use("/admin/*", authMiddleware(config));

  // Dashboard
  app.get("/admin/", async (c) => {
    const stats = await getOrderStats(db);
    return c.html(layout("仪表板",
      `<h2 style="margin-bottom:16px">仪表板</h2>
      <div class="stats">
      <div class="stat unused"><div class="num">${stats.unused}</div><div class="label">未使用</div></div>
      <div class="stat used"><div class="num">${stats.used}</div><div class="label">已激活</div></div>
      <div class="stat deactivated"><div class="num">${stats.deactivated}</div><div class="label">已停用</div></div>
      <div class="stat revoked"><div class="num">${stats.revoked}</div><div class="label">已作废</div></div>
      <div class="stat"><div class="num">${stats.total}</div><div class="label">总计</div></div></div>
      <div class="actions"><a href="/admin/orders" class="btn btn-primary">管理订单</a><a href="/admin/logs" class="btn">查看日志</a></div>`
    ));
  });

  // Order list
  app.get("/admin/orders", async (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    const status = c.req.query("status") || "";
    const search = c.req.query("search") || "";
    const result = await listOrders(db, { page, pageSize: 20, status, search });
    const totalPages = Math.ceil(result.total / 20);

    let rows = "";
    for (const o of result.items) {
      const ent = o.entitlement;
      rows += `<tr><td><a href="/admin/orders/${es(o.orderId)}"><code>${es(o.orderId)}</code></a></td>
        <td>${statusBadge(o.status)}</td><td>${es(o.channel)}</td><td>${ent ? statusBadge(ent.status) : "-"}</td>
        <td>${ent?.fingerprint ? es(ent.fingerprint.substring(0, 32)) + "..." : "-"}</td>
        <td>${o.createdAt || "-"}</td>
        <td class="actions">${o.status === "used" ? `<a href="/admin/orders/${es(o.orderId)}" class="btn">详情</a>` : ""}
        ${o.status === "used" ? `<form method="post" action="/admin/api/orders/${es(o.orderId)}/unbind" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认解绑？')">解绑</button></form>` : ""}</td></tr>`;
    }

    let pagination = "";
    if (totalPages > 1) {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      for (let i = 1; i <= totalPages; i++) {
        params.set("page", String(i));
        pagination += `<a href="/admin/orders?${params.toString()}" class="btn" style="${i === page ? "font-weight:bold;border-color:#1890ff" : ""}">${i}</a>`;
      }
    }

    return c.html(layout("订单管理",
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2>订单管理</h2><div class="actions">
      <form method="get" style="display:flex;gap:8px">
      <input type="text" name="search" value="${es(search)}" placeholder="搜索订单号..." style="padding:6px 12px;border:1px solid #d9d9d9;border-radius:4px;font-size:13px">
      <select name="status" style="padding:6px 12px;border:1px solid #d9d9d9;border-radius:4px;font-size:13px">
      <option value="">全部状态</option><option value="unused" ${status === "unused" ? "selected" : ""}>未使用</option>
      <option value="used" ${status === "used" ? "selected" : ""}>已激活</option>
      <option value="revoked" ${status === "revoked" ? "selected" : ""}>已作废</option></select>
      <button type="submit" class="btn">筛选</button></form>
      <details style="position:relative"><summary class="btn btn-primary" style="list-style:none;cursor:pointer">批量生成</summary>
      <div style="position:absolute;right:0;top:100%;background:#fff;border:1px solid #d9d9d9;border-radius:8px;padding:16px;z-index:10;min-width:280px;box-shadow:0 4px 12px rgba(0,0,0,.12)">
      <form method="post" action="/admin/api/orders/batch">
      <div class="form-group"><label>数量 (1-1000)</label><input type="number" name="count" value="10" min="1" max="1000" required></div>
      <div class="form-group"><label>产品 ID</label><input type="text" name="product_id" value="animate-companion-lifetime-basic-v1"></div>
      <div class="form-group"><label>备注</label><input type="text" name="notes"></div>
      <button type="submit" class="btn btn-primary" style="width:100%">生成</button></form></div></details></div></div>
      <div class="card" style="padding:0;overflow-x:auto"><table>
      <thead><tr><th>订单号</th><th>订单状态</th><th>渠道</th><th>授权状态</th><th>指纹</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px">暂无数据</td></tr>'}</tbody></table></div>
      ${pagination ? `<div class="pagination">${pagination}</div>` : ""}`,
      '<a href="/admin/">仪表板</a> / 订单'
    ));
  });

  // Order detail
  app.get("/admin/orders/:id", async (c) => {
    const orderId = c.req.param("id");
    const order = await db.select().from(orders).where(eq(orders.orderId, orderId)).get();
    if (!order) {
      return c.html(layout("订单详情", `<h2>订单不存在</h2><p>订单号 ${es(orderId)} 未找到。</p><a href="/admin/orders" class="btn">返回列表</a>`, "仪表板 / 订单 / 未找到"), 404);
    }
    const ent = await db.select().from(entitlements).where(eq(entitlements.id, order.entitlementId)).get();
    const prod = ent ? await db.select().from(products).where(eq(products.productId, ent.productId)).get() : null;

    return c.html(layout(`订单 ${orderId}`,
      `<h2 style="margin-bottom:16px">订单详情</h2>
      <div class="card"><h3 style="margin-bottom:12px">订单信息</h3><dl class="detail-grid">
      <dt>订单号</dt><dd><code>${es(order.orderId)}</code></dd><dt>状态</dt><dd>${statusBadge(order.status)}</dd>
      <dt>渠道</dt><dd>${es(order.channel)}${order.externalInstanceId ? ` <span style="color:#888;font-size:12px">(instance: ${es(order.externalInstanceId.substring(0, 16))}...)</span>` : ""}</dd>
      <dt>批次</dt><dd>${es(order.batchId || "-")}</dd>
      <dt>备注</dt><dd>${es(order.notes || "-")}</dd><dt>创建时间</dt><dd>${order.createdAt || "-"}</dd>
      <dt>使用时间</dt><dd>${order.usedAt || "-"}</dd></dl></div>
      ${ent ? `<div class="card"><h3 style="margin-bottom:12px">授权信息</h3><dl class="detail-grid">
      <dt>状态</dt><dd>${statusBadge(ent.status)}</dd><dt>版本</dt><dd>${es(ent.edition)} ${es(ent.tier)}</dd>
      <dt>产品</dt><dd>${es(prod?.name || ent.productId)}</dd><dt>功能</dt><dd>${es(ent.featuresJson)}</dd>
      <dt>最高 App 版本</dt><dd>${ent.maxAppMajor}.x</dd><dt>指纹</dt><dd><code>${es(ent.fingerprint || "-")}</code></dd>
      <dt>激活时间</dt><dd>${ent.validFrom || "-"}</dd><dt>过期时间</dt><dd>${ent.validUntil || "永久"}</dd></dl></div>` : ""}
      <div class="actions" style="margin-top:16px">
      ${order.status === "used" ? `<form method="post" action="/admin/api/orders/${es(orderId)}/unbind" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认解绑？')">解绑</button></form>` : ""}
      ${order.status === "used" && ent?.status === "active" ? `<form method="post" action="/admin/api/orders/${es(orderId)}/deactivate" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认停用？')">停用</button></form>` : ""}
      ${ent?.status === "deactivated" ? `<form method="post" action="/admin/api/orders/${es(orderId)}/reactivate" style="display:inline"><button class="btn" onclick="return confirm('确认重新激活？')">重新激活</button></form>` : ""}
      ${order.status !== "revoked" ? `<form method="post" action="/admin/api/orders/${es(orderId)}/revoke" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认作废？此操作不可逆！')">作废</button></form>` : ""}
      <a href="/admin/orders" class="btn">返回列表</a></div>`,
      `<a href="/admin/">仪表板</a> / <a href="/admin/orders">订单</a> / ${es(orderId)}`
    ));
  });

  // Logs
  app.get("/admin/logs", async (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    const result = await listActivationLogs(db, { page, pageSize: 50 });
    const totalPages = Math.ceil(result.total / 50);
    let rows = "";
    for (const log of result.items) {
      rows += `<tr><td>${log.createdAt || "-"}</td><td><code>${es(log.orderId || "-")}</code></td>
        <td>${es(log.action)}</td><td>${es(log.ipAddress || "-")}</td><td>${log.responseCode || "-"}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${es(log.detail || "-")}</td></tr>`;
    }
    let pagination = "";
    if (totalPages > 1) {
      for (let i = 1; i <= totalPages; i++) {
        pagination += `<a href="/admin/logs?page=${i}" class="btn" style="${i === page ? "font-weight:bold;border-color:#1890ff" : ""}">${i}</a>`;
      }
    }
    return c.html(layout("激活日志",
      `<h2 style="margin-bottom:16px">激活日志</h2><div class="card" style="padding:0;overflow-x:auto"><table>
      <thead><tr><th>时间</th><th>订单号</th><th>操作</th><th>IP</th><th>状态码</th><th>详情</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999;padding:32px">暂无数据</td></tr>'}</tbody></table></div>
      ${pagination ? `<div class="pagination">${pagination}</div>` : ""}`,
      '<a href="/admin/">仪表板</a> / 日志'
    ));
  });

  // ── Admin API (requires login) ──────────────────────────────────────────

  app.post("/admin/api/orders/batch", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* use defaults */ }
    try {
      const created = await batchCreateOrders(db, {
        count: (body.count as number) || 1,
        productId: (body.product_id as string) || "animate-companion-lifetime-basic-v1",
        notes: (body.notes as string) || null,
        batchId: (body.batch_id as string) || null,
      });
      return c.json({ created, count: created.length });
    } catch (err) {
      if (err instanceof ActivationError) return c.json({ error: err.error, message: err.message }, err.statusCode as 400 | 403 | 404);
      console.error("Batch create:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  function adminAction(path: string, handler: (db: typeof import("./db/index").Database, orderId: string, ip: string) => Promise<void>) {
    app.post(path, async (c) => {
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const orderId = c.req.param("id");
      try {
        await handler(db, orderId, ip);
        return c.redirect("/admin/orders?success=" + encodeURIComponent("操作成功"));
      } catch (err) {
        if (err instanceof ActivationError) return c.json({ error: err.error, message: err.message }, err.statusCode as 400 | 403 | 404);
        console.error("Admin action:", err);
        return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
      }
    });
  }

  adminAction("/admin/api/orders/:id/unbind", adminUnbindOrder);
  adminAction("/admin/api/orders/:id/deactivate", adminDeactivateOrder);
  adminAction("/admin/api/orders/:id/revoke", adminRevokeOrder);
  adminAction("/admin/api/orders/:id/reactivate", adminReactivateOrder);

  // 404
  app.notFound((c) => c.json({ error: "NOT_FOUND", message: "端点不存在" }, 404));
  app.onError((err, c) => {
    console.error("Unhandled:", err);
    return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
  });

  return app;
}

// Lazy init, cached per isolate
let appPromise: Promise<Hono> | null = null;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
      // Handle CORS preflight at the Worker level (before Hono)
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (!appPromise) appPromise = initApp(env);
      const app = await appPromise;
      const response = await app.fetch(request);

      // Add CORS headers to every response
      return addCors(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message + "\n" + err.stack : String(err);
      return new Response(msg, {
        status: 500,
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    }
  },
};
