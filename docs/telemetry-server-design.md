# AniMate Telemetry 服务端设计

> 状态：draft
>
> 依据：`E:\workspace\AniMate\docs\engineering\telemetry-design.md`
>
> 范围：在现有授权平台中新增轻量统计接收接口、独立 telemetry 数据表、后台查看页与统计报表页。

## 1. 背景与目标

AniMate 客户端已按轻量统计方案准备向授权服务器上报产品生命周期事件。授权平台需要新增 `POST /v1/telemetry`，接收安装、启动、心跳等低频匿名统计数据，并在管理后台提供事件查看和基础报表。

本设计遵循几个原则：

- Telemetry 与授权核心链路隔离。统计失败不能影响激活、刷新、解绑、支付 webhook。
- Telemetry 表使用 `telemetry_` 前缀，不对 `licenses`、`entitlements`、`activations`、`subscriptions` 建外键。
- 只保存客户端设计文档允许的匿名生命周期字段，不保存原始机器码、授权码、订单号、 licence token、用户文件路径或内容。
- 第一版优先简单可靠：校验、去重、append-only 存储、后台基础查询。聚合表和报表缓存可同步写入，也可后续由任务补算。

## 2. 客户端上报契约

### 2.1 Endpoint

```http
POST /v1/telemetry
Content-Type: application/json
X-AniMate-Telemetry-Token: <public telemetry token>
```

成功响应：

```json
{ "ok": true }
```

客户端只把任意 2xx 当成功，不能依赖响应体改变产品行为。

### 2.2 当前客户端 token

客户端当前实现：

| 环境 | Token |
| --- | --- |
| production desktop | `animate-desktop-prod-v1` |
| dev fallback | `animate-desktop-dev` |

服务端新增环境变量：

```text
TELEMETRY_TOKENS=animate-desktop-prod-v1:desktop_prod,animate-desktop-dev:desktop_dev
```

格式为逗号分隔的 `token:source_id`。`source_id` 写入数据库，用于区分生产、开发、官网、staging 等来源。Token 是公开过滤令牌，不当作安全秘密。

### 2.3 Envelope

服务端接受以下 JSON：

```json
{
  "schema_version": 1,
  "event_id": "uuid",
  "event": "session_heartbeat",
  "sent_at": 1781680900,
  "product_id": "animate",
  "app_version": "0.4.2",
  "platform": "windows",
  "channel": "official",
  "machine_hash": "hex_sha256",
  "install_id": "uuid",
  "session_id": "uuid",
  "license_state": "free",
  "activation_id": null,
  "payload": {}
}
```

### 2.4 事件白名单

第一版白名单：

| event | 来源 | 必填字段 | payload |
| --- | --- | --- | --- |
| `install_seen` | 桌面端 | `event_id`、`sent_at`、`product_id`、`app_version`、`platform`、`install_id` | `first_seen` |
| `session_start` | 桌面端 | `event_id`、`sent_at`、`product_id`、`app_version`、`platform`、`install_id`、`session_id` | `started_at` |
| `session_heartbeat` | 桌面端 | `event_id`、`sent_at`、`product_id`、`app_version`、`platform`、`install_id`、`session_id` | `seq`、`process_duration_secs`、`overlay_visible_secs` |
| `session_end` | 桌面端，后续 | 同 `session_heartbeat` | `process_duration_secs`、`overlay_visible_secs`、`reason` |
| `download_click` | 官网/下载页 | `event_id`、`sent_at`、`product_id` | `download_platform`、`download_version`、`source` |

`machine_hash` 允许为空，因为客户端可能无法取得稳定机器材料。报表中的机器维度只统计有 `machine_hash` 的事件；安装维度使用 `install_id`。

## 3. 校验与写入流程

请求处理步骤：

1. 仅接受 `POST` 和 `application/json`。
2. 限制 body 最大 8 KB。超过返回 `413 PAYLOAD_TOO_LARGE`。
3. 读取 `X-AniMate-Telemetry-Token`，不在 `TELEMETRY_TOKENS` 中返回 `401 INVALID_TELEMETRY_TOKEN`。
4. 解析 JSON，失败返回 `400 INVALID_JSON`。
5. 校验 `schema_version === 1`。
6. 校验 `event` 在白名单。
7. 按事件类型校验必填字段和 payload 数字范围。
8. `event_id` 已存在时直接返回 `{ "ok": true, "duplicate": true }`，不重复计数。
9. 写入 `telemetry_events`。
10. 尝试更新日聚合表。聚合更新失败只记录日志，不让客户端感知失败。

字段限制建议：

| 字段 | 限制 |
| --- | --- |
| `event_id`、`install_id`、`session_id` | UUID 字符串，最长 64 |
| `product_id` | `^[a-z0-9_-]{1,64}$` |
| `app_version` | 最长 64 |
| `platform` | `windows`、`macos`、`linux`、`unknown`、`win32`、`darwin` 等先归一到标准值 |
| `channel` | 最长 64，默认 `official` |
| `machine_hash` | 64 位 hex sha256 |
| `license_state` | `free`、`active`、`expired`、`invalid`、`machine_mismatch`、`unknown` |
| payload 时长 | 非负整数，单事件最大 7 天秒数，异常值写原始事件但不进入聚合 |

## 4. 数据库设计

### 4.1 原始事件表

```sql
CREATE TABLE telemetry_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  event TEXT NOT NULL,
  source_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  received_at_unix INTEGER NOT NULL,
  sent_at INTEGER,
  product_id TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  channel TEXT,
  machine_hash TEXT,
  install_id TEXT,
  session_id TEXT,
  license_state TEXT,
  activation_id TEXT,
  payload_json TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX telemetry_events_received_idx ON telemetry_events(received_at);
CREATE INDEX telemetry_events_product_event_idx ON telemetry_events(product_id, event, received_at);
CREATE INDEX telemetry_events_machine_idx ON telemetry_events(machine_hash, received_at);
CREATE INDEX telemetry_events_install_idx ON telemetry_events(install_id, received_at);
CREATE INDEX telemetry_events_session_idx ON telemetry_events(session_id, received_at);
```

说明：

- `source_id` 来自 token 映射，例如 `desktop_prod`、`desktop_dev`、`official_site`。
- `received_at` 使用 SQLite datetime 文本，保持与现有授权表风格一致。
- `received_at_unix` 方便按 Unix 秒做时长和分桶计算。
- `activation_id` 是未来服务端签发的匿名激活 ID，不关联授权表，不保存授权码。
- `payload_json` 只保存 payload；`raw_json` 保存清洗后的完整 envelope，方便排查 schema 问题。

### 4.2 会话状态表

用于计算 heartbeat 增量，避免每次聚合都扫描历史事件。

```sql
CREATE TABLE telemetry_session_state (
  session_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  machine_hash TEXT,
  install_id TEXT,
  app_version TEXT,
  platform TEXT,
  channel TEXT,
  license_state TEXT,
  source_id TEXT NOT NULL,
  started_at INTEGER,
  last_event_at INTEGER NOT NULL,
  last_process_duration_secs INTEGER NOT NULL DEFAULT 0,
  last_overlay_visible_secs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX telemetry_session_state_machine_idx ON telemetry_session_state(machine_hash, updated_at);
```

`session_heartbeat` 和 `session_end` 到达时：

- 读取同一 `session_id` 的上一条 duration。
- `active_delta = max(0, process_duration_secs - last_process_duration_secs)`。
- `overlay_delta = max(0, overlay_visible_secs - last_overlay_visible_secs)`。
- 如果 duration 倒退或异常过大，则原始事件照存，聚合 delta 置 0。

### 4.3 日聚合表

第一版报表直接使用该表，避免后台页面扫描全部原始事件。

```sql
CREATE TABLE telemetry_daily_metrics (
  day TEXT NOT NULL,
  product_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  channel TEXT NOT NULL DEFAULT 'official',
  app_version TEXT NOT NULL DEFAULT 'unknown',
  license_state TEXT NOT NULL DEFAULT 'unknown',
  downloads INTEGER NOT NULL DEFAULT 0,
  installs INTEGER NOT NULL DEFAULT 0,
  launches INTEGER NOT NULL DEFAULT 0,
  active_secs INTEGER NOT NULL DEFAULT 0,
  overlay_visible_secs INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (
    day,
    product_id,
    source_id,
    platform,
    channel,
    app_version,
    license_state
  )
);
```

### 4.4 去重维度表

SQLite 不支持在聚合表中直接做 distinct machine/install 的增量计数，所以单独记录每日出现过的匿名 ID。

```sql
CREATE TABLE telemetry_daily_uniques (
  day TEXT NOT NULL,
  product_id TEXT NOT NULL,
  unique_type TEXT NOT NULL,
  unique_value TEXT NOT NULL,
  source_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  channel TEXT NOT NULL DEFAULT 'official',
  app_version TEXT NOT NULL DEFAULT 'unknown',
  license_state TEXT NOT NULL DEFAULT 'unknown',
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, product_id, unique_type, unique_value)
);

CREATE INDEX telemetry_daily_uniques_report_idx
  ON telemetry_daily_uniques(day, product_id, unique_type, source_id, platform, channel, app_version, license_state);
```

`unique_type` 取值：

- `machine_active`：当天出现过 `session_start`、`session_heartbeat`、`session_end` 的 `machine_hash`。
- `install_seen`：当天首次上报 `install_seen` 的 `install_id`。
- `session_seen`：当天出现过的 `session_id`，可用于校验启动数。

## 5. 聚合规则

事件写入后按 `received_at_unix` 所在 UTC 日期聚合。后台可以后续支持本地时区展示，但存储统一 UTC。

| 指标 | 聚合方式 |
| --- | --- |
| 下载数 | `download_click` 事件数加到 `downloads` |
| 首次安装数 | `install_seen` 首次插入 `telemetry_daily_uniques(unique_type='install_seen')` 后计数 |
| 活跃机器数 | `machine_hash` 首次插入 `machine_active` 后计数 |
| 启动次数 | `session_start` 事件数加到 `launches` |
| 事件数 | 所有合法事件加到 `events` |
| 使用时长 | heartbeat/end 的 `process_duration_secs` 增量加到 `active_secs` |
| Overlay 可见时长 | heartbeat/end 的 `overlay_visible_secs` 增量加到 `overlay_visible_secs` |

报表查询活跃机器、安装数时从 `telemetry_daily_uniques` 统计 distinct 行；下载、启动和时长从 `telemetry_daily_metrics` 汇总。

## 6. 后端模块设计

新增文件建议：

```text
src/routes/telemetry.ts
src/services/telemetry.ts
src/services/telemetry_reports.ts
```

`src/index.ts`：

- `Env` 新增 `TELEMETRY_TOKENS?: string`。
- `app.route("/v1", createV1Router(...))` 现有路由中加入 `/telemetry`，或单独 `app.route("/v1/telemetry", createTelemetryRouter(...))`。
- CORS 继续允许 `X-AniMate-Telemetry-Token`。现有 `Access-Control-Allow-Headers` 需要加该 header。

`src/services/telemetry.ts` 职责：

- 解析 token 映射。
- 校验 envelope 和 payload。
- 规范化 platform、channel、license_state。
- 插入原始事件并处理 event_id 幂等。
- 更新 session state 和 daily metrics。

`src/services/telemetry_reports.ts` 职责：

- 查询概览指标。
- 查询趋势图数据。
- 查询平台、版本、授权状态分布。
- 查询原始事件列表。

## 7. 限流与异常过滤

第一版可以复用现有内存限流风格，新增 telemetry 专用 limiter：

| 维度 | 建议默认值 |
| --- | --- |
| IP | 120 requests / minute |
| token/source_id | 5000 requests / minute |
| machine_hash | 10 requests / minute |
| install_id | 10 requests / minute |

异常数据策略：

- token 无效、schema 错误、事件名非法：拒绝写入。
- 单个时长超过 7 天、duration 倒退、payload 类型错误：原始事件写入，聚合时忽略异常时长。
- 缺少 `machine_hash`：允许写入，但不计入活跃机器，只计入事件、启动或安装。
- 重复 `event_id`：返回成功，不更新聚合。

## 8. 管理后台设计

导航新增两个入口：

- `统计事件`：`/admin/telemetry/events`
- `统计报表`：`/admin/telemetry/reports`

也可以先在侧边栏显示一个一级入口 `统计`，下方页面用 tab 切换 `报表` 和 `事件`。

### 8.1 统计报表页

路径：`GET /admin/telemetry/reports`

筛选项：

- 日期范围：默认最近 14 天。
- 产品：默认 `animate`。
- source：`desktop_prod`、`desktop_dev`、`official_site`。
- 平台：全部 / windows / macos / unknown。
- 授权状态：全部 / free / active / expired / invalid。

核心卡片：

- 下载数。
- 首次安装数。
- 活跃机器数。
- 启动次数。
- 总运行时长。
- 总 overlay 可见时长。
- 平均每活跃机器运行时长。

表格：

- 每日趋势：日期、下载、安装、活跃机器、启动、运行时长、overlay 时长。
- 版本分布：版本、活跃机器、启动、运行时长。
- 授权状态分布：状态、活跃机器、启动。
- 平台分布：平台、活跃机器、安装、下载。

第一版可以用 HTML 表格展示，后续再增加轻量 SVG/Canvas 折线图。

### 8.2 统计事件页

路径：`GET /admin/telemetry/events`

筛选项：

- event 类型。
- machine_hash 后 8 位或完整 hash。
- install_id。
- session_id。
- app_version。
- platform。
- license_state。
- 日期范围。

列表字段：

- 接收时间。
- 事件类型。
- 产品。
- 版本。
- 平台。
- 来源。
- 授权状态。
- machine_hash 短码。
- install_id 短码。
- session_id 短码。
- payload 摘要。

详情可以先不做独立页面，第一版在表格中展示 payload 摘要。需要排查时再新增 `/admin/telemetry/events/:event_id`。

## 9. Admin API

后台页面优先服务端渲染，不强依赖 JSON API。可预留：

```http
GET /admin/api/telemetry/reports/summary
GET /admin/api/telemetry/reports/daily
GET /admin/api/telemetry/events
```

所有 admin API 继续使用现有后台 session 鉴权。

## 10. 隐私与保留策略

第一版不存任何原始机器码、授权码、订单号或 licence token。`machine_hash` 已由客户端用固定 salt + sha256 派生，但仍按匿名设备标识处理，后台只显示短码，完整值仅用于精确排查。

建议保留策略：

- `telemetry_events` 原始事件保留 180 天。
- `telemetry_session_state` 保留 30 天未更新记录。
- `telemetry_daily_metrics` 和 `telemetry_daily_uniques` 长期保留，至少 2 年。

Cloudflare D1 没有内建 TTL。后续可通过定时任务或手工维护接口清理。

## 11. 上线步骤

1. 新增 migration：`0004_telemetry.sql`，创建 `telemetry_` 前缀表和索引。
2. 更新 Drizzle schema，新增 telemetry 表定义。
3. 新增 `TELEMETRY_TOKENS` 配置和 CORS header。
4. 实现 `POST /v1/telemetry`：token、schema、事件白名单、payload 校验、去重、写入。
5. 实现 session state 和 daily metrics 聚合。
6. 增加后台 `统计事件` 页面。
7. 增加后台 `统计报表` 页面。
8. 增加单元测试：合法事件、无效 token、重复 event_id、heartbeat 增量、缺失 machine_hash、download_click。
9. 本地应用 migration，部署到生产前先用 `animate-desktop-dev` 验证。
10. 客户端生产构建使用 `animate-desktop-prod-v1` 上报。

## 12. 待确认问题

- 正式生产 token 是否沿用客户端当前硬编码的 `animate-desktop-prod-v1`，还是在客户端发版前改名为更明确的 `animate-desktop-prod-v1-public`。
- 官网下载页是否也复用 `/v1/telemetry`，如果复用，需要新增 `official_site` token。
- 第一版是否需要展示完整 `machine_hash` 搜索，还是只允许复制短码后由管理员输入完整值排查。
- 原始事件保留期是 180 天还是更短。
