# D1 用量与遥测数据异常调研报告

> 日期：2026-08-21
>
> 背景：Cloudflare 后台显示该库「已读取 6.79M 行 / 已写入 238.31K 行」，怀疑数据量异常；同日团队观察后台遥测报表，怀疑「当天大量数据没有写进去」。
>
> 方式：全程只读排查（wrangler d1 execute --remote 仅 SELECT + Cloudflare GraphQL 分析接口），未修改任何数据。

## 1. 结论摘要

1. **数据库实际只有 ~4.7 万行**，后台的 6.79M / 238K 是「行操作次数」累计值，不是行数。数字大是因为**写放大**（每条遥测事件 ≈ 10 行写）和**后台报表全表扫描**（读放大），不是数据量问题。
2. **写入链路完全正常**。调查当天最新事件距查询时刻仅 14 分钟，Workers 错误率为 0，未触发任何 D1 限额。
3. **「今天数据缺失」是时区错觉**：所有统计口径均为 UTC，「一天」= 北京时间早 8 点 → 次日早 8 点。北京晚间看后台时「今天」的桶必然只积累了一部分。
4. **存在一个真实 bug**：聚合表（`telemetry_daily_metrics` / `telemetry_session_state`）采用先 SELECT 再 UPDATE 的非原子写，并发下每天静默丢失约 5~9% 的计数。

## 2. 数据库实际规模（2026-08-21 实测）

| 表 | 行数 | 说明 |
|---|---:|---|
| telemetry_events | 36,233 | 66 天累计（2026-06-17 起），604 台机器、3,303 个会话 |
| telemetry_daily_uniques | 5,596 | |
| telemetry_session_state | 3,273 | |
| activation_logs | 1,129 | trial_start_success 539 / trial_already_used 482 / trial_active 69 / activate 39 |
| trial_grants | 529 | |
| telemetry_daily_metrics | 491 | |
| entitlements / licenses | 63 / 63 | |
| activations | 28 | |
| 其余（plans/products/audit_logs/subscriptions/webhook_events 等） | < 15 | **subscriptions 与 webhook_events 均为 0 行**，若 Creem webhook 已上线需另行核实 |
| **合计** | **≈ 47,430** | 库大小 55.4 MB（大头为 raw_json/payload_json） |

事件类型分布（Top）：session_heartbeat 22,923（**占 63%**）、session_start 3,291、frontend_mounted 2,981、renderer_created 1,654、first_frame_rendered 1,582、session_checkpoint 1,034、session_end 964、install_seen 664。

## 3. 「6.79M 读 / 238K 写」的真实含义

D1 后台统计的是**行级操作次数**（rows read / rows written），且**索引 B-tree 的写入也计入 rows_written**。GraphQL 分析接口（`d1AnalyticsAdaptiveGroups`）拉到的近 14 天数据与后台数字同量级，证实口径一致：

```
近 14 天：read=6,332,478  written=171,019  读查询=113,049  写查询=48,442
```

### 3.1 写放大的构成（每条遥测事件 ≈ 10 行写）

每日写入量 / 每日事件数在 15 天内稳定于 **9.5~11**，分解如下：

| 步骤 | 代码位置 | 行写 |
|---|---|---:|
| INSERT telemetry_events：1 行数据 + text 主键唯一索引 + 5 个二级索引（received / product_event / machine / install / session） | `src/services/telemetry.ts:172`，索引见 `migrations/0004_telemetry.sql` | ~7 |
| UPSERT telemetry_session_state：更新 `updated_at` 导致 `(machine_hash, updated_at)` 索引项重写 | `src/services/telemetry.ts:453-491` | ~2 |
| UPDATE telemetry_daily_metrics（read-modify-write） | `src/services/telemetry.ts:493-526` | ~1 |
| 偶发：daily_uniques 首次插入、trial/activation 日志 | | 少量 |

### 3.2 读的构成

- **大头是管理后台**：`src/services/telemetry.ts` 中 13 个报表函数（getTelemetryReport、getProductFunnel、getRetentionReport 等）多次全扫/GROUP BY `telemetry_events`（36K 行且持续增长），单次查询可扫数万行。分析数据里多次出现单小时 10~30 万行的读尖峰，与人工浏览后台的时间吻合。
- 小头是上报管道自身：每条事件约 6~8 行小读（去重检查、聚合查询），量级可忽略。
- 调研当天的对账查询本身也贡献了约 90 万行读（多次全表 COUNT/GROUP BY）。

## 4. 「今天数据写不进去」的调查结论

### 4.1 排除写入故障

- 按小时对账：调查日（UTC 08-21）00:00~09:00 每小时均有事件入库（48/28/34/19/12/30/23/39/84 条），无断档；
- 最后一条事件 09:18:40 UTC（= 北京 17:18），距查询仅 14 分钟；
- Workers 当日错误数 0，D1 写入量远低于限额（当日 ~3K，免费版上限 100K/天）。

### 4.2 真正原因：统计口径全部是 UTC

| 环节 | 代码位置 | 时区 |
|---|---|---|
| 入库时间戳 `received_at` | `toSqlDateTime()`，`src/services/telemetry.ts:1879`（`toISOString()`） | UTC |
| 聚合表归日 `day` | `metricDimensions()`，`src/services/telemetry.ts:376`（`toISOString().slice(0,10)`） | UTC |
| 报表窗口与横轴 | `getTelemetryReport()`，`src/services/telemetry.ts:575-598` | UTC |
| 激活/日志类时间戳 | `nowISO()`，`src/services/activation.ts:72` | UTC |
| 表默认值 `datetime('now')` | 各 migration | UTC（SQLite 语义） |

后果：统计上的「一天」= **北京时间 08:00 → 次日 08:00**。北京下午/晚间查看后台时，「今天」的桶只包含北京 08:00 起的部分数据，晚间高峰尚未落入，日环比天然偏低 40%+，看起来像「下午开始写不进去了」。凌晨 0~8 点的使用量则被计入「昨天」。

### 4.3 真实存在的 bug：聚合计数每天丢 5~9%

`telemetry_daily_metrics`（SUM 口径）与 `telemetry_events`（原始口径）按日对账：

| 日（UTC） | 聚合 events | 原始 events | 丢失 |
|---|---:|---:|---:|
| 2026-08-14 | 817 | 855 | -4.4% |
| 2026-08-15 | 4,507 | 4,796 | -6.0% |
| 2026-08-16 | 1,183 | 1,244 | -5.1% |
| 2026-08-17 | 1,062 | 1,102 | -3.6% |
| 2026-08-18 | 1,460 | 1,602 | -8.9% |
| 2026-08-19 | 1,258 | 1,380 | -8.8% |
| 2026-08-20 | 1,532 | 1,687 | -9.2% |

原因：`incrementDailyMetrics`（telemetry.ts:493）与 `updateSessionState`（telemetry.ts:415，且内部与 `upsertSessionState` 重复查询两次）都是**先 SELECT 再 UPDATE 的非原子 read-modify-write**。D1 多 isolate 并发处理请求时，两个并发事件读到同一旧值后互相覆盖，导致 `events` / `launches` / `active_secs` 等指标系统性偏低。原始事件表 `telemetry_events` 不受影响（INSERT 天然原子），丢的只是聚合口径。

## 5. 改进建议（按优先级，均未实施）

| # | 建议 | 解决什么 | 改动量 | 备注 |
|---|---|---|---|---|
| 1 | 聚合改原子 UPSERT：`INSERT ... ON CONFLICT DO UPDATE SET events = events + excluded.events ...` | 5~9% 丢数；顺带各省一次 SELECT（读写双降） | 小，仅 telemetry.ts 两个函数 | `updateSessionState` 内的重复 SELECT 可一并去掉 |
| 2 | 统计口径改北京时间：`metricDimensions` 归日、报表窗口、admin_ui 时间戳渲染统一 +8h（或 `Intl` 带 `timeZone: "Asia/Shanghai"`） | 「今天缺数据」的错觉；凌晨数据归属 | 小~中 | 注意切换日前后有 8 小时口径断层；可选做历史回填（从 `received_at_unix` 重算 `day`，属写操作需单独确认） |
| 3 | 报表查询默认限定最近 7~14 天并强制带日期条件 | 读放大（团队只关心最近一周） | 小 | retention/funnel 等天然需要长窗口的报表需单独评估 |
| 4 | 评估删除低价值二级索引（候选：`telemetry_events_install_idx`；`session_idx` 需先确认无查询依赖） | 写放大（每删 1 个索引 ≈ 全局写量 -10%） | 小（需先 grep 报表 WHERE 条件确认） | 主键索引用于去重，必须保留 |
| 5 | 拉长客户端心跳间隔 | 心跳占事件 63%，间隔翻倍 ≈ 写量 -40~50% | 中（客户端） | 注意 `boundedDelta` 截断逻辑，间隔过长会丢 `active_secs` 精度 |
| 6 | 定期归档/清理超过 30~60 天的 telemetry_events | 控制表增长（当前 ~800 条/天）、保持报表速度 | 中 | |
| 7 | 远期：遥测迁出 D1（Workers Analytics Engine / R2） | 遥测占写入 ~99%，迁走后 D1 写入基本归零 | 大 | 授权核心表的写入量极小（<1%），无需迁移 |

## 6. 当前用量与限额对照

| 指标 | 实测峰值（日） | 免费版上限 | 付费版（Workers Paid）包含 |
|---|---:|---:|---|
| rows written / 天 | ~40K（08-15） | 100K | 50M / 月 |
| rows read / 天 | ~940K（08-20） | 5M | 25B / 月 |

结论：当前量级无额度风险；但读随表增长 + 后台使用频率上升，写随用户量线性上升，建议按第 5 节顺序做 1、2、3 项低成本优化。

## 7. 调研方法备忘（可复现）

```bash
# 表清单 / 行数（只读）
npx wrangler d1 execute animate-licence-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
# 注意：D1 限制复合 SELECT 项数，多表 COUNT 需拆分或用 --file 多语句

# 每日/每小时行操作（GraphQL，需 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID 环境变量）
# dataset: d1AnalyticsAdaptiveGroups（dimensions: date/datetimeHour; sum: rowsRead/rowsWritten/readQueries/writeQueries）
# Workers 错误率: workersInvocationsAdaptive（sum: requests/errors）

# 聚合表 vs 原始表对账（注意必须 SUM，daily_metrics 按维度拆多行）
SELECT m.day, SUM(m.events), (SELECT COUNT(*) FROM telemetry_events e WHERE substr(e.received_at,1,10)=m.day)
FROM telemetry_daily_metrics m WHERE m.day >= '...' GROUP BY m.day;
```

环境备注：本机 `curl.exe`（schannel）与 `Invoke-RestMethod` 直连 api.cloudflare.com 会失败，wrangler（Node TLS）可用；wrangler 3.x 的 `--json` + `--file` 组合只返回汇总不返回逐条结果，需要逐条结果时用 `--command`。
