import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { createSession, SESSION_COOKIE } from "../src/middleware/auth";
import { createAdminUiRouter } from "../src/routes/admin_ui";
import {
  createCampaign,
  getCampaign,
  importCodes,
  pricingOfferShownWhere,
  setCampaignStatus,
} from "../src/services/pricing_offer";
import {
  pricingOfferAssignments,
  pricingOfferClaims,
  pricingOfferCodes,
  telemetryEvents,
} from "../src/db/schema";
import { createTestDb, createTestEnv } from "./helpers/setup";

const MACHINE = "a".repeat(64);

async function seedCampaign() {
  const env = await createTestEnv();
  const { campaign_id } = await createCampaign(env.db, env.config, {
    campaignId: "cmp_ui",
    name: "UI 测试活动",
    creemProductId: "prod_test",
    arms: [
      { label: "9折", discountPercent: 10, weight: 25 },
      { label: "8折", discountPercent: 20, weight: 25 },
      { label: "7折", discountPercent: 30, weight: 25 },
      { label: "5折", discountPercent: 50, weight: 25 },
    ],
  });
  await setCampaignStatus(env.db, campaign_id, "active");
  const detail = await getCampaign(env.db, campaign_id);
  if (!detail) throw new Error("campaign missing");
  const arm = detail.arms[0];

  await importCodes(env.db, campaign_id, arm.armId, "ANIM-10-UI1");
  await env.db
    .insert(pricingOfferAssignments)
    .values({ campaignId: campaign_id, machineHash: MACHINE, armId: arm.armId })
    .run();
  await env.db
    .update(pricingOfferCodes)
    .set({
      status: "issued",
      issuedToMachineHash: MACHINE,
      issuedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    })
    .where(eq(pricingOfferCodes.code, "ANIM-10-UI1"))
    .run();
  await env.db
    .insert(pricingOfferClaims)
    .values({
      claimId: "claim_ui",
      campaignId: campaign_id,
      armId: arm.armId,
      machineHash: MACHINE,
      code: "ANIM-10-UI1",
      touchpoint: "feature_recall",
      stage: "first",
      intentTier: 2,
    })
    .run();

  const app = new Hono();
  app.route("/admin", createAdminUiRouter(env.db, env.config));
  const session = await createSession("admin", env.config.sessionSecret);
  return { app, cookie: `${SESSION_COOKIE}=${session}`, campaignId: campaign_id };
}

describe("pricing offer admin pages", () => {
  it("renders the campaign list with the seeded campaign and arms", async () => {
    const { app, cookie, campaignId } = await seedCampaign();
    const response = await app.request("/admin/pricing-offer", {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const text of ["定价折扣", "新建活动", campaignId, "9折", "5折", "启用"]) {
      expect(html, text).toContain(text);
    }
  });

  it("renders the detail page with the per-arm report and code table", async () => {
    const { app, cookie, campaignId } = await seedCampaign();
    const response = await app.request(`/admin/pricing-offer/${campaignId}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const text of [
      "分组报表",
      "生成 20 张",
      "手工码兜底",
      "券码（最近 200）",
      "ANIM-10-UI1",
      "9折",
      "feature_recall",
    ]) {
      expect(html, text).toContain(text);
    }
  });

  it("404s for an unknown campaign", async () => {
    const { app, cookie } = await seedCampaign();
    const response = await app.request("/admin/pricing-offer/cmp_missing", {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });

  /**
   * 回归：活动详情页曾经 500。
   *
   * 「多少台机器看到过」的两条查询漏了 product_id，而 telemetry_events 只有
   * (product_id, event, received_at) 这个索引 —— 线上 67 万行时每次全表扫 11.6 秒，
   * 两条叠加直接触发 D1 的 10 秒窗口限流，页面返回 {"error":"SERVER_ERROR"}。
   * 这里直接断言查询计划，比断言 SQL 文本更贴近真正的原因。
   */
  it("scopes the shown-machines scan to the product_id index", async () => {
    const { db, sqlite } = createTestDb();
    const where = pricingOfferShownWhere(
      {
        productId: "animate",
        startedAt: "2026-10-26 04:46:01",
        createdAt: "2026-10-26 04:43:04",
      },
      "cmp_ui"
    );
    const query = db
      .select({ n: sql`count(distinct ${telemetryEvents.machineHash})` })
      .from(telemetryEvents)
      .where(where);
    const compiled = query.toSQL();
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
      .all(...(compiled.params as unknown[])) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).toContain("telemetry_events_product_event_idx");
    expect(details).not.toContain("SCAN telemetry_events");
  });
});
