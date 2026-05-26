/**
 * Admin UI pages — Hono JSX rendering.
 * Replaces Jinja2 templates from the Python version.
 */

import { Hono } from "hono";
import type { Database } from "../db/index";
import type { AppConfig } from "../config";
import {
  createSession,
  destroySession,
  validateSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "../middleware/auth";
import { getOrderStats, listOrders, listActivationLogs } from "../services/activation";
import { eq } from "drizzle-orm";
import { orders, entitlements, products } from "../db/schema";

// ─── HTML helpers ────────────────────────────────────────────────────────

function baseHtml(title: string, content: string, breadcrumb = ""): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — AniMate 授权管理</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .nav { background: #1a1a2e; color: #fff; padding: 0 24px; display: flex; align-items: center; height: 56px; }
    .nav a { color: #a0a0c0; text-decoration: none; margin-right: 24px; font-size: 14px; }
    .nav a:hover, .nav a.active { color: #fff; }
    .nav .brand { font-weight: 700; font-size: 16px; margin-right: 32px; color: #fff; }
    .nav .right { margin-left: auto; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .breadcrumb { font-size: 13px; color: #888; margin-bottom: 16px; }
    .breadcrumb a { color: #666; text-decoration: none; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 24px; margin-bottom: 16px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 20px; text-align: center; }
    .stat .num { font-size: 32px; font-weight: 700; }
    .stat .label { font-size: 13px; color: #888; margin-top: 4px; }
    .stat.unused .num { color: #1890ff; }
    .stat.used .num { color: #52c41a; }
    .stat.deactivated .num { color: #faad14; }
    .stat.revoked .num { color: #ff4d4f; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
    th { background: #fafafa; font-weight: 600; color: #666; }
    tr:hover td { background: #fafafa; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .badge-unused { background: #e6f7ff; color: #1890ff; }
    .badge-used { background: #f6ffed; color: #52c41a; }
    .badge-deactivated { background: #fffbe6; color: #faad14; }
    .badge-revoked { background: #fff2f0; color: #ff4d4f; }
    .btn { display: inline-block; padding: 6px 14px; border-radius: 4px; border: 1px solid #d9d9d9; background: #fff; cursor: pointer; font-size: 13px; text-decoration: none; color: #333; }
    .btn:hover { border-color: #1890ff; color: #1890ff; }
    .btn-primary { background: #1890ff; border-color: #1890ff; color: #fff; }
    .btn-primary:hover { background: #40a9ff; color: #fff; }
    .btn-danger { color: #ff4d4f; border-color: #ff4d4f; }
    .btn-danger:hover { background: #ff4d4f; color: #fff; }
    .login-box { max-width: 400px; margin: 80px auto; }
    .login-box h1 { text-align: center; margin-bottom: 24px; font-size: 24px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 4px; font-size: 14px; color: #666; }
    .form-group input { width: 100%; padding: 8px 12px; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 14px; }
    .flash-error { background: #fff2f0; border: 1px solid #ffccc7; color: #ff4d4f; padding: 8px 12px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }
    .flash-success { background: #f6ffed; border: 1px solid #b7eb8f; color: #52c41a; padding: 8px 12px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .pagination { margin-top: 16px; display: flex; gap: 8px; align-items: center; font-size: 13px; }
    .detail-grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; font-size: 13px; }
    .detail-grid dt { color: #888; }
    code { background: #f5f5f5; padding: 1px 4px; border-radius: 2px; font-size: 12px; }
  </style>
</head>
<body>
  <nav class="nav">
    <span class="brand">AniMate 授权管理</span>
    <a href="/admin/">仪表板</a>
    <a href="/admin/orders">订单</a>
    <a href="/admin/logs">日志</a>
    <span class="right"><a href="/admin/logout">退出</a></span>
  </nav>
  ${breadcrumb ? `<div class="container"><div class="breadcrumb">${breadcrumb}</div></div>` : ""}
  <div class="container">${content}</div>
</body>
</html>`;
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    unused: "badge-unused",
    used: "badge-used",
    deactivated: "badge-deactivated",
    revoked: "badge-revoked",
    pending: "badge-unused",
    active: "badge-used",
  };
  const labels: Record<string, string> = {
    unused: "未使用",
    used: "已激活",
    deactivated: "已停用",
    revoked: "已作废",
    pending: "待激活",
    active: "已激活",
  };
  return `<span class="badge ${map[status] || ""}">${labels[status] || status}</span>`;
}

// ─── Pages ───────────────────────────────────────────────────────────────

export function createAdminUiRouter(db: Database, config: AppConfig): Hono {
  const router = new Hono();

  // Login page
  router.get("/login", (c) => {
    const error = c.req.query("error");
    return c.html(
      baseHtml(
        "登录",
        `<div class="login-box card">
          <h1>AniMate 授权管理</h1>
          ${error ? `<div class="flash-error">${escapeHtml(error)}</div>` : ""}
          <form method="post" action="/admin/login">
            <div class="form-group">
              <label>用户名</label>
              <input type="text" name="username" required autofocus>
            </div>
            <div class="form-group">
              <label>密码</label>
              <input type="password" name="password" required>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%">登录</button>
          </form>
        </div>`
      )
    );
  });

  // Login POST
  router.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const username = String(body.username || "");
    const password = String(body.password || "");

    if (
      username === config.adminUsername &&
      password === config.adminPassword
    ) {
      const token = createSession(username);
      c.header(
        "Set-Cookie",
        `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`
      );
      return c.redirect("/admin/");
    }

    return c.redirect("/admin/login?error=" + encodeURIComponent("用户名或密码错误"));
  });

  // Logout
  router.get("/logout", (c) => {
    const cookie = c.req.header("cookie") || "";
    const match = cookie.match(/(?:^|;\s*)animate_admin_session=([^;]*)/);
    if (match) {
      destroySession(decodeURIComponent(match[1]));
    }
    c.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
    return c.redirect("/admin/login");
  });

  // Dashboard
  router.get("/", async (c) => {
    const stats = await getOrderStats(db);
    return c.html(
      baseHtml(
        "仪表板",
        `<h2 style="margin-bottom:16px">仪表板</h2>
        <div class="stats">
          <div class="stat unused"><div class="num">${stats.unused}</div><div class="label">未使用</div></div>
          <div class="stat used"><div class="num">${stats.used}</div><div class="label">已激活</div></div>
          <div class="stat deactivated"><div class="num">${stats.deactivated}</div><div class="label">已停用</div></div>
          <div class="stat revoked"><div class="num">${stats.revoked}</div><div class="label">已作废</div></div>
          <div class="stat"><div class="num">${stats.total}</div><div class="label">总计</div></div>
        </div>
        <div class="actions">
          <a href="/admin/orders" class="btn btn-primary">管理订单</a>
          <a href="/admin/logs" class="btn">查看日志</a>
        </div>`
      )
    );
  });

  // Order list
  router.get("/orders", async (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    const status = c.req.query("status") || "";
    const search = c.req.query("search") || "";
    const success = c.req.query("success") || "";

    const result = await listOrders(db, { page, pageSize: 20, status, search });
    const totalPages = Math.ceil(result.total / 20);

    let rows = "";
    for (const o of result.items) {
      const ent = o.entitlement;
      rows += `<tr>
        <td><a href="/admin/orders/${encodeURIComponent(o.orderId)}"><code>${escapeHtml(o.orderId)}</code></a></td>
        <td>${statusBadge(o.status)}</td>
        <td>${ent ? statusBadge(ent.status) : "-"}</td>
        <td>${ent?.fingerprint ? escapeHtml(ent.fingerprint.substring(0, 32)) + "..." : "-"}</td>
        <td>${o.createdAt || "-"}</td>
        <td class="actions">
          ${o.status === "used" ? `<a href="/admin/orders/${encodeURIComponent(o.orderId)}" class="btn">详情</a>` : ""}
          ${o.status === "used" ? `<form method="post" action="/admin/api/orders/${encodeURIComponent(o.orderId)}/unbind" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认解绑？')">解绑</button></form>` : ""}
        </td>
      </tr>`;
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

    return c.html(
      baseHtml(
        "订单管理",
        `${success ? `<div class="flash-success">${escapeHtml(success)}</div>` : ""}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h2>订单管理</h2>
          <div class="actions">
            <form method="get" style="display:flex;gap:8px">
              <input type="text" name="search" value="${escapeHtml(search)}" placeholder="搜索订单号..." style="padding:6px 12px;border:1px solid #d9d9d9;border-radius:4px;font-size:13px">
              <select name="status" style="padding:6px 12px;border:1px solid #d9d9d9;border-radius:4px;font-size:13px">
                <option value="">全部状态</option>
                <option value="unused" ${status === "unused" ? "selected" : ""}>未使用</option>
                <option value="used" ${status === "used" ? "selected" : ""}>已激活</option>
                <option value="revoked" ${status === "revoked" ? "selected" : ""}>已作废</option>
              </select>
              <button type="submit" class="btn">筛选</button>
            </form>
            <details style="position:relative">
              <summary class="btn btn-primary" style="list-style:none;cursor:pointer">批量生成</summary>
              <div style="position:absolute;right:0;top:100%;background:#fff;border:1px solid #d9d9d9;border-radius:8px;padding:16px;z-index:10;min-width:280px;box-shadow:0 4px 12px rgba(0,0,0,0.12)">
                <form method="post" action="/admin/api/orders/batch">
                  <div class="form-group"><label>数量 (1-1000)</label><input type="number" name="count" value="10" min="1" max="1000" required></div>
                  <div class="form-group"><label>产品 ID</label><input type="text" name="product_id" value="animate-companion-lifetime-basic-v1"></div>
                  <div class="form-group"><label>备注</label><input type="text" name="notes"></div>
                  <button type="submit" class="btn btn-primary" style="width:100%">生成</button>
                </form>
              </div>
            </details>
          </div>
        </div>
        <div class="card" style="padding:0;overflow-x:auto">
          <table>
            <thead><tr><th>订单号</th><th>订单状态</th><th>授权状态</th><th>指纹</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999;padding:32px">暂无数据</td></tr>'}</tbody>
          </table>
        </div>
        ${pagination ? `<div class="pagination">${pagination}</div>` : ""}`,
        '<a href="/admin/">仪表板</a> / 订单'
      )
    );
  });

  // Order detail
  router.get("/orders/:id", async (c) => {
    const orderId = c.req.param("id");
    const order = await db
      .select()
      .from(orders)
      .where(eq(orders.orderId, orderId))
      .get();

    if (!order) {
      return c.html(
        baseHtml("订单详情", `<h2>订单不存在</h2><p>订单号 ${escapeHtml(orderId)} 未找到。</p><a href="/admin/orders" class="btn">返回列表</a>`, "仪表板 / 订单 / 未找到"),
        404
      );
    }

    const entitlement = await db
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, order.entitlementId))
      .get();

    const product = entitlement
      ? await db
          .select()
          .from(products)
          .where(eq(products.productId, entitlement.productId))
          .get()
      : null;

    return c.html(
      baseHtml(
        `订单 ${orderId}`,
        `<h2 style="margin-bottom:16px">订单详情</h2>
        <div class="card">
          <h3 style="margin-bottom:12px">订单信息</h3>
          <dl class="detail-grid">
            <dt>订单号</dt><dd><code>${escapeHtml(order.orderId)}</code></dd>
            <dt>状态</dt><dd>${statusBadge(order.status)}</dd>
            <dt>渠道</dt><dd>${escapeHtml(order.channel)}</dd>
            <dt>批次</dt><dd>${escapeHtml(order.batchId || "-")}</dd>
            <dt>备注</dt><dd>${escapeHtml(order.notes || "-")}</dd>
            <dt>创建时间</dt><dd>${order.createdAt || "-"}</dd>
            <dt>使用时间</dt><dd>${order.usedAt || "-"}</dd>
          </dl>
        </div>
        ${entitlement ? `
        <div class="card">
          <h3 style="margin-bottom:12px">授权信息</h3>
          <dl class="detail-grid">
            <dt>状态</dt><dd>${statusBadge(entitlement.status)}</dd>
            <dt>版本</dt><dd>${escapeHtml(entitlement.edition)} ${escapeHtml(entitlement.tier)}</dd>
            <dt>产品</dt><dd>${escapeHtml(product?.name || entitlement.productId)}</dd>
            <dt>功能</dt><dd>${escapeHtml(entitlement.featuresJson)}</dd>
            <dt>最高 App 版本</dt><dd>${entitlement.maxAppMajor}.x</dd>
            <dt>指纹</dt><dd><code>${escapeHtml(entitlement.fingerprint || "-")}</code></dd>
            <dt>激活时间</dt><dd>${entitlement.validFrom || "-"}</dd>
            <dt>过期时间</dt><dd>${entitlement.validUntil || "永久"}</dd>
          </dl>
        </div>` : ""}
        <div class="actions" style="margin-top:16px">
          ${order.status === "used" ? `<form method="post" action="/admin/api/orders/${encodeURIComponent(orderId)}/unbind" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认解绑？设备将被解除绑定。')">解绑</button></form>` : ""}
          ${order.status === "used" && entitlement?.status === "active" ? `<form method="post" action="/admin/api/orders/${encodeURIComponent(orderId)}/deactivate" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认停用？')">停用</button></form>` : ""}
          ${entitlement?.status === "deactivated" ? `<form method="post" action="/admin/api/orders/${encodeURIComponent(orderId)}/reactivate" style="display:inline"><button class="btn" onclick="return confirm('确认重新激活？')">重新激活</button></form>` : ""}
          ${order.status !== "revoked" ? `<form method="post" action="/admin/api/orders/${encodeURIComponent(orderId)}/revoke" style="display:inline"><button class="btn btn-danger" onclick="return confirm('确认作废？此操作不可逆！')">作废</button></form>` : ""}
          <a href="/admin/orders" class="btn">返回列表</a>
        </div>`,
        `<a href="/admin/">仪表板</a> / <a href="/admin/orders">订单</a> / ${escapeHtml(orderId)}`
      )
    );
  });

  // Logs page
  router.get("/logs", async (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    const result = await listActivationLogs(db, { page, pageSize: 50 });
    const totalPages = Math.ceil(result.total / 50);

    let rows = "";
    for (const log of result.items) {
      rows += `<tr>
        <td>${log.createdAt || "-"}</td>
        <td><code>${escapeHtml(log.orderId || "-")}</code></td>
        <td>${escapeHtml(log.action)}</td>
        <td>${escapeHtml(log.ipAddress || "-")}</td>
        <td>${log.responseCode || "-"}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(log.detail || "-")}</td>
      </tr>`;
    }

    let pagination = "";
    if (totalPages > 1) {
      for (let i = 1; i <= totalPages; i++) {
        pagination += `<a href="/admin/logs?page=${i}" class="btn" style="${i === page ? "font-weight:bold;border-color:#1890ff" : ""}">${i}</a>`;
      }
    }

    return c.html(
      baseHtml(
        "激活日志",
        `<h2 style="margin-bottom:16px">激活日志</h2>
        <div class="card" style="padding:0;overflow-x:auto">
          <table>
            <thead><tr><th>时间</th><th>订单号</th><th>操作</th><th>IP</th><th>状态码</th><th>详情</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999;padding:32px">暂无数据</td></tr>'}</tbody>
          </table>
        </div>
        ${pagination ? `<div class="pagination">${pagination}</div>` : ""}`,
        '<a href="/admin/">仪表板</a> / 日志'
      )
    );
  });

  // Redirect /admin to /admin/
  router.get("", (c) => c.redirect("/admin/"));

  return router;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
