/**
 * 用户转化路径（path_v1）报表查询层。
 *
 * 数据来源：telemetry_install_profile / telemetry_install_day（见 migrations/0018）。
 * 事实源仍是 telemetry_events；这两个表是投影，可随时用 scripts/backfill_funnel.sql 重建。
 *
 * 预算：本文件所有查询只扫 install_profile（当前 ~1.8k 行，36 列），
 * 单次报表约 2~4k rows read；不触碰 telemetry_events。
 */
import { sql } from "drizzle-orm";
import type { Database } from "../db/index";

export type FunnelStageKey = "s0" | "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "s7";

export type FunnelTotals = Record<FunnelStageKey, number> & {
  activeCore: number;
  passiveDance: number;
  buyAfterCore: number;
  paidInApp: number;
};

export type FunnelDayRow = {
  day: string;
  installs: number;
  s1: number;
  s2: number;
  s3: number;
  s6: number;
  paid: number;
  complete: boolean;
};

export type FunnelVersionRow = {
  version: string;
  releaseDay: string;
  observedDays: number;
  installs: number;
  s1: number;
  s2: number;
  s3: number;
  s6: number;
  paid: number;
};

export type FunnelReport = {
  filters: { days: number; version: string | null; from: string; to: string };
  totals: FunnelTotals;
  days: FunnelDayRow[];
  versions: FunnelVersionRow[];
};

export type FunnelUserRow = {
  installId: string;
  installAt: string;
  installDay: string;
  appVersion: string;
  locale: string | null;
  trialGranted: number;
  launch: number;
  onboarding: number;
  core: number;
  liked: number;
  retained: number;
  bought: number;
  paid: number;
  activeDays: number;
  sessions: number;
  score: number | null;
};

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7; // 旅程窗口：首 7 天

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return dayString(new Date(Date.now() - days * DAY_MS));
}

function reportDays(value: number | undefined, fallback = 30): number {
  return Math.min(180, Math.max(1, Number.isFinite(value) ? Math.floor(value!) : fallback));
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function getFunnelReport(
  db: Database,
  params: { days?: number; version?: string | null } = {},
): Promise<FunnelReport> {
  const days = reportDays(params.days);
  const version = params.version && params.version !== "all" ? params.version : null;
  // 只统计已满窗的 cohort：安装日 + 7 天 <= 今天
  const to = daysAgo(WINDOW_DAYS);
  const from = daysAgo(WINDOW_DAYS + days - 1);

  const totalsRows = await db.all(sql`
    SELECT
      COUNT(*) AS s0,
      SUM(CASE WHEN t_first_frame IS NOT NULL AND julianday(datetime(t_first_frame,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s1,
      SUM(CASE WHEN t_first_frame IS NOT NULL AND julianday(datetime(t_first_frame,'unixepoch')) - julianday(install_at) <= 3
                AND t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s2,
      SUM(CASE WHEN t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3
                AND t_core IS NOT NULL AND julianday(datetime(t_core,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s3,
      SUM(CASE WHEN t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3
                AND t_core IS NOT NULL AND julianday(datetime(t_core,'unixepoch')) - julianday(install_at) <= 3 AND liked = 1 THEN 1 ELSE 0 END) AS s4,
      SUM(CASE WHEN t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3
                AND t_core IS NOT NULL AND julianday(datetime(t_core,'unixepoch')) - julianday(install_at) <= 3 AND liked = 1 AND retained = 1 THEN 1 ELSE 0 END) AS s5,
      SUM(CASE WHEN t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3
                AND t_core IS NOT NULL AND julianday(datetime(t_core,'unixepoch')) - julianday(install_at) <= 3 AND liked = 1 AND retained = 1
                AND t_purchase_click IS NOT NULL AND julianday(datetime(t_purchase_click,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s6,
      SUM(CASE WHEN t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3
                AND t_core IS NOT NULL AND julianday(datetime(t_core,'unixepoch')) - julianday(install_at) <= 3 AND liked = 1 AND retained = 1
                AND t_purchase_click IS NOT NULL AND julianday(datetime(t_purchase_click,'unixepoch')) - julianday(install_at) <= 3
                AND t_activated IS NOT NULL THEN 1 ELSE 0 END) AS s7,
      SUM(CASE WHEN f_import = 1 OR f_ai = 1 THEN 1 ELSE 0 END) AS active_core,
      SUM(CASE WHEN f_dance = 1 AND f_import = 0 AND f_ai = 0 THEN 1 ELSE 0 END) AS passive_dance,
      SUM(CASE WHEN t_purchase_click IS NOT NULL AND t_core IS NOT NULL
                AND t_purchase_click >= t_core THEN 1 ELSE 0 END) AS buy_after_core,
      SUM(CASE WHEN t_purchase_click IS NOT NULL AND t_activated IS NOT NULL THEN 1 ELSE 0 END) AS paid_in_app
    FROM telemetry_install_profile
    WHERE install_day >= ${from} AND install_day <= ${to}
      AND (${version} IS NULL OR first_app_version = ${version})
      AND COALESCE(channel, 'official') = 'official'
  `) as unknown as Array<Record<string, unknown>>;

  const t = totalsRows[0] ?? {};
  const totals: FunnelTotals = {
    s0: num(t.s0), s1: num(t.s1), s2: num(t.s2), s3: num(t.s3),
    s4: num(t.s4), s5: num(t.s5), s6: num(t.s6), s7: num(t.s7),
    activeCore: num(t.active_core), passiveDance: num(t.passive_dance),
    buyAfterCore: num(t.buy_after_core), paidInApp: num(t.paid_in_app),
  };

  const dayRows = await db.all(sql`
    SELECT install_day AS day,
      COUNT(*) AS installs,
      SUM(CASE WHEN t_first_frame IS NOT NULL AND julianday(datetime(t_first_frame,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s1,
      SUM(CASE WHEN t_first_frame IS NOT NULL AND julianday(datetime(t_first_frame,'unixepoch')) - julianday(install_at) <= 3
                AND t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s2,
      SUM(CASE WHEN t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3
                AND t_core IS NOT NULL AND julianday(datetime(t_core,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s3,
      SUM(CASE WHEN t_purchase_click IS NOT NULL AND julianday(datetime(t_purchase_click,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s6,
      SUM(CASE WHEN t_activated IS NOT NULL THEN 1 ELSE 0 END) AS paid
    FROM telemetry_install_profile
    WHERE install_day >= ${from} AND install_day <= ${to}
      AND (${version} IS NULL OR first_app_version = ${version})
      AND COALESCE(channel, 'official') = 'official'
    GROUP BY install_day ORDER BY install_day
  `) as unknown as Array<Record<string, unknown>>;

  const days_out: FunnelDayRow[] = dayRows.map((r) => ({
    day: String(r.day),
    installs: num(r.installs),
    s1: num(r.s1), s2: num(r.s2), s3: num(r.s3), s6: num(r.s6), paid: num(r.paid),
    complete: true, // 已经用 to = today-7 收窄，全部满窗
  }));

  const versionRows = await db.all(sql`
    SELECT first_app_version AS version,
      MIN(install_day) AS release_day,
      CAST(julianday(date('now')) - julianday(MIN(install_day)) AS INTEGER) AS observed_days,
      COUNT(*) AS installs,
      SUM(CASE WHEN t_first_frame IS NOT NULL AND julianday(datetime(t_first_frame,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s1,
      SUM(CASE WHEN t_first_frame IS NOT NULL AND julianday(datetime(t_first_frame,'unixepoch')) - julianday(install_at) <= 3
                AND t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s2,
      SUM(CASE WHEN t_onb_done IS NOT NULL AND julianday(datetime(t_onb_done,'unixepoch')) - julianday(install_at) <= 3
                AND t_core IS NOT NULL AND julianday(datetime(t_core,'unixepoch')) - julianday(install_at) <= 3 THEN 1 ELSE 0 END) AS s3,
      SUM(CASE WHEN t_purchase_click IS NOT NULL THEN 1 ELSE 0 END) AS s6,
      SUM(CASE WHEN t_activated IS NOT NULL THEN 1 ELSE 0 END) AS paid
    FROM telemetry_install_profile
    WHERE install_day >= ${from} AND install_day <= date('now')
    GROUP BY first_app_version ORDER BY installs DESC
  `) as unknown as Array<Record<string, unknown>>;

  return {
    filters: { days, version, from, to },
    totals,
    days: days_out,
    versions: versionRows.map((r) => ({
      version: String(r.version),
      releaseDay: String(r.release_day),
      observedDays: num(r.observed_days),
      installs: num(r.installs),
      s1: num(r.s1), s2: num(r.s2), s3: num(r.s3), s6: num(r.s6), paid: num(r.paid),
    })),
  };
}

export async function listFunnelUsers(
  db: Database,
  params: { days?: number; version?: string | null; page?: number; pageSize?: number } = {},
): Promise<{ items: FunnelUserRow[]; total: number; page: number; pageSize: number }> {
  const days = reportDays(params.days);
  const version = params.version && params.version !== "all" ? params.version : null;
  const page = Math.max(1, Math.floor(params.page || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize || 25)));
  const to = daysAgo(WINDOW_DAYS);
  const from = daysAgo(WINDOW_DAYS + days - 1);

  const countRows = await db.all(sql`
    SELECT COUNT(*) AS n FROM telemetry_install_profile
    WHERE install_day >= ${from} AND install_day <= ${to}
      AND (${version} IS NULL OR first_app_version = ${version})
      AND COALESCE(channel, 'official') = 'official'
  `) as unknown as Array<Record<string, unknown>>;
  const total = num((countRows[0] ?? {}).n);

  const rows = await db.all(sql`
    SELECT install_id, install_at, install_day, first_app_version, os_locale, trial_granted,
      t_first_frame, t_onb_done, t_core, liked, retained, t_purchase_click, t_activated,
      active_days, sessions, liking_score
    FROM telemetry_install_profile
    WHERE install_day >= ${from} AND install_day <= ${to}
      AND (${version} IS NULL OR first_app_version = ${version})
      AND COALESCE(channel, 'official') = 'official'
    ORDER BY install_at DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `) as unknown as Array<Record<string, unknown>>;

  return {
    items: rows.map((r) => ({
      installId: String(r.install_id),
      installAt: String(r.install_at),
      installDay: String(r.install_day),
      appVersion: String(r.first_app_version ?? "?"),
      locale: r.os_locale ? String(r.os_locale) : null,
      trialGranted: num(r.trial_granted),
      launch: r.t_first_frame ? 1 : 0,
      onboarding: r.t_onb_done ? 1 : 0,
      core: r.t_core ? 1 : 0,
      liked: num(r.liked),
      retained: num(r.retained),
      bought: r.t_purchase_click ? 1 : 0,
      paid: r.t_activated ? 1 : 0,
      activeDays: num(r.active_days),
      sessions: num(r.sessions),
      score: r.liking_score === null ? null : num(r.liking_score),
    })),
    total,
    page,
    pageSize,
  };
}

/** 版本对比：等长窗口 + n<100 标灰。 */
export function compareVersions(rows: FunnelVersionRow[]): Array<FunnelVersionRow & {
  s3Rate: number;
  buyRate: number;
  small: boolean;
  mature: boolean;
  deltaS3: number | null;
}> {
  // 最新版本在最上面；Δ 对比的是"上一版"（数组里更老的那个）
  // 成熟 = 该版本的首个安装日距今天 >= 7 天（观察窗口走完）
  const verKey = (v: string): number[] => v.split(".").map((x) => { const n = Number(x); return Number.isFinite(n) ? n : -1; });
  const ordered = [...rows].sort((a, b) => {
    const ka = verKey(a.version);
    const kb = verKey(b.version);
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d !== 0) return d;
    }
    return b.releaseDay.localeCompare(a.releaseDay);
  });
  return ordered.map((r, i) => {
    const prev = ordered[i + 1];
    const s3Rate = r.installs ? (100 * r.s3) / r.installs : 0;
    const prevRate = prev && prev.installs ? (100 * prev.s3) / prev.installs : null;
    const mature = (r.observedDays ?? 0) >= 7;
    return {
      ...r,
      s3Rate: Math.round(s3Rate * 10) / 10,
      buyRate: r.installs ? Math.round((1000 * r.s6) / r.installs) / 10 : 0,
      small: r.installs < 100,
      mature,
      // 未满 7 天的版本不参与 Δ（分母还没长齐）
      deltaS3: prevRate === null || !mature ? null : Math.round((s3Rate - prevRate) * 10) / 10,
    };
  });
}

export type FeatureComboRow = {
  key: string;
  label: string;
  dance: number;
  imp: number;
  ai: number;
  n: number;
  buy: number;
  pay: number;
  buyRate: number;
  payRate: number;
  ciLow: number;
  ciHigh: number;
  delta: number | null;
  significant: boolean;
};

/** Wilson 95% 区间（百分比）。 */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, 100 * (c - h)), Math.min(100, 100 * (c + h))];
}

/**
 * 功能组合阶梯：3 个核心功能（跳舞 / 导入 / 真AI）的 8 种组合 → 购买率、支付率、95% CI。
 * 回答"哪个功能组合的人最可能买"，用于排宣传与教程优先级。
 * 注意：组合是自选择结果，不是实验；AI 档样本小，只看方向。
 */
export async function getFeatureCombos(
  db: Database,
  params: { days?: number; version?: string | null } = {},
): Promise<{ rows: FeatureComboRow[]; totals: { dance: number; imp: number; ai: number; installs: number } }> {
  const days = reportDays(params.days);
  const version = params.version && params.version !== "all" ? params.version : null;
  const to = daysAgo(WINDOW_DAYS);
  const from = daysAgo(WINDOW_DAYS + days - 1);

  const raw = await db.all(sql`
    SELECT f_dance AS d, f_import AS i, f_ai AS a,
      COUNT(*) AS n,
      SUM(CASE WHEN t_purchase_click IS NOT NULL THEN 1 ELSE 0 END) AS buy,
      SUM(CASE WHEN t_activated IS NOT NULL THEN 1 ELSE 0 END) AS pay
    FROM telemetry_install_profile
    WHERE install_day >= ${from} AND install_day <= ${to}
      AND (${version} IS NULL OR first_app_version = ${version})
      AND COALESCE(channel, 'official') = 'official'
    GROUP BY f_dance, f_import, f_ai
  `) as unknown as Array<Record<string, unknown>>;

  const rows: FeatureComboRow[] = raw.map((r) => {
    const dance = num(r.d) ? 1 : 0;
    const imp = num(r.i) ? 1 : 0;
    const ai = num(r.a) ? 1 : 0;
    const n = num(r.n);
    const buy = num(r.buy);
    const pay = num(r.pay);
    const [ciLow, ciHigh] = wilson(buy, n);
    const label = `舞${dance ? "✓" : "·"} 导${imp ? "✓" : "·"} AI${ai ? "✓" : "·"}`;
    return {
      key: `${dance}${imp}${ai}`, label: `${label}`,
      dance, imp, ai, n, buy, pay,
      buyRate: n ? Math.round((1000 * buy) / n) / 10 : 0,
      payRate: n ? Math.round((1000 * pay) / n) / 10 : 0,
      ciLow: Math.round(ciLow * 10) / 10,
      ciHigh: Math.round(ciHigh * 10) / 10,
      delta: null,
      significant: false,
    };
  });

  const base = rows.find((r) => r.key === "000");
  for (const r of rows) {
    // n<30 的档位（AI 组合）不参与 Δ：样本太小，差值没有意义
    if (base && r.key !== "000" && r.n >= 30) r.delta = Math.round((r.buyRate - base.buyRate) * 10) / 10;
  }
  // 显著：与上一档（按 跳舞→+导入→+AI 的阶梯）CI 不重叠
  const order = ["000", "100", "010", "110", "111", "101", "011"];
  for (let idx = 1; idx < order.length; idx += 1) {
    const cur = rows.find((r) => r.key === order[idx]);
    const prev = rows.find((r) => r.key === order[idx - 1]);
    if (cur && prev) cur.significant = cur.ciLow > prev.ciHigh;
  }
  // 阶梯顺序：功能数少的在前，同数量按购买率升序
  rows.sort((x, y) => {
    const fx = x.dance + x.imp + x.ai;
    const fy = y.dance + y.imp + y.ai;
    if (fx !== fy) return fx - fy;
    return x.buyRate - y.buyRate;
  });

  const totals = {
    dance: rows.filter((r) => r.dance).reduce((s, r) => s + r.n, 0),
    imp: rows.filter((r) => r.imp).reduce((s, r) => s + r.n, 0),
    ai: rows.filter((r) => r.ai).reduce((s, r) => s + r.n, 0),
    installs: rows.reduce((s, r) => s + r.n, 0),
  };
  return { rows, totals };
}

export type FunnelBreakdown = {
  importClick: number;
  importOk: number;
  msgReal: number;
  realAi: number;
  dance: number;
  activeCore: number;
  passiveDance: number;
};

/**
 * 核心功能层的子步骤拆解：点导入 → 成功、主动发言 → 真回复、跳舞。
 * 走 install_day（≈1 万行），只对已满窗 cohort，不扫事件表。
 */
export async function getFunnelBreakdown(
  db: Database,
  params: { days?: number; version?: string | null } = {},
): Promise<FunnelBreakdown> {
  const days = reportDays(params.days);
  const version = params.version && params.version !== "all" ? params.version : null;
  const to = daysAgo(WINDOW_DAYS);
  const from = daysAgo(WINDOW_DAYS + days - 1);

  const rows = await db.all(sql`
    SELECT
      COUNT(DISTINCT CASE WHEN d.import_click_n > 0 THEN d.install_id END) AS import_click,
      COUNT(DISTINCT CASE WHEN d.import_ok_n > 0 THEN d.install_id END) AS import_ok,
      COUNT(DISTINCT CASE WHEN d.msg_real_n > 0 THEN d.install_id END) AS msg_real,
      COUNT(DISTINCT CASE WHEN d.real_ai_n > 0 THEN d.install_id END) AS real_ai,
      COUNT(DISTINCT CASE WHEN d.dance_n > 0 THEN d.install_id END) AS dance
    FROM telemetry_install_day d
    JOIN telemetry_install_profile p ON p.install_id = d.install_id
    WHERE p.install_day >= ${from} AND p.install_day <= ${to}
      AND d.day >= p.install_day
      AND d.day <= date(p.install_day, '+6 day')
      AND (${version} IS NULL OR p.first_app_version = ${version})
      AND COALESCE(p.channel, 'official') = 'official'
  `) as unknown as Array<Record<string, unknown>>;

  const r = rows[0] ?? {};
  const base = await db.all(sql`
    SELECT
      SUM(CASE WHEN f_import = 1 OR f_ai = 1 THEN 1 ELSE 0 END) AS active_core,
      SUM(CASE WHEN f_dance = 1 AND f_import = 0 AND f_ai = 0 THEN 1 ELSE 0 END) AS passive_dance
    FROM telemetry_install_profile
    WHERE install_day >= ${from} AND install_day <= ${to}
      AND (${version} IS NULL OR first_app_version = ${version})
      AND COALESCE(channel, 'official') = 'official'
  `) as unknown as Array<Record<string, unknown>>;
  const b = base[0] ?? {};

  return {
    importClick: num(r.import_click),
    importOk: num(r.import_ok),
    msgReal: num(r.msg_real),
    realAi: num(r.real_ai),
    dance: num(r.dance),
    activeCore: num(b.active_core),
    passiveDance: num(b.passive_dance),
  };
}

export function stageRates(totals: FunnelTotals) {  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
  return {
    s1: pct(totals.s1, totals.s0),
    s2: pct(totals.s2, totals.s1),
    s3: pct(totals.s3, totals.s2),
    s4: pct(totals.s4, totals.s3),
    s5: pct(totals.s5, totals.s4),
    s6: pct(totals.s6, totals.s5),
    s7: pct(totals.s7, totals.s6),
    toS7: pct(totals.s7, totals.s0),
  };
}
