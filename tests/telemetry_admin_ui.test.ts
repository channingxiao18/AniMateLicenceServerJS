import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createSession, SESSION_COOKIE } from "../src/middleware/auth";
import { createAdminUiRouter } from "../src/routes/admin_ui";
import { createTestEnv } from "./helpers/setup";

describe("telemetry admin reports", () => {
  it("renders installation, activity, retention and detail pages", async () => {
    const env = await createTestEnv();
    const app = new Hono();
    app.route("/admin", createAdminUiRouter(env.db, env.config));
    const session = await createSession("admin", env.config.sessionSecret);
    const headers = { cookie: `${SESSION_COOKIE}=${session}` };

    const cases = [
      ["/admin/telemetry/installs?days=7", ["每日新增安装", "7天", "获取免费模型", "上传模型成功", "去购买"]],
      ["/admin/telemetry/activity?days=14", ["每日活跃设备", "14天", "总活跃时长"]],
      ["/admin/telemetry/retention?days=30", ["安装设备留存", "Cohort 留存矩阵", "D14"]],
      ["/admin/telemetry/installs/2026-08-12", ["新增用户", "安装用户 ID", "获取免费模型", "上传模型成功", "去购买"]],
      ["/admin/telemetry/activity/2026-08-12", ["活跃设备", "活跃时长", "下一页"]],
    ] as const;

    for (const [path, expected] of cases) {
      const response = await app.request(path, { headers });
      expect(response.status, path).toBe(200);
      const html = await response.text();
      for (const text of expected) expect(html, path).toContain(text);
    }
  });

  it("keeps the legacy report URL as a redirect", async () => {
    const env = await createTestEnv();
    const app = new Hono();
    app.route("/admin", createAdminUiRouter(env.db, env.config));
    const session = await createSession("admin", env.config.sessionSecret);
    const response = await app.request("/admin/telemetry/reports", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/telemetry/installs");
  });
});
