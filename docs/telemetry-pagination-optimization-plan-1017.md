# 后台页面分页 / 查询优化方案（2026-10-17）

> 状态：**P0 已实施（本地通过 tsc + 247 个测试），尚未部署、尚未对线上执行任何写操作**
> 实施记录与逐项实测见 §9；P1 / P2 仍待排期。
> 上一轮：`docs/telemetry-query-optimization-plan.md`（2026-10-15 方案，P0+P1 已上线，见其 §8/§9）
> 本轮触发：D1 Query Insights 截图（2026-10-17）里仍有 4 条查询吃掉 41% 的数据库执行时间，
> 其中一条 P50 3.0 秒、单页浏览读 15.9 万行。
> 证据来源：`analysis/_verify_rewrite.db`（2026-10-08 全库快照 + install_active 回填，234,963 事件）
> 探针脚本（全部只读，随本文档一起提交）：
> `analysis/_perf_probe_1017.py`（逐条查询的 plan / 行数 / 耗时 / session_state 对账）、
> `analysis/_perf_probe2_1017.py`（各页面单次浏览读行数）、
> `analysis/_perf_probe3_1017.py`（UPDATE 的索引维护 opcode）、
> `analysis/_perf_probe3b_1017.py`（写放大 journal 字节对照）、
> `analysis/_perf_probe4_1017.py`（session_state 与回放算法的逐台偏差）、
> `analysis/_perf_probe5_1017.py`（17 列真实查询的 plan）、
> `analysis/_perf_probe6_1017.py`（不同时间窗下单台设备的成本）、
> `analysis/_perf_probe7_1017.py`（收窄 install_id 后是否退化成全历史扫描 + 原始事件页等值计划）、
> `analysis/_verify_migration_1017.py`（migration 0017 幂等性 + 新索引被选中）、
> `analysis/_tmp_check.py`（单个 install 的偏差归因）

---

## 0. 结论摘要

截图里按耗时排前 5 的读查询，逐条对到了代码：

| # | 截图占比 / P50 | 归属页面 | 代码 | 真实原因 | 本轮建议 |
|---|---|---|---|---|---|
| Q1 | **25.32% / 3,001 ms** | 活跃设备-某日 `/admin/telemetry/activity/:day` | `loadLifetimeUsageByInstall` | 为渲染 25 行的「历史累计时长」，把**该产品全历史**的 4 种时长事件（11.4 万行）扫一遍，`install_id IN (25)` 是扫描**之后**才过滤 | 改读 `telemetry_session_state` 聚合 + 1 个索引（**15.9 万行 → ~500 行**） |
| Q2 | **12.09% / 652 ms** | 新增安装 `/admin/telemetry/installs` | `loadNewInstallationActions` | 索引没问题，但 SELECT **17 列含 payload_json**、把 2,183 行搬回 Worker 再在 JS 里按「首次安装当天」过滤 | 只取 2 列 + 日明细页按 install_id 收窄（**2,183 行 → 46 行**）+ 加报表缓存 |
| Q3 | 1.30% / 266 ms | 同上（另一窗口） | 同上 | 同上 | 同上 |
| Q4 | 2.31% / 236 ms | 活跃设备 / 留存 | `seedSessionDurations` | 只读一天、索引正常，但**为了给跨天会话做基线，仍要重放当天 4 种时长事件**（667~3,962 行/天） | 本轮保留；结构性方案（§4 P2）可彻底去掉 |
| Q5 | 0.16% / 65.9 ms | 活跃设备列表 | `install_active` 按天计数 | 主键是 `(day, product_id, unique_type, unique_value)`，过滤条件在**第 2、3 列**，只能扫整段日期的**全部 4 种** unique 行（30 天 1.96 万行） | 可选：加 `(product_id, unique_type, day)` 覆盖索引（**1.96 万 → 2.6 千行**） |
| Q7 | 2.87% / 31.6 ms | 试用资格检查（catalog / LLM 试用） | `catalog.ts:239`、`llm_trial.ts:291` | `fingerprint_hash IN (?,?) AND status=?`，**没有任何以 fingerprint_hash 打头的索引** → `SCAN trial_grants`（2,107 行/次） | 加 1 个索引（**2,107 行 → ~2 行**） |

**截图之外，还有 4 个页面的单次浏览比截图里任何一条都贵**（只是这两天没人点）：

| 页面 | 路由 | 一次浏览的读行数 | 现状 |
|---|---|---|---|
| 用户总览 | `/admin/telemetry/users` | **扫 23.5 万行 / 返回 15.6 万行**（30 天） | 全量拉进 Worker 再 `GROUP BY` + `slice(50)` |
| 行为漏斗 | `/admin/telemetry/products` | 8.1 万行（14 天） | 同上，且必须带 payload |
| 设备总览 · 机器用量 | `/admin/telemetry/usage` | 6.4 万行（30 天） | 同上，最后 `slice(200)` |
| 用户详细行为 | `/admin/telemetry/user/:hash` | **3.0 万行**（单台最活跃机器，全历史、无窗口、无 LIMIT） | 全量取回再 `slice(100)` |

---

## 1. 逐条证据（本地快照实测，不是推测）

### 1.1 Q1：为 25 行付出 15.9 万行

```
SQL:  SELECT <17 列> FROM telemetry_events
      WHERE product_id=? AND event IN (5 种时长事件) AND install_id IN (25 个)
      ORDER BY received_at
PLAN: SEARCH telemetry_events USING INDEX telemetry_events_product_event_idx (product_id=? AND event=?)
      USE TEMP B-TREE FOR ORDER BY
```

关键事实：

- 规划器选的是 `product_id + event` 两个等值前缀（5 段扫描），**`install_id IN (…)` 完全没有进索引**，
  它是扫描之后的行过滤。`telemetry_events_install_idx (install_id, received_at)` 明明存在，
  但 25 段探测 + 排序的成本估算输给了 5 段探测。
- 扫描规模 = 该产品**全部历史**的 4 种时长事件：
  2026-10-08 快照 **113,992 行**；到 2026-10-17 已涨到 **约 15.9 万行**
  （截图：478.09k 行 ÷ 3 次浏览 = 159k，与按天增长曲线吻合）。
- 每次实际返回给 Worker 的行：**7,111 ~ 17,580 行**（取决于这一页 25 台的活跃程度），
  本地读一次 267~329 ms，D1 上 P50 3,001 ms。
- 代码语义：`loadLifetimeUsageByInstall()` 对每行 `JSON.parse(payload)`，按会话取「相对上一次报值的增量」
  再累加到 install。**这个量在入库时已经算过一遍**（`updateSessionState` 算 delta 写进
  `telemetry_daily_metrics.active_secs` 和 `telemetry_session_state`）。

即：**页面在重复计算四个月前就算好的东西**。

**替代数据源（`telemetry_session_state`）的准确性实测**（2026-10-08 当天 75 台活跃设备）：

```
replay 合计 25,003,745 s   session_state 合计 24,848,329 s   delta = -0.622%
逐台 delta：中位数 0.00%，p05 -2.92%，最小 -4.85%；74 台里 66 台完全相同，8 台偏差 >1%
```

偏差原因不是新问题，两个机制叠加：

1. `updateSessionState` 的 CAS 在并发下会放弃一次更新（`docs/d1-usage-investigation.md §4.3` /
   上一轮方案 §8.5 记录的「聚合仍约 0.2% 丢数」），丢的正是「最后一格」增量；
2. 乱序到达时 `last_*_duration_secs` 会被较小值回写（该列是「最后一次报值」，不是 MAX；
   只有 `upsertSessionState` 那条分支用了 MAX）——快照实测 11,755 个会话里 270 个出现过 1~3 次回退。

两者都让 session_state **偏低**，不会虚高。

### 1.2 Q2/Q3：索引是好的，读的是「用不上的列」

```
PLAN: SEARCH ... USING INDEX telemetry_events_product_event_idx (product_id=? AND event=? AND received_at>? AND received_at<?)
行数：30 天 2,183 行 / 单日 46 行
```

索引范围已经精确到「3 种事件 × 时间窗」，**没有扫错行**。贵在两处：

1. `select` 了 `EVENT_LIST_COLUMNS`（17 列，含 `payload_json`），而代码只用到 `install_id` 和 `event`；
2. 代码要的是「新装当天发生过这些行为」，却把「当天」的判断放在 JS 里（`installationDayById.get(...) !== receivedAt.slice(0,10)`）。

按截图 36.25k 行 ÷ 10 次 = 3.6k 行/次，对应 60~90 天窗口（30 天 2,183 行）。

### 1.3 Q5：主键顺序与过滤条件不匹配

```
SQL:  SELECT day, COUNT(*) FROM telemetry_daily_uniques
      WHERE product_id=? AND unique_type=? AND day>=? AND day<=? GROUP BY day
PLAN: SEARCH ... USING COVERING INDEX sqlite_autoindex_telemetry_daily_uniques_1 (day>? AND day<?)
```

`day` 是主键第一列，能定位到日期区间；但 `product_id` / `unique_type` 在第 2、3 列，
所以区间内**四种 unique 行全要读一遍再过滤** —— 30 天 1.96 万行只为了产出 30 个数字
（截图 `读取行数/返回行数 = 652`，19.56k ÷ 30 ≈ 652，完全对上）。

### 1.4 Q7：缺一个索引，`SCAN` 全表

```
SQL:  SELECT valid_until FROM trial_grants WHERE fingerprint_hash IN (?, ?) AND status = ?
PLAN: SCAN trial_grants
```

`trial_grants` 现有两个索引：`(product_id, feature, fingerprint_hash)` 唯一索引、
`(product_id, fingerprint_hash)`。这两个查询**都不带 `product_id`**，所以一个都用不上。
截图 82.2k ÷ 39 次 = 2,107 行/次，正是 `trial_grants` 当前行数（快照 1,801 行，线上已涨到约 2,107）。

调用点两处，都是「这台机器有没有有效试用」的产品前置判断：
`src/services/catalog.ts:239`、`src/services/llm_trial.ts:291`。

### 1.5 截图之外的四个页面（JS 分页）

| 页面 | PLAN | 一次浏览读 |
|---|---|---|
| 用户总览 30 天 | `SEARCH product_event_idx (product_id=?)` + TEMP B-TREE | 扫 234,963（整个产品历史），返回 15.6 万行 |
| 行为漏斗 14 天 | `SEARCH product_event_idx (product_id=? AND event=? AND received_at>?)` | 8.1 万行 |
| 机器用量 30 天 | 同上 | 6.4 万行，最后 `slice(200)` |
| 用户详情（最活跃机器） | `SEARCH machine_idx (machine_hash=?)` | 3.0 万行，最后 `slice(100)` |

注意「用户总览」这条：`WHERE product_id=? AND received_at>=?` 在 `(product_id, event, received_at)`
索引上**只能用到 `product_id` 前缀**，时间窗完全不参与索引定位 —— 也就是说
「看 7 天」和「看 90 天」扫的行数差不多（都是整个产品历史）。这是目前**单次浏览读额度最高**的页面。

### 1.6 写入侧（截图里那两条 INSERT / UPSERT）

这两条不是分页问题，量级如下（快照实测）：

- `INSERT INTO telemetry_events`：每条事件写 **1 行数据 + 5 个索引项**
  （`event_id` 文本主键的 autoindex、`received_idx`、`product_event_idx`、`machine_idx`、`install_idx`；0016 已删掉 session 索引）≈ **6 行/事件**。
- `INSERT INTO telemetry_daily_metrics … ON CONFLICT DO UPDATE`：1 行/事件。
- `telemetry_daily_uniques` 多值 `INSERT … DO NOTHING`：2~3 行/事件。
- 合计约 **10~11 行写/事件**；高峰日 7.9k 事件 ≈ 8 万行写（免费版 100k/天）。

本轮**不新增任何 `telemetry_events` 索引**（上一轮 §2.6 的结论仍然成立：4 个二级索引都在用，
且每加 1 个就是每条事件 +1 行写）。本轮唯一的新索引都加在「低频写」的表上（见 §3）。

---

## 2. 根因归纳：只有四种，且都指向同一个原则

1. **把「一页 25 行」写成「全历史重算」**（Q1、Q4）——没有可用的累计表，只能回放原始事件。
2. **把「本页需要的 50 行」写成「窗口内全部行」**（Q2、Q3、用户总览、行为漏斗、机器用量、用户详情）——
   `SELECT` 全列 + 全量拉回 + JS 里 `filter/sort/slice`。
3. **索引顺序与过滤条件不匹配**（Q5、Q7）——列都在，但不在索引的**前缀**上。
4. **入库时算过的值，查询时再算一遍**（Q1 与 `telemetry_daily_metrics` 的关系）。

> ⚠️ 一个必须说清的事实：**D1 按 `rows_read` 计费，SQL 侧聚合/分页不会减少「读行数」，只减少
> 传输字节、Worker 内存和耗时。** 要真正减少读额度，只能换数据源（预聚合）。所以本方案分成两层：
> - **P0/P1：只修「读了一堆用不上的行」和「该走索引却没走」** → 同时降耗时和读额度；
> - **P2：预聚合表** → 把「本来就该读这么多」的部分也降下来（最后一节，本轮先不实施）。

---

## 3. P0 / P1：本轮要做的改动（逐项到函数、到 SQL、到预期数字）

### P0-1　`trial_grants` 补一个索引（10 分钟，风险接近 0）

**migration `0017_trial_grants_fingerprint_status.sql`**

```sql
-- 两个产品前置校验（catalog 资格 / 试用 LLM 签发）只按 fingerprint_hash + status 查，
-- 现有两个索引都以 product_id 打头，用不上 → 每次 SCAN 全表（2,107 行）。
-- trial_grants 的写入只发生在「发放试用 / 状态转 expired」，日增几十行，索引维护成本可忽略。
CREATE INDEX `trial_grants_fingerprint_status_idx`
  ON `trial_grants` (`fingerprint_hash`, `status`);
```

同步三处（否则 `db:generate` 会把索引当漂移处理）：

- `src/db/schema.ts` → `trialGrants` 的索引声明加 `fingerprintStatusIdx`
- `tests/helpers/setup.ts` → `CREATE INDEX IF NOT EXISTS …`
- 查询代码**一行不改**（`inArray(fingerprintHash, hashes) + status='active'` 天然命中）

预期：2,107 行/次 → 2 次索引探测（≈2 行）；截图 82.2k 行/天 → <100 行/天。

### P0-2　活跃设备-某日：`lifetime` 改读 `telemetry_session_state`

**migration `0017` 同文件**

```sql
-- 活跃设备-某日页要 25 台的「历史累计时长」。现在回放全历史时长事件（15.9 万行/次）。
-- session_state 每个会话一行、已存该会话的累计 process/可见时长（正常单调递增＝最大值），
-- 按 install 求和即为累计值；乱序回写导致的偏低见方案文档 §1.1。
-- 注意：索引只含 install_id（不含 updated_at），心跳 UPDATE 不改这一列 → 无写放大（见 §5 实测）。
CREATE INDEX `telemetry_session_state_install_idx`
  ON `telemetry_session_state` (`install_id`);
```

**`src/services/telemetry.ts` → 重写 `loadLifetimeUsageByInstall()`**（签名不变，调用点不用改）

```sql
SELECT install_id,
       SUM(last_process_duration_secs)  AS active_secs,
       SUM(last_overlay_visible_secs)   AS overlay_visible_secs
FROM telemetry_session_state
WHERE install_id IN (?, ?, …)          -- 只有当前这一页的 25 个
GROUP BY install_id
```

- 删除 3 个 helper 依赖（`SESSION_DURATION_EVENTS` 的 JSON 解析、`sessionVisibleSecs`、`boundedDelta`）
  在这个函数里的使用；`EVENT_LIST_COLUMNS` 的 17 列读取一并消失。
- 预期：15.9 万行 / 267~329 ms / P50 3,001 ms → **约 500 行 / <10 ms**。
- **口径变化（需你确认）**：历史累计时长比现在低 0.622%（当天 75 台合计），
  单台最多低 4.85%；原因是入库 CAS 丢更新 + 乱序回写（见 §1.1），不是本改动引入的。
  这与上一轮 §8.3 你已选的「方案 A：改读入库累计值」是同一个方向。
- 回滚：删索引、`git revert` 这个函数即可（数据零改动）。

### P0-3　用户详细行为页：窗口 + SQL 分页

**`getTelemetryMachineDetail()`**（`src/services/telemetry.ts:1677`，当前无窗口、无 LIMIT）

- 新增 `days?: number | "all"`（默认 30，与安装详情页一致，UI 加时间窗下拉）
- 新增 `event` / `sessionId` 下推到 SQL（当前是取回后 JS 过滤）
- `ORDER BY COALESCE(sent_at, received_at_unix), received_at LIMIT ? OFFSET ?`
- `total` 用 `count(*)` 单独查（带同样条件）
- 摘要（`user`）：不再调 `listTelemetryUsers({q: machineHash})`（那是 23.5 万行的全量扫描），
  改成同一条件的单机聚合（`MIN/MAX(received_at)`、`COUNT(*)`、`SUM(event='session_start')`、
  `COUNT(DISTINCT session_id)`、`GROUP_CONCAT(DISTINCT license_state)`）

预期：最活跃那台 30,362 行 → **100 行/页**（30 天窗口下总行数也降到几千）。

### P0-4　新增安装：只取 2 列 + 日明细页按 install_id 收窄 + 加缓存

**`loadNewInstallationActions()`**（`src/services/telemetry.ts:1809`）

1. 列裁剪：`select({ installId, event })`，不再取 `payload_json` / 其余 15 列。
2. 当 `installationDayById.size <= 90`（日明细页通常 30~55 个）时，把 `inArray(installId, ids)` 下推：
   - 命中 `(install_id, received_at)` 索引，46 行/次；
   - 30 天报表页（约 1,000 台）超过参数上限（D1 规定单语句最多 100 个绑定参数，见
     [Limits · D1](https://developers.cloudflare.com/d1/platform/limits/)），保持原范围只做列裁剪。
3. `getInstallationDays()` / `listInstallationsForDay()` 套 `cachedReport(...)`（5 分钟 TTL，与其它页一致）——
   现在这两页**完全没有缓存**，刷新一次就重读一次。

预期：截图 12.09% 的两条 → 传输字节降 ~95%；日明细页由「窗口内全部行为事件」收窄到当天 46 行；
30 天报表页仍读 2,183 行但只取 2 列；重复浏览命中 5 分钟缓存。

### P0-5　原始事件页：完整 hash 走等值

`listTelemetryEvents()` 现在对 `machine_hash` / `install_id` / `session_id` 一律用 `LIKE '%term%'`
（两侧通配，索引不可用，只能靠时间窗兜底）。

- 当输入是 64 位十六进制（machine_hash）或 UUID（install/session）时，改 `eq(...)`：
  `machine_idx` / `install_idx` 直接命中 —— 从「窗口内 ~1.5 万行逐行 LIKE 匹配」变成
  「1 次索引探测 + 该机器在窗口内的行」；
- 其余情况保持 `LIKE '%term%'`（语义不变）。

### P1-1　用户总览：SQL 聚合 + LIMIT/OFFSET（不再全量拉回）

**`listTelemetryUsersUncached()`**（`src/services/telemetry.ts:1576`）拆成 3 条小查询：

```sql
-- ① 这一页的机器（只返回 50 行）
SELECT machine_hash,
       MIN(received_at) AS first_seen, MAX(received_at) AS last_seen,
       MIN(CASE WHEN event='install_seen' THEN received_at END) AS first_install_at,
       SUM(CASE WHEN event='install_seen' THEN 1 ELSE 0 END) AS installs,
       SUM(CASE WHEN event='session_start' THEN 1 ELSE 0 END) AS launches,
       COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events,
       GROUP_CONCAT(DISTINCT license_state) AS license_states
FROM telemetry_events
WHERE product_id=? AND received_at>=? AND machine_hash IS NOT NULL
  [AND machine_hash LIKE ?]                       -- 搜索下推
GROUP BY machine_hash
HAVING MAX(received_at) >= ?                      -- status 过滤下推
ORDER BY MAX(received_at) DESC                    -- 或 MIN(received_at) / 时长列
LIMIT ? OFFSET ?
-- ② 这 50 台的「最后事件名」+ 最近一次会话时长（按 machine_hash 精确探测）
-- ③ 总数：SELECT COUNT(*) FROM (…①的 GROUP BY 子查询…)
```

- 时长列（`activeSecs` / `overlayVisibleSecs` / `recentSessionSecs`）从 `telemetry_session_state`
  按 `machine_hash IN (…50)` 聚合 —— 为此**需要** `telemetry_session_state (machine_hash)` 索引（同 P0-2，
  0016 删它的理由是「没有查询按 machine_hash 访问」，本轮开始有了；且心跳 UPDATE 不改这一列 → 无写放大）。
- 返回行数：15.6 万 → **50**。
- **诚实标注**：这条查询的 `rows_read` 仍约 15.6 万（`GROUP BY` 必须扫过窗口内的行），
  降的是传输、内存和耗时；要降 `rows_read` 必须等 P2 的日聚合表。

### P1-2　设备总览 · 机器用量：GROUP BY 下推 + 分页

`getTelemetryMachineUsage()`（`:1207`）当前取全窗口 5 种事件的 17 列（6.4 万行）在 JS 里聚合，
再 `slice(200)`。改成同 P1-1 的 `GROUP BY machine_hash` + `LIMIT/OFFSET`，
时长列同样来自 `session_state`。返回行数：6.4 万 → **200**（或 25/页）。

### P1-3　`install_active` 按天计数（可选，看写额度）

`telemetry_daily_uniques` 加 `(product_id, unique_type, day)`：

- 收益：1.96 万行 → 2.6 千行/次（30 天），活跃设备列表页与留存页都受益；
- 代价：`telemetry_daily_uniques` 是**每个事件都写**的表，多一个索引 = 每次插入 +1 个索引项
  （约 2k~8k 行/天）。与「省下的读」相比不一定划算，**建议先不做**，等 P2 的日聚合表替代它。

### 改动文件清单（P0 + P1）

| 文件 | 改动 |
|---|---|
| `migrations/0017_*.sql`（新增） | 2 个索引：`trial_grants(fingerprint_hash, status)`、`telemetry_session_state(install_id)`、（P1-1 若做）+`(machine_hash)` |
| `src/db/schema.ts` | 同步索引声明（3 处） |
| `tests/helpers/setup.ts` | 同步 `CREATE INDEX`（3 处） |
| `src/services/telemetry.ts` | `loadLifetimeUsageByInstall` 重写；`getTelemetryMachineDetail` 窗口/分页；`loadNewInstallationActions` 列裁剪+收窄；`listTelemetryEvents` 精确匹配快路径；`getInstallationDays`/`listInstallationsForDay` 加缓存；（P1）`listTelemetryUsersUncached`/`getTelemetryMachineUsage` 聚合下推 |
| `src/routes/admin_ui.ts` | 用户详情页加「时间窗」下拉；用户总览/机器用量分页组件复用 `devicePagination` |
| `tests/telemetry.test.ts` 等 | 新增/更新用例（见 §6） |

---

## 4. P2（下一阶段，单独排期）：日聚合表

上面 P1 里两条「`rows_read` 降不下来」的页面（用户总览 15.6 万、机器用量 6.4 万），
加上 Q4 的 `seedSessionDurations`（0.7k~4k/天）和 Q1 的日明细回放，根因是同一个：
**没有「每天 × 每台 install」的聚合行，所以只能回放原始事件。**

建议新增 `telemetry_install_daily`（PK `(day, install_id)`，列含 machine_hash / 维度 / launches /
sessions / active_secs / overlay_visible_secs / 三个行为标记 / first_active_at / last_active_at），
在入库时随事件 UPSERT，并**替代** `install_active` 这一类 unique 标记（净写入 ≈ 0）。

它能一次性替掉：

| 现在 | 换成 |
|---|---|
| 活跃设备-某日：回放当天原始事件（667~3,962 行） | `WHERE day=? ORDER BY active_secs DESC LIMIT 25`（~130 行） |
| 活跃设备列表：`install_active` 计数（1.96 万行） | `GROUP BY day`（3.9 千行） |
| 留存分析 | `day + install_id` 集合（3.4 千行） |
| 新增安装的行为标记（2,183 行） | 三个布尔列，0 行额外扫描 |
| 用户总览 / 机器用量（15.6 万 / 6.4 万） | `GROUP BY machine_hash`（~3.9 千行） |
| `loadLifetimeUsageByInstall`（15.9 万） | `SUM(active_secs) WHERE install_id IN (25)`（25 行） |

代价：入库每条事件多 1 行写（同时少 1 行 `install_active`），需要一次性回填（只增不改）。
这是「读额度归零」的唯一彻底解法，但改动面比本轮大一个量级，建议本轮先做 P0/P1、观察一周再定。

---

## 5. 写放大实测（决定「能不能加索引」）

上一轮 `0016` 删索引的理由是「心跳每次 UPDATE 都会改 `updated_at`，索引项要删+重插」。
本轮要加的索引用的是 `install_id` / `machine_hash`，**心跳 UPDATE 不改这两列**。实测（临时库，2000 行，500 次心跳 UPDATE）：

```
EXPLAIN UPDATE 的 opcode：两种表都没有 IdxInsert / IdxDelete（只有 Insert 写表行）
rollback journal 字节：无索引 37,448　有安装索引 37,448　→ 完全一致
```

结论：**这两个索引对心跳路径零写放大**；只在 INSERT 新会话行时多写 1 个索引项（≤ 90 行/天）。

---

## 6. 验证计划（每步可执行）

1. **快照对账**（改动前先跑）：用 `analysis/_perf_probe_1017.py` / `_perf_probe4_1017.py`
   对 7/30/90 天窗口比较新旧 lifetime 数字，输出逐台 delta 分布（预期：中位数 0，总量 -0.6%）。
2. **EXPLAIN 逐条对比**：沿用 `analysis/verify_index_migration.py` 的做法，
   对 §3 涉及的每条 SQL 在迁移前后各跑一次 `EXPLAIN QUERY PLAN` 并逐字 diff，确保没有计划退化。
3. **单元/集成**：`npm test`；重点用例
   - `getTelemetryInstallDetail`（已有口径合同用例）
   - 新增：`listActiveDevicesForDay` 的 lifetime 与 `session_state` 一致（构造 3 个会话）
   - 新增：`getTelemetryMachineDetail` 分页边界（第 1 页 / 末页 / 空页 / `days=all`）
   - 新增：`listTelemetryUsers` 聚合结果与旧 JS 实现在同一份种子数据上逐字段相等
   - 新增：`trial_grants` 查询计划用上新索引（`EXPLAIN QUERY PLAN` 断言含索引名）
4. **本地端到端**：`npm run db:migrate:local` + `npm run dev`，逐页对比改动前后截图。
5. **上线顺序**：先 `wrangler d1 migrations apply`（0017 只建索引，不阻塞读写），再部署代码；
   观察 24h 后回 Query Insights 确认 Q1/Q7 的行数与耗时下降。

---

## 7. 风险与回滚

| 改动 | 风险 | 回滚 |
|---|---|---|
| 0017 建索引 | D1 建索引会短暂锁表（`trial_grants` 约 2.1k 行、`session_state` 约 1.2 万行，秒级） | `DROP INDEX` |
| lifetime 换源 | 数字 −0.6%（口径变化，需在页面加说明） | `git revert` 函数 |
| 用户详情窗口化 | 默认 30 天可能看不到更早事件（提供 `days=all`） | 参数默认值改回 all |
| 用户总览聚合下推 | 与旧 JS 实现有边界差异（如 `licenseStates` 顺序、`status` 边界） | `git revert` |
| 缓存 TTL | 数据延迟最多 5 分钟（与其它页一致） | 调 TTL 或关缓存 |

**不做的事**：不删遥测数据、不改历史聚合值、不动 `raw_json`、不新增 `telemetry_events` 索引、不改统计口径（UTC）。

---

## 8. 需要你拍板的三件事

> **已拍板（2026-10-17）**：lifetime 选 **A**（改读 `session_state`）；本轮按 P0 实施，
> 并额外修了兑换码页（N+1）、试用页与日志页（JS 分页）；P1 / P2 待观察一周后再定。
> 实施记录见 §9。

1. **lifetime 口径**：接受「改读 `session_state`，历史累计低约 0.6%（单台最多 −4.85%）」吗？
   - A（推荐）：接受，本轮就换（1 个索引 + 30 行代码，15.9 万行 → 500 行）；
   - B：要数字一模一样 → 需要建「每 install 累计表」并在入库时累加 + 回填（多一次写/时长事件），
     工作量约等于 P2 的一半，可以并入 P2 一起做；
   - C：都不改，只加 5 分钟缓存（首屏仍 3 秒、仍读 15.9 万行）。
2. **本轮范围**：只做 P0（5 项，纯读路径 + 2 个索引，1~2 天），还是连 P1（用户总览/机器用量聚合下推）一起做？
3. **P2 日聚合表**：现在排期，还是等 P0/P1 上线观察一周后的 Query Insights 再决定？

---

## 9. 实施记录（2026-10-17，P0 + 两个额外页面）

### 9.1 已落地的改动

| 项 | 文件 | 做法 |
|---|---|---|
| P0-1 试用资格索引 | `migrations/0017_telemetry_read_indexes.sql`、`src/db/schema.ts`、`tests/helpers/setup.ts` | 新增 `trial_grants(fingerprint_hash, status)`；查询代码一行未改，计划从 `SCAN` 变成 2 次索引探测 |
| P0-2 lifetime 换源 | `src/services/telemetry.ts` `loadLifetimeUsageByInstall()` | 不再回放原始事件，改 `SUM(last_process_duration_secs / last_overlay_visible_secs) FROM telemetry_session_state GROUP BY install_id`；新增 `telemetry_session_state(install_id)` 索引 |
| P0-3 用户详情页 | `src/services/telemetry.ts` `getTelemetryMachineDetail()`、`src/routes/admin_ui.ts` | 新增 `days` 时间窗（默认 30 天，可选全历史）；`event` / `session_id` 过滤与 `LIMIT/OFFSET` 下推 SQL；摘要拆成「计数聚合 + 窗口内最近一行 + 只有 4 种时长事件带 payload」三条窄查询，不再调用 `listTelemetryUsers` |
| P0-4 新增安装 | `src/services/telemetry.ts` `loadNewInstallationActions()`、`getInstallationDays()`、`listInstallationsForDay()` | 只取 3 列（install_id / event / received_at，不再读 payload_json）；设备数 ≤90 时把 `install_id` 下推；两页补上 5 分钟报表缓存 |
| P0-5 原始事件搜索 | `src/services/telemetry.ts` `listTelemetryEvents()` + `idFilter()` | 完整 64 位 hash / UUID 走 `inArray` 等值（命中 machine_idx / install_idx），片段仍走 `LIKE '%…%'`；大小写不敏感保持不变 |
| 兑换码页 N+1 | `src/services/activation.ts` `listLicenses()` | 见 §9.2：整表 → `LIMIT/OFFSET + count(*)`；每行 3 条查询 → 整页 3 条批量查询 |
| 日志页 | `src/services/activation.ts` `listActivationLogs()`、admin_ui | 整表 → `LIMIT/OFFSET + count(*)`；页面补分页链接 |
| 试用页 | `src/services/trial.ts` `listTrialGrants()`、admin_ui | 无搜索时排序/分页/status 过滤下推 SQL；有搜索时保留原内存匹配；页面补分页链接 |
| 分页索引 | `migrations/0017` | `licenses(created_at)`、`trial_grants(created_at)`，让两个列表页只读当前页的索引项 |

### 9.2 为什么「打开兑换码页面」会耗时超级久

`listLicenses()` 原来是两步全表 + N+1：

```ts
const all = await db.select().from(licenses).orderBy(desc(licenses.createdAt)).all();  // 全部兑换码
for (const license of all) {
  await db.select().from(entitlements).where(eq(entitlements.id, license.entitlementId)).get();  // ①
  await db.select().from(plans).where(eq(plans.planId, entitlement.planId)).get();                // ②
  await db.select().from(products).where(eq(products.productId, entitlement.productId)).get();    // ③
}
```

即 **3 × 兑换码数量 条串行 D1 查询**，每次打开页面都要重跑一遍。按 1,000 个兑换码算就是 3,000 次往返
（还会撞 Workers 的 subrequest 上限），这就是「打开要十几秒」的唯一原因 —— 与数据量、索引都无关。

现在固定 5 条查询：`count(*)` + 当前页 30 行的 `SELECT` + entitlements/plans/products 各一条批量查询。
搜索（兑换码片段 / 客户邮箱）也下推到 SQL，邮箱用 `IN (SELECT id FROM entitlements WHERE …)`
子查询，只占 1 个绑定参数，不会撞 D1 的 100 参数上限。

试用页的问题不同：它没有 N+1，但每次 `SELECT * FROM trial_grants`（约 2,100 行、每天还在涨）
再在 JS 里切片，而且 `created_at` 上没有索引 —— 每次打开都是「全表 + 临时排序」。现已改为
`ORDER BY created_at DESC LIMIT 80 OFFSET n`（走新加的 `trial_grants_created_idx`）。

### 9.3 验证结果

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | 干净 |
| `npx vitest run` | **19 文件 / 247 用例全绿**（原 243 + 新增 4） |
| migration 0017 幂等性 | 在临时库上连跑两次，第二次无变化；索引清单符合预期 |
| lifetime 新查询计划 | `SEARCH telemetry_session_state USING INDEX telemetry_session_state_install_idx (install_id=?)`，25 台 = 25 行 |
| 试用资格查询计划 | `SEARCH trial_grants USING INDEX trial_grants_fingerprint_status_idx (fingerprint_hash=? AND status=?)`，2 行 |
| 原始事件完整 hash 计划 | `SEARCH … USING INDEX telemetry_events_machine_idx (machine_hash=? AND received_at>?)`；UUID 走 `install_idx` |
| 新增安装收窄后的计划 | 规划器仍选更优的 `product_event_idx`（实测 40 台设备：123 行 → 104 行），**没有**退化成 install_idx 全历史扫描 |
| 新增用例 | lifetime 与四个既有消费方同值（2700 s）；用户详情分页/窗口/摘要；原始事件完整 id 与片段匹配；兑换码/日志/试用分页与关联补齐 |

### 9.4 上线顺序与回滚

1. 先 `npx wrangler d1 migrations apply animate-licence-db --remote`（0017 只 `CREATE INDEX`，
   不读不写任何数据行；四张表都在万行以内，建索引是秒级）。
2. 再 `npm run deploy`。
3. 冒烟：`/admin/licenses`、`/admin/trials`、`/admin/logs`、`/admin/telemetry/activity/<某天>`、
   `/admin/telemetry/user/<hash>`（含「全历史」选项）各开一次。
4. 24h 后回 Query Insights 看 Q1（lifetime）与 Q7（trial_grants）的行数/耗时是否掉下来。
5. 回滚：读路径 `git revert`；索引可留可删（`DROP INDEX` 四条见 migration 内注释），
   **任何一步都不会丢数据**。

### 9.5 需要知情的口径变化 / 仍未做

- **活跃设备-某日「历史累计时长」** 改读入库累计值，比原来的原始事件回放低约 **0.6%**
  （单台最多 −4.85%；原因是入库 CAS 丢更新 + 乱序回写，见 §1.1）。这是你已确认的方案 A。
- **用户详情页**默认只看近 30 天（原来是无窗口全历史），页面已加「全历史」选项；
  摘要里的「累计活跃时长」也随之标注为「近 N 天」。
- **P1（用户总览 / 机器用量聚合下推）与 P2（`telemetry_install_daily` 日聚合表）本轮没做** ——
  P1 只降传输/耗时、不降 `rows_read`，P2 才是读额度的彻底解法，建议观察一周后再定。
