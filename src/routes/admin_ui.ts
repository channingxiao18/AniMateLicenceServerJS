/**
 * Admin UI pages.
 */

import { Hono } from "hono";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  getDashboardStats,
  getLicenseDetail,
  getProductReports,
  listActivationLogs,
  listAuditLogs,
  listEntitlements,
  listLicenses,
  listPlans,
  listProducts,
  listProviderMappings,
  listSubscriptions,
  listWebhookEvents,
} from "../services/activation";
import { listTrialGrants } from "../services/trial";
import { getTelemetryReport, listTelemetryEvents } from "../services/telemetry";
import {
  createSession,
  destroySession,
  readSessionCookie,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  validateSession,
} from "../middleware/auth";

function e(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(status: string): string {
  const colors: Record<string, string> = {
    active: "ok",
    used: "ok",
    pending: "info",
    unused: "info",
    grace: "warn",
    suspended: "warn",
    revoked: "bad",
    expired: "bad",
    inactive: "muted",
    deactivated: "muted",
  };
  return `<span class="badge ${colors[status] || "muted"}">${e(status)}</span>`;
}

function loginLayout(content: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 - 授权平台</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#1f2630;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.login{width:min(380px,calc(100vw - 32px));background:#fff;border:1px solid #e4e8ef;border-radius:10px;padding:26px;box-shadow:0 12px 36px rgba(21,32,56,.08)}
h1{font-size:22px;margin:0 0 18px}.field{margin-bottom:13px}label{display:block;font-size:13px;color:#5f6b7a;margin-bottom:5px}
input{width:100%;border:1px solid #cfd6e1;border-radius:7px;padding:9px 10px;font-size:14px}button{width:100%;border:0;border-radius:7px;padding:10px 12px;background:#1e66d0;color:#fff;font-size:14px;cursor:pointer}
.error{padding:9px 10px;border-radius:7px;background:#ffeded;color:#c43737;border:1px solid #ffd0d0;margin-bottom:14px;font-size:13px}
</style></head><body>${content}</body></html>`;
}

const navItems = [
  ["/admin/", "仪表板"],
  ["/admin/products", "产品"],
  ["/admin/plans", "套餐"],
  ["/admin/licenses", "兑换码"],
  ["/admin/trials", "试用"],
  ["/admin/entitlements", "授权权益"],
  ["/admin/subscriptions", "订阅"],
  ["/admin/providers", "支付映射"],
  ["/admin/telemetry/reports", "统计报表"],
  ["/admin/telemetry/events", "统计事件"],
  ["/admin/logs", "日志"],
];

function shell(title: string, active: string, content: string): string {
  const nav = navItems
    .map(([href, label]) => `<a class="${active === href ? "active" : ""}" href="${href}">${label}</a>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)} - 授权平台</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#1f2630;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.app{min-height:100vh;display:grid;grid-template-columns:220px 1fr}.side{background:#172033;color:#fff;padding:18px 14px;position:sticky;top:0;height:100vh}
.brand{font-size:17px;font-weight:700;margin:4px 8px 22px}.side a{display:block;color:#cbd5e5;text-decoration:none;padding:10px 12px;border-radius:7px;font-size:14px;margin-bottom:4px}
.side a:hover,.side a.active{background:#24314b;color:#fff}.logout{position:absolute;bottom:16px;left:14px;right:14px}
.main{min-width:0}.head{height:58px;background:#fff;border-bottom:1px solid #e6e9ef;display:flex;align-items:center;justify-content:space-between;padding:0 24px}
.head h1{font-size:19px;margin:0}.wrap{padding:22px 24px;max-width:1440px}.grid{display:grid;gap:14px}.stats{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.card{background:#fff;border:1px solid #e5e9f0;border-radius:8px;padding:16px;margin-bottom:14px}.stat .num{font-size:28px;font-weight:700}.muted{color:#687386}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;flex-wrap:wrap}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e9f0;border-radius:8px;overflow:hidden}th,td{font-size:13px;text-align:left;padding:10px;border-bottom:1px solid #edf0f5;vertical-align:middle}
th{background:#f4f6f9;color:#5f6b7a;font-weight:600}tr:last-child td{border-bottom:0}code{background:#f0f2f5;border-radius:4px;padding:2px 5px}
.btn,button{display:inline-block;border:1px solid #cfd6e1;background:#fff;color:#1f2630;border-radius:6px;padding:7px 11px;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap}
.primary{background:#1e66d0;border-color:#1e66d0;color:#fff}.danger{border-color:#e35a5a;color:#c43737}.quiet{border-color:transparent;background:#f1f3f6}
input,select,textarea{border:1px solid #cfd6e1;border-radius:6px;padding:8px 9px;font-size:13px;width:100%;background:#fff}label{font-size:12px;color:#5f6b7a;display:block;margin-bottom:4px}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:11px}.badge{display:inline-block;border-radius:5px;padding:2px 7px;font-size:12px}
.ok{background:#e9f8ef;color:#247942}.info{background:#eaf2ff;color:#1e66d0}.warn{background:#fff5dd;color:#9a6500}.bad{background:#ffeded;color:#c43737}.muted.badge,.badge.muted{background:#eef1f5;color:#687386}
.modal{display:none;position:fixed;inset:0;z-index:50;align-items:center;justify-content:center;padding:20px}.modal:target{display:flex}.modal-bg{position:absolute;inset:0;background:rgba(18,25,38,.46)}
.modal-card{position:relative;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#fff;border-radius:10px;border:1px solid #e1e6ef;box-shadow:0 22px 70px rgba(16,24,40,.24)}
.modal-head{padding:16px 18px;border-bottom:1px solid #edf0f5}.modal-head h2{font-size:17px;margin:0}.modal-body{padding:18px}.modal-form{display:grid;gap:12px}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.flash{padding:9px 12px;background:#e9f8ef;border:1px solid #bee8ca;color:#247942;border-radius:8px;margin-bottom:14px}.flash-err{background:#ffeded;border-color:#ffd0d0;color:#c43737}
.inline-form{display:flex;gap:7px;align-items:center}.inline-form input{min-width:150px}
@media(max-width:800px){.app{grid-template-columns:1fr}.side{position:static;height:auto}.logout{position:static}.head{padding:0 16px}.wrap{padding:16px}}
</style></head><body><div class="app"><aside class="side"><div class="brand">授权平台</div>${nav}<a class="logout" href="/admin/logout">退出</a></aside><section class="main"><header class="head"><h1>${e(title)}</h1><span class="muted">Admin</span></header><main class="wrap">${content}</main></section></div></body></html>`;
}

function requireAdmin(config: AppConfig) {
  return async (c: any, next: any) => {
    const token = readSessionCookie(c.req.header("cookie") || "");
    if (!(await validateSession(token, config.sessionSecret))) return c.redirect("/admin/login");
    return next();
  };
}

function flash(c: any): string {
  const success = c.req.query("success");
  const error = c.req.query("error");
  if (error) return `<div class="flash flash-err">${e(error)}</div>`;
  if (success) return `<div class="flash">${e(success)}</div>`;
  return "";
}

function modal(id: string, title: string, action: string, fields: string, submitLabel: string): string {
  return `<div id="${e(id)}" class="modal"><a class="modal-bg" href="#"></a><div class="modal-card"><div class="modal-head"><h2>${e(title)}</h2></div><div class="modal-body"><form class="modal-form" method="post" action="${e(action)}">${fields}<div class="modal-actions"><a class="btn" href="#">取消</a><button class="primary">${e(submitLabel)}</button></div></form></div></div></div>`;
}

function formatHours(seconds: number): string {
  if (!seconds) return "0h";
  const hours = seconds / 3600;
  return `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

function shortId(value: string | null): string {
  if (!value) return "-";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function prettyJson(value: string | null): string {
  if (!value) return "-";
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function planMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function trialDurationSeconds(value: string | null): string {
  const duration = Number(planMetadata(value).duration_seconds);
  return Number.isFinite(duration) && duration > 0 ? String(Math.floor(duration)) : "";
}

function editablePlanMetadata(value: string | null): string {
  const metadata = planMetadata(value);
  delete metadata.trial_feature;
  delete metadata.duration_seconds;
  return Object.keys(metadata).length ? JSON.stringify(metadata) : "";
}

function payloadSummary(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return Object.entries(payload)
      .slice(0, 4)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ") || "{}";
  } catch {
    return payloadJson.slice(0, 80);
  }
}

export async function renderAdminDashboard(db: Database, successMessage = ""): Promise<string> {
  const stats = await getDashboardStats(db);
  const reports = await getProductReports(db);
  const cards = [
    ["产品", stats.products],
    ["套餐", stats.plans],
    ["兑换码", stats.licenses],
    ["活跃权益", stats.active_entitlements],
    ["激活设备", stats.active_devices],
    ["订阅", stats.subscriptions],
  ]
    .map(([label, value]) => `<div class="card stat"><div class="num">${value}</div><div class="muted">${label}</div></div>`)
    .join("");
  const rows = reports
    .map((r) => `<tr><td><code>${e(r.product.productId)}</code></td><td>${e(r.product.name)}</td><td>${badge(r.product.status)}</td><td>${r.plans}</td><td>${r.licenses}</td><td>${r.activeEntitlements}</td><td>${r.activeDevices}</td><td>${r.revoked}</td></tr>`)
    .join("");
  return shell(
    "仪表板",
    "/admin/",
    `${successMessage ? `<div class="flash">${e(successMessage)}</div>` : ""}<div class="grid stats">${cards}</div><div class="toolbar"><h2>产品报表</h2></div><table><thead><tr><th>产品 ID</th><th>产品</th><th>状态</th><th>套餐数</th><th>兑换码</th><th>活跃权益</th><th>激活设备</th><th>作废</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="muted">暂无数据</td></tr>`}</tbody></table>`
  );
}

function loginHtml(error = ""): string {
  return loginLayout(`<div class="login"><h1>登录授权平台</h1>${error ? `<div class="error">${e(error)}</div>` : ""}<form method="post" action="/admin/login"><div class="field"><label>用户名</label><input name="username" autofocus required></div><div class="field"><label>密码</label><input type="password" name="password" required></div><button>登录</button></form></div>`);
}

export function createAdminUiRouter(db: Database, config: AppConfig): Hono {
  const router = new Hono();

  router.get("/login", (c) => c.html(loginHtml(c.req.query("error") || "")));
  router.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const username = String(body.username || "");
    const password = String(body.password || "");
    if (username === config.adminUsername && password === config.adminPassword) {
      const token = await createSession(username, config.sessionSecret);
      c.header("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`);
      return c.redirect("/admin/");
    }
    return c.redirect("/admin/login?error=" + encodeURIComponent("用户名或密码错误"));
  });
  router.get("/logout", (c) => {
    const token = readSessionCookie(c.req.header("cookie") || "");
    if (token) destroySession(token);
    c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return c.redirect("/admin/login");
  });

  router.use("/*", requireAdmin(config));

  router.get("/", async (c) => c.html(await renderAdminDashboard(db, c.req.query("success") || "")));
  router.get("", (c) => c.redirect("/admin/"));

  router.get("/products", async (c) => {
    const products = await listProducts(db);
    const reports = await getProductReports(db);
    const reportMap = new Map(reports.map((r) => [r.product.productId, r]));
    const rows = products
      .map((p) => {
        const r = reportMap.get(p.productId);
        return `<tr><td><code>${e(p.productId)}</code></td><td><form class="inline-form" method="post" action="/admin/api/products/${encodeURIComponent(p.productId)}"><input name="name" value="${e(p.name)}"><button>保存</button></form></td><td>${badge(p.status)}</td><td>${r?.plans || 0}</td><td>${r?.licenses || 0}</td><td>${r?.activeDevices || 0}</td><td class="actions">${p.status === "active" ? `<form method="post" action="/admin/api/products/${encodeURIComponent(p.productId)}/deactivate"><button class="danger">停用</button></form>` : `<form method="post" action="/admin/api/products/${encodeURIComponent(p.productId)}/activate"><button>启用</button></form>`}</td></tr>`;
      })
      .join("");
    const createProductModal = modal(
      "create-product",
      "新建产品",
      "/admin/api/products",
      `<div><label>产品 ID</label><input name="product_id" placeholder="animate" required></div><div><label>产品名称</label><input name="name" placeholder="AniMate" required></div><div><label>状态</label><select name="status"><option value="active">active</option><option value="inactive">inactive</option></select></div>`,
      "创建"
    );
    return c.html(shell("产品", "/admin/products", `${flash(c)}<div class="toolbar"><div class="muted">管理产品、停用产品，并查看每个产品的授权表现。</div><a class="btn primary" href="#create-product">新建产品</a></div><table><thead><tr><th>产品 ID</th><th>名称</th><th>状态</th><th>套餐</th><th>兑换码</th><th>激活设备</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted">暂无产品</td></tr>`}</tbody></table>${createProductModal}`));
  });

  router.get("/plans", async (c) => {
    const products = await listProducts(db);
    const allPlans = await listPlans(db);
    const productOptions = products.map((p) => `<option value="${e(p.productId)}">${e(p.name)} (${e(p.productId)})</option>`).join("");
    const rows = allPlans
      .map((p) => `<tr><td><code>${e(p.planId)}</code></td><td>${e(p.productId)}</td><td>${e(p.name)}</td><td>${e(p.billingModel)}</td><td>${e(p.licenseModel)}</td><td>${p.maxActivations}</td><td>${p.allowSelfDeactivate ? "可自助" : "禁止自助"}</td><td>${badge(p.isActive ? "active" : "inactive")}</td><td class="actions"><a class="btn quiet" href="#edit-plan-${e(p.planId)}">编辑</a>${p.isActive ? `<form method="post" action="/admin/api/plans/${encodeURIComponent(p.planId)}/deactivate"><button class="danger">停用</button></form>` : `<form method="post" action="/admin/api/plans/${encodeURIComponent(p.planId)}/activate"><button>启用</button></form>`}</td></tr>`)
      .join("");

    // One edit modal per plan
    const editModals = allPlans
      .map((p) => modal(
        `edit-plan-${p.planId}`,
        `编辑套餐 ${p.planId}`,
        `/admin/api/plans/${encodeURIComponent(p.planId)}/update`,
        `<div><label>名称</label><input name="name" value="${e(p.name)}"></div><div><label>版本</label><input name="edition" value="${e(p.edition)}"></div><div><label>等级</label><input name="tier" value="${e(p.tier)}"></div><div><label>付费模式</label><select name="billing_model"><option value="lifetime"${p.billingModel === "lifetime" ? " selected" : ""}>lifetime</option><option value="subscription"${p.billingModel === "subscription" ? " selected" : ""}>subscription</option><option value="fixed_term"${p.billingModel === "fixed_term" ? " selected" : ""}>fixed_term</option><option value="trial"${p.billingModel === "trial" ? " selected" : ""}>trial</option></select></div><div><label>设备模式</label><select name="license_model"><option value="single_machine"${p.licenseModel === "single_machine" ? " selected" : ""}>single_machine</option><option value="multi_machine"${p.licenseModel === "multi_machine" ? " selected" : ""}>multi_machine</option></select></div><div><label>设备数</label><input name="max_activations" type="number" value="${p.maxActivations}"></div><div><label>最高 App 主版本</label><input name="max_app_major" type="number" value="${p.maxAppMajor}"></div><div><label>有效期天数</label><input name="duration_days" type="number" value="${p.durationDays || ""}"></div><div><label>订阅周期天数</label><input name="billing_period_days" type="number" value="${p.billingPeriodDays || ""}"></div><div><label>宽限期天数</label><input name="grace_days" type="number" value="${p.graceDays || ""}"></div><div><label>离线缓存天数</label><input name="offline_cache_days" type="number" value="${p.offlineCacheDays || ""}"></div><div><label>允许客户端自助解绑</label><select name="allow_self_deactivate"><option value="true"${p.allowSelfDeactivate ? " selected" : ""}>是</option><option value="false"${!p.allowSelfDeactivate ? " selected" : ""}>否</option></select></div><div><label>允许解绑后重新激活</label><select name="allow_reactivation"><option value="true"${p.allowReactivation ? " selected" : ""}>是</option><option value="false"${!p.allowReactivation ? " selected" : ""}>否</option></select></div><div><label>功能列表</label><input name="features" value="${e(p.featuresJson)}"></div><div><label>试用秒数</label><input name="trial_duration_seconds" type="number" value="${e(trialDurationSeconds(p.metadataJson))}"></div><div><label>其他 Metadata JSON</label><textarea name="metadata_json" rows="3">${e(editablePlanMetadata(p.metadataJson))}</textarea></div>`,
        "保存"
      ))
      .join("");
    const createPlanModal = modal(
      "create-plan",
      "新建套餐",
      "/admin/api/plans",
      `<div><label>套餐 ID</label><input name="plan_id" required></div><div><label>产品</label><select name="product_id">${productOptions}</select></div><div><label>套餐名称</label><input name="name" required></div><div><label>版本</label><input name="edition" value="companion"></div><div><label>等级</label><input name="tier" value="basic"></div><div><label>付费模式</label><select name="billing_model"><option>lifetime</option><option>subscription</option><option>fixed_term</option><option>trial</option></select></div><div><label>设备模式</label><select name="license_model"><option>single_machine</option><option>multi_machine</option></select></div><div><label>设备数</label><input name="max_activations" type="number" value="1"></div><div><label>最高 App 主版本</label><input name="max_app_major" type="number" value="1"></div><div><label>有效期天数</label><input name="duration_days" type="number"></div><div><label>订阅周期天数</label><input name="billing_period_days" type="number"></div><div><label>宽限期天数</label><input name="grace_days" type="number"></div><div><label>离线缓存天数</label><input name="offline_cache_days" type="number"></div><div><label>允许客户端自助解绑</label><select name="allow_self_deactivate"><option value="true">是</option><option value="false">否</option></select></div><div><label>允许解绑后重新激活</label><select name="allow_reactivation"><option value="true">是</option><option value="false">否</option></select></div><div><label>宽限期允许新增设备</label><select name="allow_new_device_during_grace"><option value="false">否</option><option value="true">是</option></select></div><div><label>功能列表</label><input name="features" value="companion,import_vrm,import_dance,import_stage"></div><div><label>试用秒数</label><input name="trial_duration_seconds" type="number" placeholder="86400"></div><div><label>其他 Metadata JSON</label><textarea name="metadata_json" rows="3"></textarea></div>`,
      "创建"
    );
    return c.html(shell("套餐", "/admin/plans", `${flash(c)}<div class="toolbar"><div class="muted">管理产品下的买断、订阅、限时和多设备套餐。</div><a class="btn primary" href="#create-plan">新建套餐</a></div><table><thead><tr><th>套餐 ID</th><th>产品</th><th>名称</th><th>付费</th><th>设备</th><th>数量</th><th>解绑策略</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="muted">暂无套餐</td></tr>`}</tbody></table>${createPlanModal}${editModals}`));
  });

  router.get("/licenses", async (c) => {
    const page = Number(c.req.query("page") || 1);
    const search = c.req.query("search") || "";
    const result = await listLicenses(db, { page, pageSize: 30, search });
    const plans = await listPlans(db);
    const planOptions = plans.map((p) => `<option value="${e(p.planId)}">${e(p.name)} (${e(p.planId)})</option>`).join("");
    const rows = result.items
      .map((l) => `<tr><td><a href="/admin/licenses/${encodeURIComponent(l.licenseKey)}"><code>${e(l.licenseKey)}</code></a></td><td>${badge(l.status)}</td><td>${e(l.product?.name || "-")}</td><td>${e(l.plan?.name || "-")}</td><td>${badge(l.entitlement?.status || "-")}</td><td>${e(l.entitlement?.customerEmail || "-")}</td><td>${e(l.batchId || "-")}</td><td>${e(l.notes || "-")}</td><td>${e(l.channel)}</td><td>${e(l.createdAt)}</td></tr>`)
      .join("");
    const createLicenseModal = modal(
      "create-license",
      "生成兑换码",
      "/admin/api/licenses/batch",
      `<div><label>套餐</label><select name="plan_id">${planOptions}</select></div><div><label>数量</label><input name="count" type="number" value="10" min="1" max="1000"></div><div><label>客户邮箱</label><input name="customer_email"></div><div><label>批次</label><input name="batch_id"></div><div><label>备注</label><input name="notes"></div>`,
      "生成"
    );
    return c.html(shell("兑换码", "/admin/licenses", `${flash(c)}<div class="toolbar"><form method="get" class="actions"><input name="search" value="${e(search)}" placeholder="搜索兑换码/邮箱" style="width:220px"><button>搜索</button></form><a class="btn primary" href="#create-license">生成兑换码</a><a class="btn" href="#batch-ops">批量操作</a></div><table><thead><tr><th>兑换码</th><th>状态</th><th>产品</th><th>套餐</th><th>权益</th><th>客户邮箱</th><th>批次</th><th>备注</th><th>来源</th><th>创建时间</th></tr></thead><tbody>${rows || `<tr><td colspan="10" class="muted">暂无兑换码</td></tr>`}</tbody></table>${createLicenseModal}${modal("batch-ops","批量操作","/admin/api/licenses/batch/suspend",`<div><label>兑换码列表 (每行一个或逗号分隔)</label><textarea name="license_keys" rows="6" placeholder="AM-XXXXXXXXXXXX&#10;AM-YYYYYYYYYYYY" required></textarea></div><div><label>操作类型</label><div class="actions" style="margin-top:6px"><button formaction="/admin/api/licenses/batch/suspend">批量暂停</button><button formaction="/admin/api/licenses/batch/revoke" class="danger">批量作废</button><button formaction="/admin/api/licenses/batch/reactivate">批量恢复</button></div></div>`,"执行")}`));
  });

  router.get("/trials", async (c) => {
    const page = Number(c.req.query("page") || 1);
    const result = await listTrialGrants(db, { page, pageSize: 80 });
    const rows = result.items
      .map((t) => {
        return `<tr><td><code>${e(t.id)}</code></td><td>${badge(t.status)}</td><td>${e(t.product?.name || "-")}</td><td>${e(t.plan?.name || "-")}</td><td><code>${e(prettyJson(t.plan?.featuresJson || "[]"))}</code></td><td>${e(t.feature)}</td><td>${e(t.durationSeconds)}</td><td>${e(t.startedAt)}</td><td>${e(t.validUntil)}</td><td><code>${e(shortId(t.fingerprintHash))}</code></td></tr>`;
      })
      .join("");
    return c.html(shell("试用", "/admin/trials", `<div class="toolbar"><div class="muted">查看试用记录、对应产品和套餐。试用最终发放的功能列表沿用套餐正式授权的功能列表。</div></div><table><thead><tr><th>Trial ID</th><th>状态</th><th>产品</th><th>套餐</th><th>正式功能列表</th><th>试用入口</th><th>时长(秒)</th><th>开始</th><th>到期</th><th>指纹哈希</th></tr></thead><tbody>${rows || `<tr><td colspan="10" class="muted">暂无试用记录</td></tr>`}</tbody></table><div class="muted" style="margin-top:10px">共 ${result.total} 条，当前第 ${page} 页</div>`));
  });

  router.get("/providers", async (c) => {
    const plans = await listPlans(db);
    const planOptions = plans.map((p) => `<option value="${e(p.planId)}">${e(p.name)} (${e(p.planId)})</option>`).join("");
    const rows = (await listProviderMappings(db))
      .map((x) => `<tr><td>${e(x.provider)}</td><td>${e(x.externalProductId || "*")}</td><td>${e(x.externalVariantId || "-")}</td><td>${e(x.localPlanId)}</td><td>${badge(x.isActive ? "active" : "inactive")}</td><td class="actions">${x.isActive ? `<form method="post" action="/admin/api/provider-mappings/${x.id}/deactivate"><button class="danger">停用</button></form>` : `<form method="post" action="/admin/api/provider-mappings/${x.id}/activate"><button>启用</button></form>`}</td></tr>`)
      .join("");
    const createMappingModal = modal(
      "create-provider-mapping",
      "新建支付映射",
      "/admin/api/provider-mappings",
      `<div><label>Provider</label><input name="provider" value="creem"></div><div><label>外部 Product ID</label><input name="external_product_id"></div><div><label>外部 Variant / Price ID</label><input name="external_variant_id"></div><div><label>本地套餐</label><select name="local_plan_id">${planOptions}</select></div>`,
      "创建"
    );
    return c.html(shell("支付映射", "/admin/providers", `${flash(c)}<div class="toolbar"><div class="muted">把 Creem、Stripe、Lemon 等外部商品映射到本地套餐。</div><a class="btn primary" href="#create-provider-mapping">新建映射</a></div><table><thead><tr><th>平台</th><th>外部产品</th><th>外部规格</th><th>本地套餐</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">暂无映射</td></tr>`}</tbody></table>${createMappingModal}`));
  });

  router.get("/licenses/:key", async (c) => {
    const detail = await getLicenseDetail(db, c.req.param("key"));
    const { license, entitlement, product, plan, devices, subscription } = detail;

    // Read per-entitlement device override from metadata.
    let overrideMax = 0;
    if (entitlement.metadataJson) {
      try {
        const meta = JSON.parse(entitlement.metadataJson) as Record<string, unknown>;
        overrideMax = Number(meta["max_activations_override"] || 0);
      } catch { /* ignore */ }
    }
    const effectiveMax = overrideMax || plan.maxActivations;
    const activeCount = devices.filter((d) => d.status === "active").length;

    const deviceRows = devices.map((d) => {
      const issued = d.licenceIssuedAt || d.activatedAt || "-";
      const refreshed = d.lastRefreshAt || "-";
      const seen = d.lastSeenAt || "-";
      return `<tr><td><code>${e(d.fingerprint)}</code></td><td>${badge(d.status)}</td><td>${e(d.platform || "-")}</td><td>${e(d.appVersion || "-")}</td><td>${e(issued)}</td><td>${e(refreshed)}</td><td>${e(seen)}</td><td class="actions">${d.status === "active" ? `<form method="post" action="/admin/api/activations/${d.id}/unbind"><button class="danger">解绑</button></form>` : ""}</td></tr>`;
    }).join("");

    // Subscription card with actions.
    const subscriptionCard = subscription
      ? `<div class="card"><h3>订阅</h3>
         <div class="grid stats" style="gap:10px">
           <div><b>平台</b><br>${e(subscription.provider)}</div>
           <div><b>状态</b><br>${badge(subscription.status)}</div>
           <div><b>周期结束</b><br>${e(subscription.currentPeriodEnd || "-")}</div>
           <div><b>宽限期至</b><br>${e(subscription.graceUntil || entitlement.graceUntil || "-")}</div>
         </div>
         <div class="actions" style="margin-top:10px">
           <form method="post" action="/admin/api/subscriptions/${subscription.id}/sync" style="display:inline"><button>同步状态</button></form>
           <form method="post" action="/admin/api/subscriptions/${subscription.id}/compensate" class="actions" style="display:inline-flex"><input name="days" type="number" value="30" min="1" max="365" style="width:80px"><button>补偿天数</button></form>
         </div></div>`
      : "";

    return c.html(shell("兑换码详情", "/admin/licenses", `<h2><code>${e(license.licenseKey)}</code></h2><div class="card"><div class="grid stats"><div><b>产品</b><br>${e(product.name)} (${e(product.productId)})</div><div><b>套餐</b><br>${e(plan.name)} (${e(plan.planId)})</div><div><b>权益状态</b><br>${badge(entitlement.status)}</div><div><b>兑换码状态</b><br>${badge(license.status)}</div><div><b>有效期</b><br>${e(entitlement.validUntil || "永久")}</div><div><b>兑换码来源</b><br>${e(entitlement.sourceProvider)}${license.channel !== entitlement.sourceProvider ? ` / ${e(license.channel)}` : ""}</div><div><b>设备</b><br>${activeCount} / ${effectiveMax}${overrideMax ? ` <span class="#muted">(套餐${plan.maxActivations})</span>` : ""}</div></div></div><div class="card actions"><form method="post" action="/admin/api/licenses/${encodeURIComponent(license.licenseKey)}/unbind"><button>解绑全部设备</button></form><form method="post" action="/admin/api/licenses/${encodeURIComponent(license.licenseKey)}/suspend"><button>暂停</button></form><form method="post" action="/admin/api/licenses/${encodeURIComponent(license.licenseKey)}/reactivate"><button>恢复</button></form><form method="post" action="/admin/api/licenses/${encodeURIComponent(license.licenseKey)}/revoke"><button class="danger">作废</button></form><form method="post" action="/admin/api/entitlements/${entitlement.id}/extend" class="actions"><input name="days" type="number" value="30" style="width:90px"><button>延长天数</button></form><form method="post" action="/admin/api/entitlements/${entitlement.id}/increase-devices" class="actions" style="margin-top:6px"><input name="max_activations" type="number" value="${effectiveMax}" min="1" max="1000" style="width:90px"><button>设置设备上限</button></form></div>${subscriptionCard}<h3>设备</h3><table><thead><tr><th>机器指纹</th><th>状态</th><th>系统</th><th>版本</th><th>签发令牌</th><th>最后刷新</th><th>最后在线</th><th>操作</th></tr></thead><tbody>${deviceRows || `<tr><td colspan="7" class="muted">暂无设备</td></tr>`}</tbody></table>`));
  });

  router.get("/entitlements", async (c) => {
    const rows = (await listEntitlements(db)).map((x) => `<tr><td>${x.id}</td><td>${e(x.productId)}</td><td>${e(x.planId)}</td><td>${badge(x.status)}</td><td>${e(x.customerEmail || "-")}</td><td>${e(x.validUntil || "永久")}</td><td>${e(x.sourceProvider)}</td></tr>`).join("");
    return c.html(shell("授权权益", "/admin/entitlements", `<div class="toolbar"><div class="muted">用于排查兑换码背后的内部权益状态、有效期和来源。</div></div><table><thead><tr><th>ID</th><th>产品</th><th>套餐</th><th>状态</th><th>邮箱</th><th>有效期</th><th>来源</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted">暂无权益</td></tr>`}</tbody></table>`));
  });

  router.get("/subscriptions", async (c) => {
    const rows = (await listSubscriptions(db)).map((x) => `<tr><td><a href="/admin/subscriptions/${x.id}">${x.id}</a></td><td>${x.entitlementId}</td><td>${e(x.provider)}</td><td>${e(x.externalSubscriptionId)}</td><td>${badge(x.status)}</td><td>${e(x.currentPeriodEnd || "-")}</td><td class="actions"><form method="post" action="/admin/api/subscriptions/${x.id}/sync" style="display:inline"><button>同步</button></form></td></tr>`).join("");
    return c.html(shell("订阅", "/admin/subscriptions", `<div class="toolbar"><div class="muted">查看订阅权益、外部订阅 ID 和周期状态。点击 ID 查看详情，点击同步从支付平台拉取最新状态。</div></div><table><thead><tr><th>ID</th><th>权益</th><th>平台</th><th>外部订阅</th><th>状态</th><th>周期结束</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted">暂无订阅</td></tr>`}</tbody></table>`));
  });

  router.get("/subscriptions/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const allSubs = await listSubscriptions(db);
    const sub = allSubs.find((s) => s.id === id);
    if (!sub) return c.notFound();

    const entitlement = await (async () => {
      const all = await listEntitlements(db);
      return all.find((e) => e.id === sub.entitlementId) || null;
    })();

    const license = entitlement
      ? (await (async () => {
          const allLicenses = await listLicenses(db, { page: 1, pageSize: 9999 });
          return allLicenses.items.find((l) => l.entitlementId === entitlement.id) || null;
        })())
      : null;

    // Get activations for this entitlement
    const devices = entitlement
      ? (await (async () => {
          const detail = await getLicenseDetail(db, license?.licenseKey || "");
          return detail.devices;
        })())
      : [];

    const deviceRows = devices.map((d) => `<tr><td>${e(d.fingerprint)}</td><td>${badge(d.status)}</td><td>${e(d.platform || "-")}</td><td>${e(d.activatedAt)}</td><td>${e(d.lastSeenAt || "-")}</td></tr>`).join("");

    return c.html(shell(`订阅 #${id}`, "/admin/subscriptions", `<h2>订阅 #${id}</h2>
      <div class="card"><div class="grid stats">
        <div><b>平台</b><br>${e(sub.provider)}</div>
        <div><b>外部订阅 ID</b><br><code>${e(sub.externalSubscriptionId)}</code></div>
        <div><b>状态</b><br>${badge(sub.status)}</div>
        <div><b>周期结束</b><br>${e(sub.currentPeriodEnd || "-")}</div>
        <div><b>宽限期至</b><br>${e(sub.graceUntil || "-")}</div>
        <div><b>外部客户</b><br>${e(sub.externalCustomerId || "-")}</div>
      </div></div>
      <div class="card actions">
        <form method="post" action="/admin/api/subscriptions/${sub.id}/sync" style="display:inline"><button>同步状态</button></form>
        <form method="post" action="/admin/api/subscriptions/${sub.id}/compensate" class="actions" style="display:inline-flex"><input name="days" type="number" value="30" min="1" max="365" style="width:80px"><button>补偿天数</button></form>
      </div>
      ${entitlement ? `<div class="card"><h3>关联权益</h3>
        <div class="grid stats">
          <div><b>权益 ID</b><br>${entitlement.id}</div>
          <div><b>产品</b><br>${e(entitlement.productId)}</div>
          <div><b>套餐</b><br>${e(entitlement.planId)}</div>
          <div><b>状态</b><br>${badge(entitlement.status)}</div>
          <div><b>有效期</b><br>${e(entitlement.validUntil || "永久")}</div>
        </div>
        ${license ? `<p>兑换码: <a href="/admin/licenses/${encodeURIComponent(license.licenseKey)}"><code>${e(license.licenseKey)}</code></a></p>` : ""}
      </div>` : ""}
      <h3>设备 (${devices.filter((d) => d.status === "active").length} 活跃)</h3>
      <table><thead><tr><th>机器 ID</th><th>状态</th><th>平台</th><th>激活时间</th><th>最后在线</th></tr></thead><tbody>${deviceRows || `<tr><td colspan="5" class="muted">暂无设备</td></tr>`}</tbody></table>
    `));
  });

  router.get("/telemetry/reports", async (c) => {
    const days = Number(c.req.query("days") || 14);
    const productId = c.req.query("product_id") || "animate";
    const report = await getTelemetryReport(db, { days, productId });
    const cards = [
      ["下载", report.totals.downloads],
      ["首次安装", report.totals.installs],
      ["活跃机器", report.totals.activeMachines],
      ["启动次数", report.totals.launches],
      ["运行时长", formatHours(report.totals.activeSecs)],
      ["Overlay 时长", formatHours(report.totals.overlayVisibleSecs)],
    ]
      .map(([label, value]) => `<div class="card stat"><div class="num">${e(value)}</div><div class="muted">${e(label)}</div></div>`)
      .join("");
    const dailyRows = report.daily
      .map((r) => `<tr><td>${e(r.day)}</td><td>${r.downloads}</td><td>${r.installs}</td><td>${r.activeMachines}</td><td>${r.launches}</td><td>${formatHours(r.activeSecs)}</td><td>${formatHours(r.overlayVisibleSecs)}</td><td>${r.events}</td></tr>`)
      .join("");
    const versionRows = report.versions
      .map((r) => `<tr><td>${e(r.appVersion)}</td><td>${r.activeMachines}</td><td>${r.launches}</td><td>${formatHours(r.activeSecs)}</td></tr>`)
      .join("");
    const stateRows = report.licenseStates
      .map((r) => `<tr><td>${badge(r.licenseState)}</td><td>${r.activeMachines}</td><td>${r.launches}</td></tr>`)
      .join("");
    const platformRows = report.platforms
      .map((r) => `<tr><td>${e(r.platform)}</td><td>${r.activeMachines}</td><td>${r.installs}</td><td>${r.downloads}</td></tr>`)
      .join("");
    return c.html(shell("统计报表", "/admin/telemetry/reports", `<div class="toolbar"><form method="get" class="actions"><label style="width:130px">产品<input name="product_id" value="${e(productId)}"></label><label style="width:120px">天数<input name="days" type="number" value="${days}" min="1" max="90"></label><button>刷新</button></form><a class="btn" href="/admin/telemetry/events">查看事件</a></div><div class="grid stats">${cards}</div><h3>每日趋势</h3><table><thead><tr><th>日期</th><th>下载</th><th>安装</th><th>活跃机器</th><th>启动</th><th>运行时长</th><th>Overlay 时长</th><th>事件</th></tr></thead><tbody>${dailyRows || `<tr><td colspan="8" class="muted">暂无数据</td></tr>`}</tbody></table><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-top:14px"><div><h3>版本分布</h3><table><thead><tr><th>版本</th><th>活跃机器</th><th>启动</th><th>运行时长</th></tr></thead><tbody>${versionRows || `<tr><td colspan="4" class="muted">暂无数据</td></tr>`}</tbody></table></div><div><h3>授权状态</h3><table><thead><tr><th>状态</th><th>活跃机器</th><th>启动</th></tr></thead><tbody>${stateRows || `<tr><td colspan="3" class="muted">暂无数据</td></tr>`}</tbody></table></div><div><h3>平台分布</h3><table><thead><tr><th>平台</th><th>活跃机器</th><th>安装</th><th>下载</th></tr></thead><tbody>${platformRows || `<tr><td colspan="4" class="muted">暂无数据</td></tr>`}</tbody></table></div></div>`));
  });

  router.get("/telemetry/events", async (c) => {
    const page = Number(c.req.query("page") || 1);
    const params = {
      page,
      pageSize: 80,
      event: c.req.query("event") || undefined,
      productId: c.req.query("product_id") || undefined,
      machineHash: c.req.query("machine_hash") || undefined,
      installId: c.req.query("install_id") || undefined,
      sessionId: c.req.query("session_id") || undefined,
    };
    const result = await listTelemetryEvents(db, params);
    const rows = result.items
      .map((x) => `<tr><td>${e(x.receivedAt)}</td><td>${e(x.event)}</td><td>${e(x.productId)}</td><td>${e(x.appVersion || "-")}</td><td>${e(x.platform || "-")}</td><td>${e(x.sourceId)}</td><td>${badge(x.licenseState || "unknown")}</td><td><code>${e(shortId(x.machineHash))}</code></td><td><code>${e(shortId(x.installId))}</code></td><td><code>${e(shortId(x.sessionId))}</code></td><td>${e(payloadSummary(x.payloadJson))}</td></tr>`)
      .join("");
    return c.html(shell("统计事件", "/admin/telemetry/events", `<div class="toolbar"><form method="get" class="actions"><input name="event" value="${e(params.event || "")}" placeholder="event" style="width:150px"><input name="product_id" value="${e(params.productId || "")}" placeholder="product_id" style="width:130px"><input name="machine_hash" value="${e(params.machineHash || "")}" placeholder="machine hash" style="width:180px"><input name="install_id" value="${e(params.installId || "")}" placeholder="install_id" style="width:180px"><input name="session_id" value="${e(params.sessionId || "")}" placeholder="session_id" style="width:180px"><button>筛选</button></form><a class="btn" href="/admin/telemetry/reports">查看报表</a></div><table><thead><tr><th>接收时间</th><th>事件</th><th>产品</th><th>版本</th><th>平台</th><th>来源</th><th>授权</th><th>机器</th><th>安装</th><th>会话</th><th>Payload</th></tr></thead><tbody>${rows || `<tr><td colspan="11" class="muted">暂无事件</td></tr>`}</tbody></table><div class="muted" style="margin-top:10px">共 ${result.total} 条，当前第 ${page} 页</div>`));
  });

  router.get("/logs", async (c) => {
    const logs = await listActivationLogs(db, { page: Number(c.req.query("page") || 1), pageSize: 80 });
    const activationRows = logs.items.map((l) => `<tr><td>${e(l.createdAt)}</td><td>${e(l.licenseKey || "-")}</td><td>${e(l.action)}</td><td>${e(l.fingerprint || "-")}</td><td>${l.responseCode}</td><td>${e(l.detail || "-")}</td></tr>`).join("");
    const webhookRows = (await listWebhookEvents(db)).map((x) => `<tr><td>${e(x.createdAt)}</td><td>${e(x.provider)}</td><td>${e(x.eventType)}</td><td>${badge(x.status)}</td><td>${e(x.errorMessage || "-")}</td><td class="actions">${x.status === "failed" ? `<form method="post" action="/admin/api/webhook-events/${x.id}/retry"><button>重试</button></form>` : ""}</td></tr>`).join("");
    const auditRows = (await listAuditLogs(db)).map((x) => `<tr><td>${e(x.createdAt)}</td><td>${e(x.actor)}</td><td>${e(x.action)}</td><td>${e(x.targetType)}:${e(x.targetId)}</td><td>${e(x.reason || "-")}</td></tr>`).join("");
    return c.html(shell("日志", "/admin/logs", `<h3>激活日志</h3><table><thead><tr><th>时间</th><th>兑换码</th><th>动作</th><th>机器</th><th>状态码</th><th>详情</th></tr></thead><tbody>${activationRows || `<tr><td colspan="6" class="muted">暂无日志</td></tr>`}</tbody></table><h3>Webhook 事件</h3><table><thead><tr><th>时间</th><th>平台</th><th>事件</th><th>状态</th><th>错误</th><th>操作</th></tr></thead><tbody>${webhookRows || `<tr><td colspan="6" class="muted">暂无事件</td></tr>`}</tbody></table><h3>审计日志</h3><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>原因</th></tr></thead><tbody>${auditRows || `<tr><td colspan="5" class="muted">暂无审计</td></tr>`}</tbody></table>`));
  });

  router.get("/orders", (c) => c.redirect("/admin/licenses"));
  router.get("/orders/:key", (c) => c.redirect(`/admin/licenses/${encodeURIComponent(c.req.param("key"))}`));
  router.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/admin/" || pathname === "/admin") return c.html(await renderAdminDashboard(db, c.req.query("success") || ""));
    return c.notFound();
  });

  return router;
}
