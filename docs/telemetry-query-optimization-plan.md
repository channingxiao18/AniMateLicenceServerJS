# 遥测后台查询优化方案（分析 + 实施细节）

> 日期：2026-10-15
> 状态：**P0 + P1 已实现（未部署、未写线上数据）**；实施记录与实测口径变化见 §8
> 触发：D1 Query Insights 显示 4 条查询吃掉了当天大部分读额度（5M 行/天不够用两次后台浏览）
> 证据来源：`analysis/telemetry.db`（2026-10-08 生产全库快照，235K 事件 / 2082 个 install）
> 约束：**不得破坏线上数据**——所有读路径改动都是纯 SELECT；唯一的写路径改动是"新增一类聚合行"（只增不改不删，可回滚）
> 本次改动的文件：`src/services/telemetry.ts`、`src/services/trial.ts`、`src/routes/admin_ui.ts`、
> `tests/telemetry.test.ts`、`tests/trial.test.ts`、`scripts/backfill_install_active.ts`（新增）

---

## 0. 结论摘要

| # | 查询 | 归属页面 | 现状（截图） | 根因 | 建议 |
|---|---|---|---|---|---|
| Q1 | 设备活跃事件分块扫描 | 活跃设备 / 留存分析 / 活跃设备-某日 | 68 次 / **1.64M 行** / 32% 时长 | 每次都用 3 天一块的原始事件重算"每天每台设备" | 新增 `install_active` 日聚合行 + 页面改读聚合表 |
| Q2 | `select distinct machine_hash ... lower(install_id)=?` | **试用记录页 `/admin/trials` 搜索框** | 5 次 / **1.46M 行** / 17.7% 时长 | 列上套 `lower()` + 索引是裸列 → 全表索引扫描 | 去掉 `lower()`，改等值（~1 行/次） |
| Q3 | `install_seen` 全历史扫描 | 新增安装 / 留存 / 某日新增 | 34 次 / 83.2K 行 / 13.8% 时长 | 无时间下界，每次读全历史安装事件 | 把报表窗口推进 SQL |
| Q4 | 安装详情（按 install_id 全量取事件） | 用户行为详情 `/admin/telemetry/install/:id` | 6 次 / 141.2K 行（≈23.5K 行/次） | 单次把该 install 的全部事件（含 payload、含 2 万+ 心跳）拉进 Worker | 窗口化 + SQL 侧分页 + 拆聚合查询 |
| Q5 | `insert into telemetry_events ... returning event_id` | 上报写入路径 | 10.9K 次 / 64.7K 行写 / 13.2% 时长 | 每条事件 1 行数据 + 5 个索引项 ≈ 6 行写 | 批量写入（需客户端配合）/ 不再存 `raw_json`（需确认） |
| Q6 | `INSERT INTO telemetry_daily_uniques ... RETURNING` | 上报写入路径 | 15.9K 次 / 2.1K 行写 / 4.9% 时长 | 每条事件 2~3 条独立语句 | 合并成一条多值 INSERT |

**预计效果**：Q1+Q2 两项即从约 3.1M 行/天降到约 5K 行/天（>99%）；Q3+Q4 再降约 200K 行/天。
四条读查询合计从 ~3.3M 行/天降到 ~0.2M 行/天，免费版 5M/天的额度不再被两次后台浏览打穿。

---

## 1. 四条查询到底是谁发的（精确定位）

### Q1 — 设备活跃事件分块扫描

生成代码：[`src/services/telemetry.ts:1856`](../src/services/telemetry.ts#L1856)（列清单在 `DEVICE_ACTIVITY_COLUMNS`，[:1758](../src/services/telemetry.ts#L1758)），由 [`loadDailyDeviceActivity()`](../src/services/telemetry.ts#L1787) 调用，每次按 `DEVICE_ACTIVITY_CHUNK_DAYS = 3` 天分块，另加一次"窗口前一天"的会话时长基线查询 [`seedSessionDurations()`](../src/services/telemetry.ts#L1815)。

三个页面共用它：

| 页面 | 路由 | 调用链 |
|---|---|---|
| 活跃设备（列表） | `/admin/telemetry/activity` | [`getActivityDaysUncached`](../src/services/telemetry.ts#L1625) |
| 活跃设备（某日明细） | `/admin/telemetry/activity/:day` | [`listActiveDevicesForDay`](../src/services/telemetry.ts#L1658) |
| **留存分析** | `/admin/telemetry/retention` | [`getRetentionReportUncached`](../src/services/telemetry.ts#L1907) |

30 天窗口 = 1 次基线 + 10 次分块 = **11 条重查询**，每条都要读窗口内全部 71 种"活跃候选事件"。

事件候选集：`DEVICE_ACTIVITY_EVENTS`（[:1728](../src/services/telemetry.ts#L1728)）= 6 个 session/surface 事件 + `PRODUCT_EVENT_NAMES`（[:192](../src/services/telemetry.ts#L192)）≈ 71 个，正好对应截图里那一长串 `?`。

### Q2 — 试用记录页按 install_id 搜索

生成代码：[`src/services/trial.ts:467-477`](../src/services/trial.ts#L467)（`lower(${telemetryEvents.installId}) = ${term.toLowerCase()}`），页面是 **`/admin/trials`（试用记录 / 试用管理）** 的搜索框，路由在 [`src/routes/admin_ui.ts:428`](../src/routes/admin_ui.ts#L428)。只有用户粘贴 install_id 搜索时才触发，但每次全表扫描。

### Q3 — install_seen 全历史

[`loadInstallations()`](../src/services/telemetry.ts#L1580)（[:1593](../src/services/telemetry.ts#L1593)），三个调用点：[`getInstallationDays`](../src/services/telemetry.ts#L1460)、[`listInstallationsForDay`](../src/services/telemetry.ts#L1504)、[`getRetentionReportUncached`](../src/services/telemetry.ts#L1918)。都是先把全历史读进内存再按天过滤。

### Q4 — 安装详情

[`getTelemetryInstallDetail()`](../src/services/telemetry.ts#L1221)（[:1234](../src/services/telemetry.ts#L1234)），页面 `/admin/telemetry/install/:installId`（路由 [`admin_ui.ts:912`](../src/routes/admin_ui.ts#L912)）。`select` 全部 17 列（含 `payload_json`），无时间下界，然后 JS 里排序、聚合、再切 100 行出来显示。

### Q5/Q6 — 上报写入路径

- [`recordTelemetryEvent()`](../src/services/telemetry.ts#L351) 的 `insert ... on conflict do nothing returning event_id`
- [`updateAggregates()`](../src/services/telemetry.ts#L507) 里每条事件 2~3 次 [`insertDailyUnique()`](../src/services/telemetry.ts#L559)（`machine_active` / `session_seen`，install_seen 事件另加一次）

---

## 2. 实测证据（本地生产快照，只读）

### 2.1 数据规模

```
telemetry_events         234,963 行（product 全是 animate；2,082 个 install）
telemetry_daily_uniques   21,031 行（machine_active 5,396 / session_seen 13,570 / install_seen 2,065）
telemetry_daily_metrics    1,212 行（按维度拆，每天 12~15 行）
telemetry_session_state   11,755 行
每日事件量：3.9K ~ 7.9K
```

### 2.2 Q2 的 EXPLAIN QUERY PLAN（关键证据）

```
今天：SELECT DISTINCT machine_hash FROM telemetry_events WHERE lower(install_id) = ?
      -> SCAN telemetry_events USING INDEX telemetry_events_machine_idx      （整表索引扫描）
      本地耗时 28,866 ms，读 234,963 行

改成：SELECT DISTINCT machine_hash FROM telemetry_events WHERE install_id = ?
      -> SEARCH telemetry_events USING INDEX telemetry_events_install_idx (install_id=?)
      本地耗时 41 ms，读 ~1 行
```

补充事实：快照里 `install_id <> lower(install_id)` 的行数 = **0**，即列本来就全是小写，而 JS 侧已经 `.toLowerCase()` 了入参 —— `lower()` 纯粹是白白废掉索引。**收益约 700 倍，一行代码。**

### 2.3 Q1 的真实成本

```
1 天分块：plan = SEARCH USING product_event_idx (product_id=? AND event=? AND received_at>?<?) + USE TEMP B-TREE FOR ORDER BY
          返回 1,448 行（当天快照不完整）；30 天窗口一次页面浏览读 103,181 行
截图 68 次调用 = 1.64M 行 → 平均 24.1K 行/次，与"3 天分块 ≈ 3×6~8K"吻合，说明读的行基本都是匹配行，
没有浪费在错行上 —— 它是"设计上就要读这么多"，只能换数据源，加索引/改写法都救不了。
```

### 2.4 换成聚合表能省多少（30 天 / 90 天窗口实测）

| 数据源 | 30 天 | 90 天 |
|---|---:|---:|
| 现在的原始活跃事件（Q1） | **103,181** | 158,139 |
| 只读 5 种时长事件（保留精确口径的方案） | 55,841 | 97,583 |
| 只读 session_start | 6,708 | 10,744 |
| **`install_active` 日聚合（新增，方案主体）** | **3,424** | 5,326 |
| `telemetry_daily_metrics`（已有，日汇总） | 518（GROUP BY 后 30 行） | 1,093 |
| `telemetry_daily_uniques` 里 install_seen | 965 | 1,908 |

即：**留存页 30 天从每次浏览约 105K 行降到约 5.5K 行（-95%）**，活跃设备列表页从约 103K 行降到约 3.5K 行（-97%）。

### 2.5 用聚合表会不会改数字？（关键验证，`_perf_probe4_1015.py`）

用 Python 逐字复刻 `seedSessionDurations + accumulateDeviceActivity`，与 `telemetry_daily_metrics` 对账最近 30 天每天的活跃时长：

| 日期 | 报表重算 | 聚合表 | 差异 |
|---|---:|---:|---:|
| 2026-10-08 | 643,900 | 643,428 | +0.07% |
| 2026-10-07 | 4,078,872 | 4,076,562 | +0.06% |
| 2026-10-06 | 6,565,675 | 6,564,784 | +0.01% |
| 2026-10-05 | 528,282 | 527,320 | +0.18% |
| 2026-10-02 | 901,989 | 902,975 | −0.11% |
| 2026-09-22 | 3,146,113 | 3,190,756 | **−1.40%** |
| 2026-09-21 | 1,356,330 | 1,269,855 | **+6.81%** |
| 2026-09-18 | 1,704,209 | 1,511,258 | **+12.77%** |
| 2026-09-16 | 1,303,422 | 1,229,124 | **+6.04%** |
| 2026-09-13 | 1,323,815 | 1,221,104 | **+8.41%** |

结论：**设备数（devices）两边完全一致**（按 `(day, install)` 集合算，逐日核对 75/167/166/166/131 对齐），**launches 一致**（快照里 `session_start` 且 install_id 为空的行数 = 0），**只有 `active_secs` 在 9 月中旬那几天有 1%~13% 差异**——那正是 `docs/d1-usage-investigation.md §4.3` 记录的"非原子 upsert 丢计数"的日期；10 月修好之后差异 ≤0.2%。所以：
- 留存页：**数字不会变**（只用集合，不用时长）。
- 活跃设备列表页：`devices`/`launches` 不变，`active_secs` 会换成"入库时累计值"（新日期基本一致，历史少数日期会变，方向是更接近真实值）。**这是一个需要你拍板的展示口径变化**，方案里给了三个选项（见 3.3）。

### 2.6 索引体检（决定"要不要再删索引"）

```
raw events page (只带时间窗)  -> SEARCH USING telemetry_events_received_idx   ← 必须保留
users page (product + 时间窗) -> SEARCH USING product_event_idx (product_id=?) ← 见 §5 附加观察
machine detail                -> SEARCH USING machine_idx                     ← 必须保留
install detail                -> SEARCH USING install_idx                     ← 必须保留
install_seen history          -> SEARCH USING product_event_idx               ← 必须保留
未来的 install_active 读取     -> COVERING INDEX (day, product, type, value)    ← 主键索引已够用，无需新建索引
未来的 daily_metrics 读取      -> 主键索引 (day, ...)                          ← 够用
```

**结论：4 个二级索引都在用，一个都不能再删**（`0016` 删掉的两个已经是最优结果）。想继续降写入只能靠"减少语句/减少列/批量"，不能靠删索引。特别提醒：`received_idx` 看着"多余"（其它索引都以 product_id 打头），但 `/admin/telemetry/events` 在**不带任何筛选**时只按时间窗查，删掉它会退化成全表扫描，**不要删**。

---

## 3. 优化方案

### P0 —— 当天就能止血（纯读路径，零数据风险）

#### P0-1　Q2：去掉列上的 `lower()`（1 行，700 倍）

`src/services/trial.ts` 搜索分支改为：

```ts
const termLower = term.toLowerCase();
// install_id 入库就是客户端原样（UUID，小写），快照实测 0 行与 lower() 不同；
// 列上套 lower() 会让 (install_id, received_at) 索引失效 → 全表扫描。
const installMachineHashes = new Set(
  (
    await db
      .selectDistinct({ machineHash: telemetryEvents.machineHash })
      .from(telemetryEvents)
      .where(eq(telemetryEvents.installId, termLower))
      .all()
  )
    .map((row) => row.machineHash)
    .filter((hash): hash is string => !!hash)
);
```

- 不需要再加"像不像 install_id"的前置判断：等值查询走索引，任何词都是 1 次索引探测。
- 大小写兼容性：入参仍先 `.toLowerCase()`，与原语义等价；`install_id` 若将来出现大写行会失配 —— 用一条测试固定这个前提（见 §4）。
- 预期：1.46M 行/天 → <10 行/天。

#### P0-2　Q3：把时间窗推进 `loadInstallations`

[`loadInstallations()`](../src/services/telemetry.ts#L1580) 增加可选窗口参数，把 `gte/lte(receivedAt, ...)` 下推到 SQL：

```ts
async function loadInstallations(
  db: Database,
  productId: string,
  installIds?: string[],
  window?: { from?: string; to?: string }
)
```

调用点传参：`getInstallationDays` → `from = start`；`listInstallationsForDay` → `from = to = day`；`getRetentionReportUncached` → `from = start`。

- 语义提醒：现在"取全历史第一条 install_seen 当首次安装日"，加了窗口后变成"窗口内第一条"。快照实测 `install_seen` 每台设备**恰好 1 条**（2,066 条事件 / 2,066 个 install，0 个重复），所以当前无差异；用一个测试把这个前提钉住，将来客户端若重复上报 install_seen，测试会先炸。
- 预期：30 天窗口 2,066 → 965 行；单日明细页 2,066 → ~30 行。
- 进一步（可选）：这个页面也可以直接读 `telemetry_daily_uniques` 的 `install_seen` 行（2,065 行，含 day / first_seen_at / 渠道维度），但它同样有"窗口内首见"的语义，而且**少 1 台设备**（快照里 `9b798183-…` 在 2026-09-21 的聚合行缺失，属于聚合写入静默失败，见 P1-5），所以本期建议仍以原始表为主。

### P1 —— 治本：Q1 改读日聚合（核心改动）

#### P1-1　新增 `install_active` 日聚合

在 [`updateAggregates()`](../src/services/telemetry.ts#L507) 里，对"活跃候选事件 + 有 install_id"再补一行（与现有 `machine_active`/`session_seen` 同一个分支）：

```ts
if (envelope.installId) {
  await insertDailyUnique(db, dims, "install_active", envelope.installId, receivedAt);
}
```

关键约束：**入库用的候选事件列表必须与报表用的 `DEVICE_ACTIVITY_EVENTS` 是同一个常量**。现在两边各写了一份（[:507](../src/services/telemetry.ts#L507) 与 [:1728](../src/services/telemetry.ts#L1728)），内容目前逐字相同，但极易漂移 —— 先把 `DEVICE_ACTIVITY_EVENTS` 提到两个函数之前并让 `updateAggregates` 复用它（纯重构，行为不变）。

数据安全：`INSERT ... ON CONFLICT (day, product_id, unique_type, unique_value) DO NOTHING`，只新增行、不修改/删除任何已有行。回滚 = 不读它，或 `DELETE FROM telemetry_daily_uniques WHERE unique_type='install_active'`（可选，且不影响其它类型）。

#### P1-2　留存页改读 `install_active`（数字不变）

[`getRetentionReportUncached()`](../src/services/telemetry.ts#L1907)：

```ts
const [installationRows, activeRows] = await Promise.all([
  loadInstallations(db, productId, undefined, { from: start, to: today }),   // 队列 = 首次安装
  db.select({ day: telemetryDailyUniques.day, installId: telemetryDailyUniques.uniqueValue })
    .from(telemetryDailyUniques)
    .where(and(
      eq(telemetryDailyUniques.productId, productId),
      eq(telemetryDailyUniques.uniqueType, "install_active"),
      gte(telemetryDailyUniques.day, start),
      lte(telemetryDailyUniques.day, today),
    )).all(),
]);
const activityKeys = new Set(activeRows.map((row) => `${row.installId}\u0000${row.day}`));
```

其余留存矩阵逻辑（offsets / ratePct / summary）**一行都不用动**，因为它只吃 `activityKeys`。

- 预期：30 天窗口 103K 行 → 3.4K 行。
- 灰度兜底（建议做）：`install_active` 是上线后才开始写的，历史窗口没有数据。加一条"窗口起点早于回填日期就回退老逻辑"的分支，或先把回填写完再切页面，二者选一，保证上线当天页面不会突然全 0。

#### P1-3　活跃设备列表页改读聚合

[`getActivityDaysUncached()`](../src/services/telemetry.ts#L1625)：

- `devices` ← `install_active` 按天计数（与今天逐日一致：75/167/166/166/131 已核对）
- `launches` ← `telemetry_daily_metrics` 按天 `SUM(launches)`（一致：`session_start` 无 install_id 的行数为 0）
- `activeSecs` ← 见 3.3 的三个选项

预期：30 天 103K 行 → 约 3.5K 行（`install_active` 3.4K + metrics 30 行）。

#### P1-4　`install_active` 回填（一次性，只增数据）

**推荐做法：在本地用快照生成 INSERT，再推到线上** —— 这样完全不消耗线上读额度：

```sql
-- 在本地对 analysis/telemetry.db（或更新的快照）执行，按周切片生成
INSERT INTO telemetry_daily_uniques
  (day, product_id, unique_type, unique_value, source_id, platform, channel, app_version, license_state, first_seen_at)
SELECT substr(received_at,1,10), product_id, 'install_active', install_id,
       source_id, platform, channel, app_version, license_state, MIN(received_at)
FROM telemetry_events
WHERE product_id = 'animate'
  AND install_id IS NOT NULL
  AND event IN ( /* 71 个 DEVICE_ACTIVITY_EVENTS */ )
  AND received_at >= '2026-07-11 00:00:00'
  AND received_at <  '2026-07-18 00:00:00'
GROUP BY 1, 2, 4
ON CONFLICT (day, product_id, unique_type, unique_value) DO NOTHING;
```

- 行数：90 天约 5,300 行；30 天约 3,400 行。
- 幂等：PK 冲突直接忽略，重复执行安全。
- 只覆盖到快照日期为止；快照之后由线上实时写入补齐（上线即生效）。
- 也可以直接在线上分片跑（13 条语句覆盖 90 天），代价是约 158K 行一次性读额度 —— 本地生成更省，二选一。

#### P1-5　顺手修一个静默丢数点

`recordTelemetryEvent` 把 `updateAggregates` 包在 `try/catch` 里只打日志（[:374](../src/services/telemetry.ts#L374)）。快照里能直接看到后果：`install_seen` 原始 2,066 行、聚合只有 2,065 行（少 1 台设备）。既然报表要越来越依赖聚合表，建议给聚合步骤加**一次重试**（失败再吞），并且保留日志告警；这能把"报表少一台设备"的概率从 1/2000 再压一个量级。

#### P1-6　Q4：安装详情页

[`getTelemetryInstallDetail()`](../src/services/telemetry.ts#L1221) 现在是"全量取 + 内存里排序过滤 + 再切页"。改法：

1. 加时间窗参数（默认 30 天，可显式 `days=all`），把 `gte(receivedAt, since)` 推进 SQL；
2. 把事件列表的 `event/session_id/surface` 过滤和 `LIMIT/OFFSET` 下推到 SQL（现在是取全量再 `slice`）；
3. 摘要拆成两条轻查询：
   - 无 payload 的统计（`COUNT(*)`、`COUNT(session_start)`、`COUNT(DISTINCT session_id)`、`MIN/MAX(received_at)`、`COUNT` + `CASE WHEN` 的 first_frame / clean / unclean / workshop 计数）—— 一条聚合 SQL；
   - 只有 5 种时长事件需要 payload，用 `CASE WHEN event IN (…) THEN payload_json ELSE NULL END` 收窄（沿用 `DEVICE_ACTIVITY_COLUMNS` 的思路）；
4. 返回结构（`TelemetryInstallDetail`）保持不变，`admin_ui.ts` 不用改。

预期：那条鲸鱼 install（22,525 条事件）单次 23.5K 行 → 30 天窗口约 5K 行；其它 install 基本归零。

> 注意：按 `install_id` 取范围本身就要读该 install 的索引项，**唯一真正的降幅来自时间窗**；如果业务上必须看全历史，这个话题只能靠"按 install 的日聚合表"（P2）或降低查看频率解决。

### P2 —— 写入侧与其它页面（可选，收益/风险需权衡）

| 项 | 做法 | 预期 | 风险/依赖 |
|---|---|---|---|
| 合并 uniques 写入（Q6） | 把 `machine_active` + `session_seen` + `install_active` 合成一条多值 `INSERT ... ON CONFLICT DO NOTHING`（不带 RETURNING，这三者结果都没人用；只有 `install_seen` 需要 RETURNING 驱动的 `installs` 计数） | 每条事件少 1~2 次语句往返，15.9K 次 → ~8K 次 | 低；`D1`/SQLite 都支持多值 + ON CONFLICT |
| 批量上报（Q5） | `telemetry` 路由接受事件数组，`db.batch()` 或一条多值 INSERT | 语句数降一个数量级；**行写不降**（D1 按行计费） | 需要客户端配合发版 |
| 不再存 `raw_json`（Q5） | 该列占全库文本 66%（代码注释 [:1753](../src/services/telemetry.ts#L1753)），**没有任何报表读它** | 每条事件少写一大块，库体积大幅下降 | **数据丢弃型决策，必须你确认**；建议先只对新事件停写，或迁 R2 |
| 缩短心跳间隔（Q5） | 客户端侧 | 事件量 -40%~50% | 客户端改；注意 `boundedDelta` 精度 |
| 用户总览页 `/admin/telemetry/users` | 现状一次浏览约 74.7K 行（14 天）/ 30 天更多；EXPLAIN 显示 `product_id=?` 只用了索引前缀，实际是"整表按 product 扫 + 时间过滤" | 同样可换 `install_active` + `machine_active` + `session_state` | 中；`active_secs` 口径问题与 P1-3 相同 |
| 行为漏斗页 `/admin/telemetry/products` | 14 天约 53.6K 行 | 可按天预聚合 | 中；改动面较大 |

---

## 4. 数据安全与回滚（"不破坏线上数据"的落实）

1. **读路径**（P0、P1-2、P1-3、P1-6）：只改 SELECT，绝不写库。回滚 = `git revert`。
2. **写路径**（P1-1）：只在 `telemetry_daily_uniques` 增加一类行（`unique_type='install_active'`）。
   - 不 UPDATE、不 DELETE、不改任何现有行或列；
   - 冲突即忽略，天然幂等；
   - 回滚：代码不再读它即可；要清理也只是删掉这一类行（可选，不影响其它 unique_type）。
3. **不加新索引**（实测 4 个二级索引都在用；新增索引会立刻抬高每条事件的写入量）。本期只考虑"合并语句/少写列"，不做 schema 结构变更。
4. **回填**：只做 `INSERT ... ON CONFLICT DO NOTHING`，先本地快照演练并核对行数，再推线上；分批执行，失败可重跑。
5. **不做的事**：不 `DELETE`/`VACUUM` 遥测数据、不改历史聚合值、不动 `raw_json` 既有数据、不改统计口径（UTC）与既有页面路由。
6. **验证手段**：任何改动先在 `analysis/telemetry.db` 副本上跑新旧对照，再跑 `npm test`，再上本地 `wrangler dev`，最后才发布。

---

## 5. 验证计划（每一步都有可执行命令）

1. **单元/集成测试**：`npm test`
   相关文件：`tests/telemetry.test.ts`（`getActivityDays` / `getInstallationDays` / `listInstallationsForDay` / `getRetentionReport` / `getTelemetryInstallDetail`）、`tests/telemetry_admin_ui.test.ts`、`tests/trial.test.ts`（install_id 搜索用例在 `tests/trial.test.ts:400` 附近）。
2. **新旧数字对照脚本**：把 `analysis/_perf_probe4_1015.py`（已能复刻老算法）扩展成断言式对照，对 7/30/90 天窗口逐一比较 `devices / cohort installs / retention rate`（要求完全相等）与 `activeSecs`（打印差异，不强制相等）。
3. **EXPLAIN 体检**：沿用 `analysis/verify_index_migration.py` 的做法，对全部报表 SQL 在改动前后各跑一次 `EXPLAIN QUERY PLAN` 并逐字对比，确保没有查询计划退化。
4. **本地端到端**：`npm run db:migrate:local` + `npm run dev`，手动打开 8 个遥测后台页签，比对改动前后截图数字。
5. **线上只读核对**（发布前）：
   ```bash
   npx wrangler d1 execute animate-licence-db --remote --command \
     "SELECT COUNT(*) FROM telemetry_daily_uniques WHERE unique_type='install_active'"
   ```
6. **发布后复测**：回到你截图的那个 Query Insights 表，确认 Q1/Q2 的行数掉下来；再用 GraphQL `d1AnalyticsAdaptiveGroups` 看每日 `rowsRead` 曲线（方法见 `docs/d1-usage-investigation.md` 第 7 节）。

---

## 6. 收尾：需要你拍板的三件事

1. **活跃设备列表页的 `active_secs` 口径**（§2.5）：
   - 方案 A（推荐，最省）：改读 `telemetry_daily_metrics.active_secs`。30 天里大部日期差 ≤0.2%，少数 9 月历史日期差 1%~13%（那些天聚合表本身就少了计数）。
   - 方案 B（数字零变化）：`active_secs` 仍从原始事件算，但只读 5 种时长事件 → 30 天 55.8K 行（比现在省 46%，比方案 A 多 16 倍读）。
   - 方案 C（最准但最贵）：新增"每（天 × install）"设备日聚合表并在入库侧累计时长，历史用同一算法回填 → 所有页面零原始扫描，但每条时长事件多一次 upsert（每日写入 +5K~8K 行，免费版 100K/天写额度会更紧）。
2. **`raw_json` 是否停写**（P2）：占库文本 66%、无任何报表使用，但属于数据丢失型决策。
3. **是否要做批量上报**（P2）：需要客户端配合发版，收益主要在延迟与语句数，不在行写额度。

---

## 附：本次分析产出的只读探针（未改任何业务代码）

- `analysis/_perf_probe_1015.py`：库规模、product 分布、install_id 大小写、EXPLAIN（Q1/Q2 对照）
- `analysis/_perf_probe2_1015.py`：聚合表候选的行数量级对比
- `analysis/_perf_probe3_1015.py`：设备数/launches 一致性、索引体检
- `analysis/_perf_probe4_1015.py`：复刻老算法 vs 聚合表的逐日对账（§2.5 的表）
- `analysis/_perf_probe5_1015.py`：各窗口下候选查询规模
- `analysis/_perf_probe6_1015.py`：现有报表 SQL 的索引使用总览
- `analysis/verify_query_rewrite_1015.py`：**改动后**的新旧数字对照（回填 -> 断言设备数/留存键一致 -> 量化口径差异 -> 打印新查询的执行计划）
- `analysis/_dryrun_backfill_1015.py`：在空表上试跑生成的回填 SQL（验证可执行 + 幂等）

---

## 8. 实施记录（2026-10-15）

### 8.1 已落地的改动

| 项 | 文件 | 做法 |
|---|---|---|
| P0-1 Q2 | `src/services/trial.ts` | 去掉列上的 `lower(install_id)`，改成 `inArray(installId, [原词, 小写, 大写])` 的索引等值查找；全表索引扫描（23 万行/次）→ 3 次索引探测 |
| P0-2 Q3 | `src/services/telemetry.ts` | `loadInstallations()` 新增可选 `window`，三个报表调用点把时间窗下推到 SQL；按 install_id 查首次安装的明细页刻意不带窗口，保持原语义 |
| P1-1 | `src/services/telemetry.ts` | `DEVICE_ACTIVITY_EVENTS` 提为入库/报表共用的单一常量；入库新增 `install_active` 日唯一标记；`machine_active`/`session_seen`/`install_active` 合并为**一条**多值 `INSERT ... ON CONFLICT DO NOTHING`（净语句数比改动前还少） |
| P1-2 | `src/services/telemetry.ts` | 留存页改读 `install_active` + 窗口化的 install_seen；覆盖不足时回退原始算法 |
| P1-3 | `src/services/telemetry.ts` | 活跃设备列表页：设备数读 `install_active`，启动数/活跃时长读 `telemetry_daily_metrics` |
| P1-5 | `src/services/telemetry.ts` | 日唯一标记写入失败重试一次（只有这一段是幂等的；增量累计的 metrics/session_state 刻意不重试，避免重复计数） |
| P1-6 | `src/services/telemetry.ts` + `src/routes/admin_ui.ts` | 安装详情页：时间窗（默认 30 天，可选 7/30/90/全历史）、筛选与分页全下推到 SQL、摘要拆成聚合查询 + 只读时长/surface 事件的 payload |
| 回填工具 | `scripts/backfill_install_active.ts` | 从本地快照生成幂等 INSERT 文件（本次 5,589 行 / 19 条语句），并打印线上缺口与新覆盖核对命令 |

### 8.2 本地快照对照结果（`analysis/verify_query_rewrite_1015.py`）

```
30 天窗口：设备数逐日 0 处不一致；留存键完全一致
90 天窗口：设备数逐日 0 处不一致
最近 7 天：launches 差异 ≤0.5%，activeSecs 差异 ≤0.2%
历史少数日期（9 月中旬）：activeSecs 最多 12.8%、launches 最多 14.0%（见 8.3）
```

回填脚本自检：5,589 行、覆盖 `2026-06-17 .. 2026-10-08`、重复执行 0 新增（幂等）；在空表上试跑通过。

### 8.3 需要知情的口径变化（用户已选方案 A）

活跃设备列表页的 `active_secs` / `launches` 从"原始事件重放"改为"入库时累计的 `telemetry_daily_metrics`"：

- **最近日期几乎无感**：10-07 launches 291→290（-0.34%）、activeSecs 差异 +0.06%；10-05/10-04 完全一致。
- **历史少数日期会有可见变化**：9 月中旬有几天聚合值偏低（9-19 launches 207→187、9-18 activeSecs -12.8%），根因是 `telemetry_daily_metrics` 在早期的非原子 upsert 竞态（`docs/d1-usage-investigation.md §4.3`）以及至今仍存在约 0.2% 的聚合写入丢失（10-07 原始 7,569 条 vs 聚合 7,551 条）。
- **换来的是一致性**：「设备总览」页本来就是读这两张聚合表，改完之后两个页面终于不会再各说各话。
- 如果希望历史数字保持原样，可改回方案 B（只读 5 种时长事件，30 天 55.8K 行）——代价是本页读额度从约 3.5K 回到约 60K。

### 8.4 上线顺序与回滚

1. **先回填、再部署**（或先部署也行：覆盖检查会让页面自动回退到原始算法，只是那段时间读额度不降）。
   ```bash
   # 快照区间（≤ 2026-10-08，5,589 行，只增不改）
   npx wrangler d1 execute animate-licence-db --remote --file analysis/install_active_backfill.sql
   # 快照之后到今天，逐天 INSERT ... SELECT（每天约读几千行）
   # 命令由 scripts/backfill_install_active.ts 输出
   # 核对覆盖（应等于或晚于昨天）
   npx wrangler d1 execute animate-licence-db --remote --command \
     "SELECT MIN(day), MAX(day), COUNT(*) FROM telemetry_daily_uniques WHERE unique_type='install_active'"
   ```
2. 部署代码；打开活跃设备/留存/安装详情三页，与截图逐格比对。
3. 回到 D1 Query Insights，确认 Q1/Q2 的行数掉下来。
4. 回滚：读路径 `git revert`；`install_active` 行可以留着（没有页面依赖它之外的语义），要清理也只是
   `DELETE FROM telemetry_daily_uniques WHERE unique_type='install_active'`（可选，不影响其它类型）。

### 8.5 顺手发现、但**没有**改的两件事

1. ~~**时长事件口径不统一**~~ → **已解决（2026-10-16，详见 §9）**。深入排查后发现不是三套而是**四套**口径（设备总览的「机器用量」表只认 `heartbeat/end`），且真正造成数字偏差的是机器用量表的 **−4.5%**；已统一到 4 种时长事件，并补上口径合同测试与探针。
2. **聚合表仍约 0.2% 丢数**：原始事件与 `telemetry_daily_metrics.events` 每天差 0.1%~0.3%（历史竞态期差 5%~12%）。现在报表越来越依赖聚合表，建议单独排一个"聚合写入完整性"的排查（例如给 metrics 增量也做可重试的幂等化，或加每日对账告警）。本次只给"幂等的日唯一标记"加了重试，没有动增量计数。

### 8.6 上线记录（2026-10-16 执行完毕）

| 步骤 | 结果 |
|---|---|
| 线上回填 · 快照区间 | `--file analysis/install_active_backfill.sql`：`success=true`，rows_written 16,767，新增 5,589 行 |
| 线上回填 · 缺口（2026-10-09 .. 10-16） | `--file analysis/install_active_backfill_gap.sql`：新增 1,553 行，一次性读 95,350 行 |
| 覆盖核对 | `install_active` 7,141 行，`2026-06-17 .. 2026-10-16`；`install_seen` 2,514 / `machine_active` 6,985 / `session_seen` 16,785 均未受影响 |
| 迁移状态 | `wrangler d1 migrations list --remote` → No migrations to apply（0016 早已生效） |
| 部署 | `npm run deploy` → Version ID `c75a3ab0-a11a-462c-968e-74ca52147cc8` |
| 线上冒烟 | `https://admin.licence.getanimate.app/admin/login` → 200 且返回登录表单（workers.dev 域名按 host_routing 规则返回 404，属预期） |
| 入库路径实证 | 部署前当天（10-16）`install_active` 82 行，部署后 84 行 —— 新增行只可能由**线上入库代码**写入，P1-1 在产线生效 |
| 新数据源核对 | 最近 7 天：10-15 = 264 台 / 427 启动 / 4,408,055 秒；10-14 = 253 / 414 / 3,915,040（量级与历史一致） |

**待办（未做）**：
- 观察 24 小时后的 D1 Query Insights，确认 Q1/Q2 行数下降、`rowsRead/天` 回落。

---

## 9. 时长口径统一（2026-10-16，已完成并上线）

### 9.1 排查结论：不是三套口径，是四套

| 消费方 | 事件集 | 影响面 |
|---|---|---|
| 入库聚合 `updateSessionState` | heartbeat, checkpoint, end, unclean_end（**4**） | `telemetry_daily_metrics.active_secs`（设备总览卡片/每日趋势）、`session_state` |
| 活跃设备 / 留存 / 用户总览 | + `session_unclean_detected`（**5**） | 活跃设备页、留存页、用户总览、用户详情 |
| 安装详情 / 某日 lifetime | heartbeat, checkpoint, end, unclean_end（**4**） | 安装详情页、活跃设备-某日 |
| **`getTelemetryMachineUsage`** | heartbeat, end（**3**） | **设备总览页的「设备使用明细」表** |

### 9.2 实测：真正的偏差在机器用量表，不在那个第 5 种事件

- `session_unclean_detected` **从未被任何客户端上报**：本地快照 0 行、线上库 0 行（事件 2026-08-18 加入白名单至今两个月）。
- 线上全库"带时长字段"的事件恰好只有 4 种；最近 3 天：heartbeat 6,322 / checkpoint 2,069 / end 611 / unclean_end 96。
- 逐字复刻三种算法，最近 30 天：
  - 5 事件 vs 4 事件：**0.0000%**（54,614,877 完全相同）；
  - 3 事件 vs 4 事件：**−4.50%**（52,263,981 vs 54,614,877）。
- 机制：时长是按会话单调增量累计的，跳过中间事件不丢数，**只有会话最后一个时长事件会被漏掉**。6,514 个会话里 1,857 个（28.5%）的最后一个时长事件是 checkpoint(794) 或 unclean_end(1,063)。
- 后果：设备总览页顶部卡片（metrics，4 口径）与下面「设备使用明细」表（3 口径）**在同一屏上对不上**，两者相差约 4.5%。

### 9.3 决定与实施

**统一到 4 种时长事件**，`session_unclean_detected` 明确不算时长（它只留在 `DEVICE_ACTIVITY_EVENTS` 里管"当天是否活跃"）。理由：

1. 与真实数据一致——带时长字段的事件就是这 4 种；
2. 对 5→4 而言零数字变化，同时修掉机器用量表 4.5% 的低估；
3. `session_unclean_detected` 的 `session_id` 归属与 payload 语义都没有客户端契约可查，现在把它列进时长口径等于把一个无法证伪的假设写进入库与全部报表；等它真的带时长出现，再改常量 + 测试即可；
4. 与 `docs/telemetry-server-design.md`（"heartbeat/end 的 `process_duration_secs` 增量加到 `active_secs`"）一致。

改动：

- 新增单一导出常量 `SESSION_DURATION_EVENTS`（4），替换 6 处内联数组：入库、机器用量（3→4，`session_start` 只留作计启动数）、安装详情（删掉重复常量）、用户总览（5→4）、活跃设备/留存、某日 lifetime。
- 探针：`updateAggregates` 里若收到**带时长字段**的 `session_unclean_detected`，每个 isolate 打一条 `console.warn`（`telemetry: session_unclean_detected arrived with duration fields; re-evaluate SESSION_DURATION_EVENTS`），提示重新评估口径。
- 测试（`tests/telemetry.test.ts`）：新增「口径合同」用例——构造三个会话（以 checkpoint 收尾 / 以 unclean_end 收尾 / 干净退出），断言入库 metrics、活跃设备、机器用量、用户总览、安装详情**五个消费方都得到 2700 秒**；新增「unclean_detected 不算时长 + 探针告警一次」用例。旧口径下第一个用例会失败（三事件口径只算出 1500）。

### 9.4 线上结果

| 项 | 结果 |
|---|---|
| 测试 | `tsc` 干净；`vitest run` → **19 文件 / 243 用例全绿**（新增 2 个） |
| 部署 | `npm run deploy` → Version ID `660a1078-67ef-486a-ada3-ef4bca3b5a2a` |
| 冒烟 | `admin.licence.getanimate.app/admin/login` → 200 + 登录表单 |
| 数据影响 | 零 schema、零数据迁移；**唯一可见变化：设备总览「设备使用明细」表的运行时长/Overlay 时长上升约 4.5%**（把之前丢掉的 checkpoint / unclean_end 尾巴算回来），其它页面数字不变 |

### 9.5 后续观察点

- 若某天 Worker 日志出现上面那条 warn，说明客户端开始上报带时长的 `session_unclean_detected`：先看它的 `session_id` 指向崩溃会话还是新会话、payload 是否带时长，再决定是否把它并入 `SESSION_DURATION_EVENTS`（入库与报表同时改，并更新 §9.3 的两个用例）。
- 机器用量/用户总览页仍是"全窗口原始事件扫描"（14 天约 74.7K 行/次）；要再降读额度需要"每机器每日聚合表"，与 §3.3 的方案 C 同类，暂不在本次范围。



