import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as schema from "../src/db/schema";
import { createSession, SESSION_COOKIE } from "../src/middleware/auth";
import { createAdminUiRouter } from "../src/routes/admin_ui";
import { getPurchaseFunnelDays } from "../src/services/telemetry";
import { createTestEnv } from "./helpers/setup";

/**
 * 「购买入口转化」报表的口径测试。
 *
 * 这一页的分母是「当天看到购买入口的设备」而不是「当天新增安装」，所以最容易错的地方
 * 全是去重：同一台设备一天看两个入口，日曝光只能算 1；点十次购买，日点击也只能算 1。
 * 用真实事件行验证，比断言 SQL 文本可靠。
 */

let seq = 0;

async function insertEvent(
  db: Awaited<ReturnType<typeof createTestEnv>>["db"],
  event: string,
  installId: string,
  day: string,
  surface?: string
) {
  seq += 1;
  const payload = surface ? { surface } : {};
  await db
    .insert(schema.telemetryEvents)
    .values({
      eventId: `evt-${seq}-${event}`,
      schemaVersion: 2,
      event,
      sourceId: "desktop_prod",
      receivedAt: `${day} 12:00:00`,
      receivedAtUnix: Math.floor(new Date(`${day}T12:00:00Z`).getTime() / 1000),
      sentAt: Math.floor(new Date(`${day}T12:00:00Z`).getTime() / 1000),
      productId: "animate",
      appVersion: "0.14.3",
      platform: "win32",
      channel: "official",
      machineHash: `hash-${installId}`,
      installId,
      sessionId: `session-${installId}-${seq}`,
      licenseState: "trial",
      activationId: null,
      payloadJson: JSON.stringify(payload),
      rawJson: JSON.stringify({ event, payload }),
    })
    .run();
}

function dayString(offset: number): string {
  return new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
}

describe("purchase surface funnel", () => {
  it("counts devices, not events, on both sides of the ratio", async () => {
    const env = await createTestEnv();
    const day = dayString(0);

    // 一台设备：看到两个入口，点了两次购买。
    await insertEvent(env.db, "purchase_surface_shown", "install-a", day, "settings");
    await insertEvent(env.db, "purchase_surface_shown", "install-a", day, "license_prompt");
    await insertEvent(env.db, "purchase_clicked", "install-a", day, "settings");
    await insertEvent(env.db, "purchase_clicked", "install-a", day, "settings");
    // 另一台设备：只看到入口，没点。
    await insertEvent(env.db, "purchase_surface_shown", "install-b", day, "settings");

    const report = await getPurchaseFunnelDays(env.db, { days: 1 });
    const today = report.days.find((row) => row.day === day)!;

    expect(today.shownDevices, "两个入口 + 重复曝光只算 1 台设备").toBe(2);
    expect(today.clickedDevices, "重复点击只算 1 台设备").toBe(1);
    // 1/2 = 50%，而不是 2/3 或 2/4
    expect(today.clickRatePct).toBe(50);
    expect(report.totals.clickRatePct).toBe(50);
  });

  it("splits by surface without double counting the day total", async () => {
    const env = await createTestEnv();
    const day = dayString(0);

    // 同一台设备在三个入口都看到了购买入口，只在其中一个点了。
    for (const surface of ["settings", "license_prompt", "license_reminder"]) {
      await insertEvent(env.db, "purchase_surface_shown", "install-a", day, surface);
    }
    await insertEvent(env.db, "purchase_clicked", "install-a", day, "license_prompt");

    const report = await getPurchaseFunnelDays(env.db, { days: 1 });
    const today = report.days.find((row) => row.day === day)!;

    // 日口径：1 台设备曝光、1 台设备点击 → 100%。如果实现是把三个 surface 相加，
    // 这里会是 3 台曝光、100/3 ≈ 33.3%，点击率被稀释。
    expect(today.shownDevices).toBe(1);
    expect(today.clickedDevices).toBe(1);
    expect(today.clickRatePct).toBe(100);

    // surface 口径保留各自的曝光，只有被点的那一个有点击。
    const bySurface = Object.fromEntries(report.surfaces.map((row) => [row.surface, row]));
    expect(bySurface.settings.shownDevices).toBe(1);
    expect(bySurface.settings.clickedDevices).toBe(0);
    expect(bySurface.settings.clickRatePct).toBe(0);
    expect(bySurface.license_prompt.clickedDevices).toBe(1);
    expect(bySurface.license_prompt.clickRatePct).toBe(100);
    expect(bySurface.license_reminder.clickedDevices).toBe(0);
  });

  it("returns null rather than 0% when nothing was shown", async () => {
    const env = await createTestEnv();
    const report = await getPurchaseFunnelDays(env.db, { days: 1 });
    const today = report.days[0];

    // "没有曝光"和"曝光了但没人点"是两件事：前者不该显示 0%。
    expect(today.shownDevices).toBe(0);
    expect(today.clickRatePct).toBeNull();
    expect(report.totals.clickRatePct).toBeNull();
    expect(report.surfaces).toEqual([]);
  });

  it("ignores clicks from clients that never report exposure", async () => {
    // 老版本客户端只发 purchase_clicked。它仍计入分子（这些人确实点了），
    // 但当天没有曝光上报时分母为 0 —— 比率是 null 而不是 Infinity。
    const env = await createTestEnv();
    const day = dayString(0);
    await insertEvent(env.db, "purchase_clicked", "install-old", day, "settings");

    const report = await getPurchaseFunnelDays(env.db, { days: 1 });
    const today = report.days.find((row) => row.day === day)!;

    expect(today.clickedDevices).toBe(1);
    expect(today.shownDevices).toBe(0);
    expect(today.clickRatePct).toBeNull();
  });

  it("renders the admin page", async () => {
    const env = await createTestEnv();
    const day = dayString(0);
    await insertEvent(env.db, "purchase_surface_shown", "install-a", day, "settings");
    await insertEvent(env.db, "purchase_clicked", "install-a", day, "settings");

    const app = new Hono();
    app.route("/admin", createAdminUiRouter(env.db, env.config));
    const session = await createSession("admin", env.config.sessionSecret);
    const response = await app.request("/admin/telemetry/purchase?days=7", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    for (const text of ["购买入口转化", "曝光设备", "点击设备", "点击率", "settings"]) {
      expect(html, text).toContain(text);
    }
  });
});
