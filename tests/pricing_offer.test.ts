import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createTestEnv, type TestEnv } from "./helpers/setup";
import { createV1Router } from "../src/routes/v1";
import {
  claimPricingOffer,
  createCampaign,
  getCampaign,
  getEligibility,
  getReport,
  importCodes,
  setCampaignStatus,
} from "../src/services/pricing_offer";
import {
  activations,
  entitlements,
  pricingOfferAssignments,
  pricingOfferClaims,
  pricingOfferCodes,
  telemetryInstallProfile,
} from "../src/db/schema";
import { eq } from "drizzle-orm";

const MACHINE = "a".repeat(64);

async function seedInstalledMachine(
  env: TestEnv,
  machineHash: string,
  opts: { installHoursAgo?: number; activeDays?: number } = {}
) {
  const hours = opts.installHoursAgo ?? 72;
  const installAt = new Date(Date.now() - hours * 3600 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  await env.db
    .insert(telemetryInstallProfile)
    .values({
      installId: `inst_${machineHash.slice(0, 8)}`,
      machineHash,
      installAt,
      installDay: installAt.slice(0, 10),
      firstAppVersion: "0.13.2",
      activeDays: opts.activeDays ?? 3,
      sessions: 4,
    })
    .run();
}

async function seedCampaign(env: TestEnv) {
  const created = await createCampaign(env.db, env.config, {
    campaignId: "cmp_test",
    name: "测试活动",
    creemProductId: "prod_test",
    minInstallHours: 48,
    minActiveDays: 2,
    arms: [
      { label: "9折", discountPercent: 10, weight: 25 },
      { label: "8折", discountPercent: 20, weight: 25 },
      { label: "7折", discountPercent: 30, weight: 25 },
      { label: "5折", discountPercent: 50, weight: 25 },
    ],
  });
  await setCampaignStatus(env.db, created.campaign_id, "active");
  return created;
}

async function seedOneCodePerArm(env: TestEnv, campaignId: string) {
  const detail = await getCampaign(env.db, campaignId);
  if (!detail) throw new Error("campaign missing");
  for (const arm of detail.arms) {
    const code = `ANIM-${arm.discountPercent}-${arm.armId.slice(-1).toUpperCase()}TEST`;
    await env.db
      .insert(pricingOfferCodes)
      .values({
        code,
        campaignId,
        armId: arm.armId,
        creemDiscountId: `manual:${code}`,
        status: "available",
        expiresAt: "2030-01-01T00:00:00Z",
        redeemCount: 0,
        createdAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      })
      .run();
  }
  return detail;
}

describe("pricing offer service", () => {
  it("assigns an arm deterministically and only once", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE);
    await seedCampaign(env);

    const first = await getEligibility(env.db, env.config, {
      machineHash: MACHINE,
      campaignId: "cmp_test",
    });
    const second = await getEligibility(env.db, env.config, {
      machineHash: MACHINE,
      campaignId: "cmp_test",
    });
    expect(first.eligible).toBe(true);
    expect(second.eligible).toBe(true);

    const rows = await env.db
      .select()
      .from(pricingOfferAssignments)
      .where(eq(pricingOfferAssignments.machineHash, MACHINE))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].armId).toBeTruthy();
  });

  it("rejects a machine that is too new or not active enough", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE, { installHoursAgo: 1 });
    await seedCampaign(env);

    const tooNew = await getEligibility(env.db, env.config, {
      machineHash: MACHINE,
      campaignId: "cmp_test",
    });
    expect(tooNew.eligible).toBe(false);
    expect(tooNew.reason).toBe("install_too_new");

    const env2 = await createTestEnv();
    await seedInstalledMachine(env2, MACHINE, { installHoursAgo: 72, activeDays: 1 });
    await seedCampaign(env2);
    const notActive = await getEligibility(env2.db, env2.config, {
      machineHash: MACHINE,
      campaignId: "cmp_test",
    });
    expect(notActive.eligible).toBe(false);
    expect(notActive.reason).toBe("not_active_enough");
  });

  it("never offers anything to an activated machine", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE);
    await seedCampaign(env);
    await env.db
      .insert(entitlements)
      .values({
        id: 1,
        productId: "animate",
        planId: "animate-companion-lifetime-basic-v1",
        status: "active",
        sourceProvider: "manual",
        sourceChannel: "manual",
      })
      .run();
    await env.db
      .insert(activations)
      .values({
        entitlementId: 1,
        fingerprint: "fp_licensed",
        status: "active",
        telemetryMachineHash: MACHINE,
      })
      .run();

    const eligibility = await getEligibility(env.db, env.config, {
      machineHash: MACHINE,
      campaignId: "cmp_test",
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("licensed");
    expect(eligibility.license_state).toBe("active");

    const claim = await claimPricingOffer(
      env.db,
      env.config,
      {
        campaignId: "cmp_test",
        machineHash: MACHINE,
        touchpoint: "feature_recall",
        stage: "first",
        appVersion: "0.13.2",
        channel: "microsoft_store",
        locale: "zh-CN",
        intentTier: 3,
        installAgeHours: 72,
        activeDays: 3,
      },
      "203.0.113.10"
    );
    expect(claim.status).toBe("not_eligible");
    expect(claim.reason).toBe("licensed");
  });

  it("issues a code once and returns the same code on retry", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE);
    await seedCampaign(env);
    const detail = await seedOneCodePerArm(env, "cmp_test");

    const request = {
      campaignId: "cmp_test",
      machineHash: MACHINE,
      touchpoint: "feature_recall" as const,
      stage: "first",
      appVersion: "0.13.2",
      channel: "microsoft_store",
      locale: "zh-CN",
      intentTier: 3,
      installAgeHours: 72,
      activeDays: 3,
    };
    const first = await claimPricingOffer(env.db, env.config, request, "203.0.113.10");
    expect(first.status).toBe("issued");
    expect(first.code).toBeTruthy();
    expect(first.expires_at).toBeTruthy();
    expect(first.purchase_url).toContain("code=");
    expect(first.purchase_url).toContain("claim=");

    const second = await claimPricingOffer(env.db, env.config, request, "203.0.113.10");
    expect(second.status).toBe("already_issued");
    expect(second.code).toBe(first.code);
    expect(second.expires_at).toBe(first.expires_at);

    const stored = await env.db
      .select()
      .from(pricingOfferClaims)
      .where(eq(pricingOfferClaims.machineHash, MACHINE))
      .get();
    expect(stored?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.ipHash).not.toBe("203.0.113.10");

    const assignedArm = (
      await env.db
        .select()
        .from(pricingOfferAssignments)
        .where(eq(pricingOfferAssignments.machineHash, MACHINE))
        .get()
    )?.armId;
    const seeded = detail.arms.find((arm) => arm.armId === assignedArm);
    expect(first.discount_percent).toBe(seeded?.discountPercent);
  });

  it("claims imported manual codes and reports per-arm counts", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE);
    await seedCampaign(env);
    const detail = await getCampaign(env.db, "cmp_test");
    if (!detail) throw new Error("campaign missing");
    for (const arm of detail.arms) {
      await importCodes(env.db, "cmp_test", arm.armId, `ANIM-${arm.discountPercent}-MANUAL-${arm.armId.slice(-1)}`);
    }

    const claim = await claimPricingOffer(
      env.db,
      env.config,
      {
        campaignId: "cmp_test",
        machineHash: MACHINE,
        touchpoint: "review_window",
        stage: "first",
        appVersion: "0.13.2",
        channel: "microsoft_store",
        locale: "zh-CN",
        intentTier: 1,
        installAgeHours: 72,
        activeDays: 3,
      },
      "203.0.113.11"
    );
    expect(claim.status).toBe("issued");

    await env.db
      .update(pricingOfferCodes)
      .set({ redeemCount: 1, status: "redeemed" })
      .where(eq(pricingOfferCodes.code, claim.code!))
      .run();

    const report = (await getReport(env.db, "cmp_test")) as {
      arms: Array<{ claimed: number; redeemed: number; eligible: number }>;
      touchpoints: Record<string, number>;
    };
    const totalClaimed = report.arms.reduce((sum, arm) => sum + arm.claimed, 0);
    const totalRedeemed = report.arms.reduce((sum, arm) => sum + arm.redeemed, 0);
    expect(totalClaimed).toBe(1);
    expect(totalRedeemed).toBe(1);
    expect(report.touchpoints.review_window).toBe(1);
  });

  it("honours the campaign kill switch", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE);
    await seedCampaign(env);
    await setCampaignStatus(env.db, "cmp_test", "paused");

    const eligibility = await getEligibility(env.db, env.config, {
      machineHash: MACHINE,
      campaignId: "cmp_test",
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("campaign_paused");
  });
});

describe("pricing offer HTTP routes", () => {
  async function buildApp(env: TestEnv) {
    const app = new Hono();
    app.route("/v1", createV1Router(env.db, env.config, env.registry, null));
    return app;
  }

  it("serves eligibility → claim → status over HTTP", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE);
    await seedCampaign(env);
    await seedOneCodePerArm(env, "cmp_test");
    const app = await buildApp(env);

    const eligibility = await app.request("/v1/pricing-offer/eligibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine_hash: MACHINE, campaign_id: "cmp_test" }),
    });
    expect(eligibility.status).toBe(200);
    const eligibilityBody = (await eligibility.json()) as { eligible: boolean };
    expect(eligibilityBody.eligible).toBe(true);

    const claim = await app.request("/v1/pricing-offer/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine_hash: MACHINE,
        campaign_id: "cmp_test",
        touchpoint: "feature_recall",
        stage: "first",
        intent_tier: 2,
      }),
    });
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as { status: string; code: string };
    expect(claimBody.status).toBe("issued");
    expect(claimBody.code).toBeTruthy();

    const status = await app.request(
      `/v1/pricing-offer/status?machine_hash=${MACHINE}&campaign_id=cmp_test`
    );
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { status: string; code: string };
    expect(statusBody.status).toBe("issued");
    expect(statusBody.code).toBe(claimBody.code);
  });

  it("reports campaign_paused over HTTP", async () => {
    const env = await createTestEnv();
    await seedInstalledMachine(env, MACHINE);
    await seedCampaign(env);
    await setCampaignStatus(env.db, "cmp_test", "paused");
    const app = await buildApp(env);

    const response = await app.request("/v1/pricing-offer/eligibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine_hash: MACHINE, campaign_id: "cmp_test" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { eligible: boolean; reason: string };
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe("campaign_paused");
  });
});
