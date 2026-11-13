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
 * 这一页最容易错的地方全是去重，而且有两种去重同时存在：
 *   - 「设备」按 install_id 去重：点十次也只算 1 台；
 *   - 「合计」跨入口去重：一台设备当天看两个入口，合计 1 台，但两个入口各算 1 台。
 * 所以日表各入口列相加 >= 合计、入口列周期值相加 >= 周期合计，都是对的。
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

/** 首装日：ingest 时写入 telemetry_daily_uniques 的 install_seen(day, install_id)。 */
async function markInstall(
  db: Awaited<ReturnType<typeof createTestEnv>>["db"],
  installId: string,
  day: string
) {
  await db
    .insert(schema.telemetryDailyUniques)
    .values({
      day,
      productId: "animate",
      uniqueType: "install_seen",
      uniqueValue: installId,
      sourceId: "desktop_prod",
      platform: "win32",
      channel: "official",
      appVersion: "0.14.3",
      licenseState: "trial",
    })
    .run();
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
    expect(today.clickEvents, "点击两次就是 2 次：设备数和次数不能互相冒充").toBe(2);
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

    // 入口列各自保留：每个入口 1 台曝光，只有被点的那一个有点击。
    expect(today.surfaces.settings).toEqual({ shownDevices: 1, clickedDevices: 0, clickEvents: 0 });
    expect(today.surfaces.license_prompt).toEqual({
      shownDevices: 1,
      clickedDevices: 1,
      clickEvents: 1,
    });
    expect(today.surfaces.license_reminder).toEqual({
      shownDevices: 1,
      clickedDevices: 0,
      clickEvents: 0,
    });

    // 三个入口各 1 台，合计 1 台：入口列相加比合计多 2 台次。
    expect(report.overCount.shownDevices).toBe(2);
    expect(report.overCount.clickedDevices).toBe(0);
    expect(report.totals.shownDevices).toBe(1);
  });

  it("separates device-days from period devices", async () => {
    const env = await createTestEnv();
    const yesterday = dayString(1);
    const today = dayString(0);

    // 同一台设备两天都点了同一个入口。
    for (const day of [yesterday, today]) {
      await insertEvent(env.db, "purchase_surface_shown", "install-a", day, "license_prompt");
      await insertEvent(env.db, "purchase_clicked", "install-a", day, "license_prompt");
    }

    const report = await getPurchaseFunnelDays(env.db, { days: 2 });
    const rowFor = (day: string) => report.days.find((row) => row.day === day)!;

    // 日表：两天各 1 台（同一台设备会在两行各出现一次）。
    expect(rowFor(today).clickedDevices).toBe(1);
    expect(rowFor(yesterday).clickedDevices).toBe(1);

    // 周期合计：跨日去重后是 1 台，不是把两行相加的 2 台。
    expect(report.totals.shownDevices).toBe(1);
    expect(report.totals.clickedDevices).toBe(1);
    expect(report.totals.clickEvents).toBe(2);

    // 入口列同样是周期去重：1 台设备，2 次点击。
    const licensePrompt = report.surfaces.find((row) => row.surface === "license_prompt")!;
    expect(licensePrompt.clickedDevices).toBe(1);
    expect(licensePrompt.clickEvents).toBe(2);
    expect(licensePrompt.clickRatePct).toBe(100);
  });

  it("names the gap between the total and the sum of the entry columns", async () => {
    const env = await createTestEnv();
    const day = dayString(0);

    // install-a 一天看了两个入口，install-b 只看了一个 → 合计 2 台，入口列相加 3 台。
    await insertEvent(env.db, "purchase_surface_shown", "install-a", day, "settings");
    await insertEvent(env.db, "purchase_surface_shown", "install-a", day, "license_prompt");
    await insertEvent(env.db, "purchase_surface_shown", "install-b", day, "settings");

    const report = await getPurchaseFunnelDays(env.db, { days: 1 });

    expect(report.totals.shownDevices).toBe(2);
    expect(report.surfaces.reduce((total, row) => total + row.shownDevices, 0)).toBe(3);
    expect(report.overCount.shownDevices).toBe(1);
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
    expect(report.overCount).toEqual({ shownDevices: 0, clickedDevices: 0 });
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

  it("does not count devices without an install id", async () => {
    // 没有 install_id 就无法去重设备：硬算会把同一台设备重复计入分母。
    const env = await createTestEnv();
    const day = dayString(0);
    await insertEvent(env.db, "purchase_clicked", "install-a", day, "settings");
    await env.db
      .insert(schema.telemetryEvents)
      .values({
        eventId: `evt-null-${day}`,
        schemaVersion: 2,
        event: "purchase_clicked",
        sourceId: "desktop_prod",
        receivedAt: `${day} 12:00:00`,
        receivedAtUnix: Math.floor(new Date(`${day}T12:00:00Z`).getTime() / 1000),
        productId: "animate",
        appVersion: "0.14.3",
        platform: "win32",
        channel: "official",
        installId: null,
        payloadJson: JSON.stringify({ surface: "settings" }),
        rawJson: "{}",
      })
      .run();

    const report = await getPurchaseFunnelDays(env.db, { days: 1 });
    expect(report.days[0].clickedDevices).toBe(1);
    expect(report.days[0].clickEvents).toBe(1);
  });

  it("renders zero rows instead of a broken header when there is no data", async () => {
    const env = await createTestEnv();

    const app = new Hono();
    app.route("/admin", createAdminUiRouter(env.db, env.config));
    const session = await createSession("admin", env.config.sessionSecret);
    const response = await app.request("/admin/telemetry/purchase", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    // 没有数据也照常列出日期行（全 0），不留一张空表。
    expect(html).toContain(dayString(0));
    // 没有入口列时不该渲染表尾合计行，否则列数对不上。
    expect(html).not.toContain("周期合计");
  });

  it("splits clicking devices into same-day installs and existing machines", async () => {
    const env = await createTestEnv();
    const today = dayString(0);
    const earlier = dayString(5);

    // install-a 今天首装、今天点；install-b 五天前首装、今天点；
    // install-c 没有任何首装记录（老版本 / 缺 install_seen），也必须落在两列之一。
    await markInstall(env.db, "install-a", today);
    await markInstall(env.db, "install-b", earlier);
    await insertEvent(env.db, "purchase_clicked", "install-a", today, "license_prompt");
    await insertEvent(env.db, "purchase_clicked", "install-b", today, "license_prompt");
    await insertEvent(env.db, "purchase_clicked", "install-c", today, "license_prompt");

    const report = await getPurchaseFunnelDays(env.db, { days: 7 });
    const row = report.days.find((candidate) => candidate.day === today)!;

    expect(row.clickedDevices).toBe(3);
    expect(row.newClickedDevices).toBe(1);
    expect(row.existingClickedDevices).toBe(2);
    // 两列相加必须恒等于点击设备，否则又变成「两张表对不上」。
    expect(row.newClickedDevices + row.existingClickedDevices).toBe(row.clickedDevices);

    expect(report.totals.clickedDevices).toBe(3);
    expect(report.totals.newClickedDevices).toBe(1);
    expect(report.totals.existingClickedDevices).toBe(2);
  });

  it("renders the admin page with entry columns and a period total", async () => {
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
    for (const text of [
      "购买入口转化",
      "合计（跨入口去重）",
      "曝光设备",
      "点击设备",
      "点击次数",
      "点击率",
      "新装当天",
      "存量",
      "周期合计",
      "不按首装日期筛选",
      "settings",
    ]) {
      expect(html, text).toContain(text);
    }
  });
});
