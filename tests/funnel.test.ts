import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { compareVersions, stageRates, type FunnelTotals, type FunnelVersionRow } from "../src/services/funnel";
import { windowRange } from "../src/services/funnel_jobs";
import { createAdminApiRouter } from "../src/routes/admin_api";
import { createTestEnv } from "./helpers/setup";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("POST /admin/api/funnel/rebuild", () => {
  it("跑与 cron 相同的语句，并回传窗口", async () => {
    const env = await createTestEnv();
    const seen: string[] = [];
    const stubEnv = {
      DB: {
        exec: async (sql: string) => {
          seen.push(sql);
          return {};
        },
      },
    } as unknown as Parameters<typeof createAdminApiRouter>[3];
    const app = new Hono();
    app.route("/admin/api", createAdminApiRouter(env.db, env.config, env.registry, stubEnv));

    const res = await app.request("/admin/api/funnel/rebuild?format=json", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; from: string; to: string; statements: number };
    expect(body.status).toBe("ok");
    expect(body.to).toBe(day(0));
    expect(body.statements).toBe(seen.length);
    expect(body.statements).toBeGreaterThanOrEqual(8);
  });

  it("没有 Worker env 时明确拒绝，而不是假装成功", async () => {
    const env = await createTestEnv();
    const app = new Hono();
    app.route("/admin/api", createAdminApiRouter(env.db, env.config, env.registry));
    const res = await app.request("/admin/api/funnel/rebuild?format=json", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("拒绝越界的 lookback", async () => {
    const env = await createTestEnv();
    const app = new Hono();
    app.route("/admin/api", createAdminApiRouter(env.db, env.config, env.registry, { DB: { exec: async () => ({}) } } as never));
    const res = await app.request("/admin/api/funnel/rebuild?format=json&lookback=999", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("windowRange", () => {
  it("窗口以今天结尾，并覆盖到漏斗页最新可展示的 cohort（today-7）", () => {
    const { from, to, tomorrow } = windowRange();
    expect(to).toBe(day(0));
    expect(from).toBe(day(-10));
    // 页面只展示 install_day <= today-7，窗口必须把它包含进来
    expect(from <= day(-7)).toBe(true);
    expect(tomorrow).toBe(day(1));
  });

  it("旧实现停在 today-7（把 WINDOW_DAYS 用了两次），导致累积中的 cohort 从不刷新", () => {
    const { to } = windowRange();
    expect(to).not.toBe(day(-7));
  });

  it("接受自定义回看天数", () => {
    const { from, to } = windowRange(3);
    expect(to).toBe(day(0));
    expect(from).toBe(day(-3));
  });
});

const base: FunnelTotals = {
  s0: 1000, s1: 960, s2: 640, s3: 340, s4: 300, s5: 220, s6: 160, s7: 20,
  activeCore: 250, passiveDance: 90, buyAfterCore: 64, paidInApp: 9,
};

describe("stageRates", () => {
  it("按相邻层计算转化率", () => {
    const r = stageRates(base);
    expect(r.s1).toBe(96);
    expect(r.s2).toBe(66.7);
    expect(r.s3).toBe(53.1);
    expect(r.s6).toBe(72.7);
    expect(r.s7).toBe(12.5);
    expect(r.toS7).toBe(2);
  });

  it("分母为 0 时返回 0 而不是 NaN", () => {
    const r = stageRates({ ...base, s0: 0, s1: 0 });
    expect(r.s1).toBe(0);
    expect(Number.isNaN(r.s1)).toBe(false);
  });
});

describe("compareVersions", () => {
  const rows: FunnelVersionRow[] = [
    { version: "0.12.2", releaseDay: "2026-09-30", observedDays: 18, installs: 689, s1: 678, s2: 460, s3: 410, s6: 143, paid: 18 },
    { version: "0.13.1", releaseDay: "2026-10-15", observedDays: 8, installs: 69, s1: 67, s2: 64, s3: 56, s6: 12, paid: 2 },
  ];

  it("最新版本在最前，Δ 对比上一版", () => {
    const out = compareVersions(rows);
    expect(out[0].version).toBe("0.13.1");
    expect(out[0].deltaS3).toBeGreaterThan(0);
    expect(out[1].version).toBe("0.12.2");
    expect(out[1].deltaS3).toBeNull();
  });

  it("n<100 标记为小样本", () => {
    const out = compareVersions(rows);
    expect(out.find((v) => v.version === "0.13.1")!.small).toBe(true);
    expect(out.find((v) => v.version === "0.12.2")!.small).toBe(false);
  });

  it("空安装量不产生 NaN", () => {
    const out = compareVersions([{ version: "x", releaseDay: "2026-10-01", observedDays: 17, installs: 0, s1: 0, s2: 0, s3: 0, s6: 0, paid: 0 }]);
    expect(out[0].s3Rate).toBe(0);
    expect(out[0].buyRate).toBe(0);
  });

  it("未满 7 天的版本不参与 Δ", () => {
    const out = compareVersions([{ version: "new", releaseDay: "2026-10-16", observedDays: 2, installs: 30, s1: 30, s2: 20, s3: 15, s6: 3, paid: 0 }]);
    expect(out[0].mature).toBe(false);
    expect(out[0].deltaS3).toBeNull();
  });
});
