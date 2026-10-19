import { describe, expect, it } from "vitest";
import { compareVersions, stageRates, type FunnelTotals, type FunnelVersionRow } from "../src/services/funnel";

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
