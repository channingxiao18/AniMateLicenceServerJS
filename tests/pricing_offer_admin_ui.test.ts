import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createSession, SESSION_COOKIE } from "../src/middleware/auth";
import { createAdminUiRouter } from "../src/routes/admin_ui";
import {
  createCampaign,
  getCampaign,
  importCodes,
  setCampaignStatus,
} from "../src/services/pricing_offer";
import {
  pricingOfferAssignments,
  pricingOfferClaims,
  pricingOfferCodes,
} from "../src/db/schema";
import { createTestEnv } from "./helpers/setup";

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
});
